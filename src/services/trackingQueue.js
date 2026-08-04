import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../prisma.js';
import { emitUserMetrics } from '../realtime.js';
import { getUserOverview, getUserTimeMap } from './analytics.js';
import { clearCachePrefix } from './responseCache.js';

const FLUSH_INTERVAL_MS = Number(process.env.TRACKING_QUEUE_FLUSH_MS || 3000);
const MAX_BATCHES_PER_FLUSH = Number(process.env.TRACKING_QUEUE_BATCH_SIZE || 1000);
const MAX_QUEUE_SIZE = Number(process.env.TRACKING_QUEUE_MAX_SIZE || 50000);
const REALTIME_RECOMPUTE_MS = Number(process.env.TRACKING_REALTIME_RECOMPUTE_MS || 10000);

const queue = [];
const realtimeEmitState = new Map();
let flushing = false;
let flushTimer = null;

function toDateKey(date) {
  return date.toISOString();
}

function shouldRecomputeRealtime(userId) {
  const last = realtimeEmitState.get(userId) || 0;
  const current = Date.now();
  if (current - last < REALTIME_RECOMPUTE_MS) return false;
  realtimeEmitState.set(userId, current);
  return true;
}

function buildSummaryMap(items) {
  const summaries = new Map();

  for (const item of items) {
    const activeWatchSeconds = item.heatmapEntries.reduce((total, entry) => total + entry.count, 0);
    const pauseCount = item.events.filter((event) => event.eventType === 'PAUSE').length;
    const seekCount = item.events.filter((event) => event.eventType === 'SEEK').length;
    if (!activeWatchSeconds && !pauseCount && !seekCount) continue;

    const key = `${item.userId}:${item.videoId}:${toDateKey(item.day)}`;
    const current = summaries.get(key) || {
      userId: item.userId,
      videoId: item.videoId,
      date: item.day,
      activeWatchSeconds: 0,
      pauseCount: 0,
      seekCount: 0,
    };
    current.activeWatchSeconds += activeWatchSeconds;
    current.pauseCount += pauseCount;
    current.seekCount += seekCount;
    summaries.set(key, current);
  }

  return [...summaries.values()];
}

function buildHeatmapMap(items) {
  const ticks = new Map();

  for (const item of items) {
    for (const entry of item.heatmapEntries) {
      const key = `${item.userId}:${item.videoId}:${entry.second}`;
      const current = ticks.get(key) || {
        userId: item.userId,
        videoId: item.videoId,
        second: entry.second,
        count: 0,
      };
      current.count += entry.count;
      ticks.set(key, current);
    }
  }

  return [...ticks.values()];
}

async function insertEvents(items) {
  const events = items.flatMap((item) => item.events.map((event) => ({
    userId: item.userId,
    videoId: item.videoId,
    sessionId: item.sessionId,
    eventType: event.eventType,
    videoTimeSec: event.videoTimeSec,
    fromTimeSec: event.fromTimeSec,
    toTimeSec: event.toTimeSec,
    clientTs: event.clientTs,
    metadata: event.metadata,
  })));

  if (!events.length) return 0;

  const chunkSize = 1000;
  for (let index = 0; index < events.length; index += chunkSize) {
    await prisma.watchEvent.createMany({
      data: events.slice(index, index + chunkSize),
    });
  }

  return events.length;
}

async function upsertHeatmap(items) {
  const heatmapEntries = buildHeatmapMap(items);
  if (!heatmapEntries.length) return 0;

  const chunkSize = 500;
  for (let index = 0; index < heatmapEntries.length; index += chunkSize) {
    const chunk = heatmapEntries.slice(index, index + chunkSize);
    const values = Prisma.join(chunk.map((entry) => Prisma.sql`(${randomUUID()}, ${entry.userId}, ${entry.videoId}, ${entry.second}, ${entry.count}, NOW())`));
    await prisma.$executeRaw`
      INSERT INTO "VideoSecondHeatmap" ("id", "userId", "videoId", "second", "watchCount", "updatedAt")
      VALUES ${values}
      ON CONFLICT ("userId", "videoId", "second")
      DO UPDATE SET
        "watchCount" = "VideoSecondHeatmap"."watchCount" + EXCLUDED."watchCount",
        "updatedAt" = NOW()
    `;
  }

  return heatmapEntries.length;
}

async function upsertSummaries(items) {
  const summaries = buildSummaryMap(items);
  if (!summaries.length) return 0;

  const chunkSize = 500;
  for (let index = 0; index < summaries.length; index += chunkSize) {
    const chunk = summaries.slice(index, index + chunkSize);
    const values = Prisma.join(chunk.map((row) => Prisma.sql`(${randomUUID()}, ${row.userId}, ${row.videoId}, ${row.date}, ${row.activeWatchSeconds}, ${row.pauseCount}, ${row.seekCount}, NOW())`));
    await prisma.$executeRaw`
      INSERT INTO "DailyWatchSummary" ("id", "userId", "videoId", "date", "activeWatchSeconds", "pauseCount", "seekCount", "updatedAt")
      VALUES ${values}
      ON CONFLICT ("userId", "videoId", "date")
      DO UPDATE SET
        "activeWatchSeconds" = "DailyWatchSummary"."activeWatchSeconds" + EXCLUDED."activeWatchSeconds",
        "pauseCount" = "DailyWatchSummary"."pauseCount" + EXCLUDED."pauseCount",
        "seekCount" = "DailyWatchSummary"."seekCount" + EXCLUDED."seekCount",
        "updatedAt" = NOW()
    `;
  }

  return summaries.length;
}

function clearUserCaches(userIds) {
  for (const userId of userIds) {
    clearCachePrefix(`overview:${userId}`);
    clearCachePrefix(`time-map:${userId}`);
  }
  clearCachePrefix('leaderboard');
}

function emitRealtimeForUsers(userIds) {
  for (const userId of userIds) {
    if (!shouldRecomputeRealtime(userId)) continue;
    Promise.all([
      getUserOverview(userId),
      getUserTimeMap(userId),
    ])
      .then(([overview, timeMap]) => emitUserMetrics(userId, { overview, timeMap }))
      .catch((error) => console.error('Failed to emit queued realtime metrics', error));
  }
}

export function enqueueTrackingBatch(item) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    const error = new Error('Tracking queue is full');
    error.status = 503;
    throw error;
  }

  queue.push(item);
  return {
    queued: true,
    queueDepth: queue.length,
  };
}

export async function flushTrackingQueue() {
  if (flushing || !queue.length) return;
  flushing = true;
  const startedAt = Date.now();
  const items = queue.splice(0, MAX_BATCHES_PER_FLUSH);
  const userIds = [...new Set(items.map((item) => item.userId))];

  try {
    const [eventRows, heatmapRows, summaryRows] = await Promise.all([
      insertEvents(items),
      upsertHeatmap(items),
      upsertSummaries(items),
    ]);

    clearUserCaches(userIds);
    emitRealtimeForUsers(userIds);

    console.log(JSON.stringify({
      project: 'HexTorq Learn Backend',
      task: 'flushTrackingQueue',
      batches: items.length,
      eventRows,
      heatmapRows,
      summaryRows,
      queueDepth: queue.length,
      durationMs: Date.now() - startedAt,
    }));
  } catch (error) {
    queue.unshift(...items);
    console.error('Failed to flush tracking queue', error);
  } finally {
    flushing = false;
  }
}

export function startTrackingQueue() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushTrackingQueue().catch((error) => console.error('Tracking queue flush crashed', error));
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

export async function stopTrackingQueue() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushTrackingQueue();
}
