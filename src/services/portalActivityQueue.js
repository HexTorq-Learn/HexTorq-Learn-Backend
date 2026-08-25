import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../prisma.js';
import { startOfUtcDay } from './analytics.js';
import { clearCachePrefix } from './responseCache.js';

// Mirrors trackingQueue.js's in-process batching pattern, applied to app-wide
// portal activity (login/idle/logout) instead of video watch events.
const FLUSH_INTERVAL_MS = Number(process.env.PORTAL_QUEUE_FLUSH_MS || 3000);
const MAX_BATCHES_PER_FLUSH = Number(process.env.PORTAL_QUEUE_BATCH_SIZE || 1000);
const MAX_QUEUE_SIZE = Number(process.env.PORTAL_QUEUE_MAX_SIZE || 50000);

// A session with no heartbeat for this long is considered ended -- the browser
// tab was closed, the laptop slept, or the app crashed without a clean logout.
const STALE_SESSION_TIMEOUT_MS = Number(process.env.PORTAL_SESSION_TIMEOUT_MS || 90 * 1000);
const REAP_INTERVAL_MS = Number(process.env.PORTAL_REAP_INTERVAL_MS || 60 * 1000);

const queue = [];
let flushing = false;
let flushTimer = null;
let reapTimer = null;

function buildSummaryMap(items) {
  const summaries = new Map();

  for (const item of items) {
    if (!item.activeSeconds && !item.idleSeconds && !item.loginCount) continue;
    const key = `${item.userId}:${item.day.toISOString()}`;
    const current = summaries.get(key) || {
      userId: item.userId,
      date: item.day,
      activeSeconds: 0,
      idleSeconds: 0,
      loginCount: 0,
    };
    current.activeSeconds += item.activeSeconds || 0;
    current.idleSeconds += item.idleSeconds || 0;
    current.loginCount += item.loginCount || 0;
    summaries.set(key, current);
  }

  return [...summaries.values()];
}

async function insertEvents(items) {
  const events = items.flatMap((item) => item.events.map((event) => ({
    userId: item.userId,
    sessionId: item.sessionId,
    eventType: event.eventType,
    clientTs: event.clientTs,
    metadata: event.metadata,
  })));

  if (!events.length) return 0;

  const chunkSize = 1000;
  for (let index = 0; index < events.length; index += chunkSize) {
    await prisma.portalActivityEvent.createMany({
      data: events.slice(index, index + chunkSize),
    });
  }

  return events.length;
}

async function upsertSummaries(items) {
  const summaries = buildSummaryMap(items);
  if (!summaries.length) return 0;

  const chunkSize = 500;
  for (let index = 0; index < summaries.length; index += chunkSize) {
    const chunk = summaries.slice(index, index + chunkSize);
    const values = Prisma.join(chunk.map((row) => Prisma.sql`(${randomUUID()}, ${row.userId}, ${row.date}, ${row.activeSeconds}, ${row.idleSeconds}, ${row.loginCount}, NOW())`));
    await prisma.$executeRaw`
      INSERT INTO "DailyPortalSummary" ("id", "userId", "date", "activeSeconds", "idleSeconds", "loginCount", "updatedAt")
      VALUES ${values}
      ON CONFLICT ("userId", "date")
      DO UPDATE SET
        "activeSeconds" = "DailyPortalSummary"."activeSeconds" + EXCLUDED."activeSeconds",
        "idleSeconds" = "DailyPortalSummary"."idleSeconds" + EXCLUDED."idleSeconds",
        "loginCount" = "DailyPortalSummary"."loginCount" + EXCLUDED."loginCount",
        "updatedAt" = NOW()
    `;
  }

  return summaries.length;
}

async function touchSessions(items) {
  const sessionIds = [...new Set(items.map((item) => item.sessionId).filter(Boolean))];
  if (!sessionIds.length) return;
  await prisma.portalSession.updateMany({
    where: { id: { in: sessionIds }, logoutAt: null },
    data: { lastSeenAt: new Date() },
  });
}

function clearUserCaches(userIds) {
  for (const userId of userIds) {
    clearCachePrefix(`advanced:${userId}`);
  }
}

export function enqueuePortalActivity(item) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    const error = new Error('Portal activity queue is full');
    error.status = 503;
    throw error;
  }

  queue.push(item);
  return { queued: true, queueDepth: queue.length };
}

export async function flushPortalActivityQueue() {
  if (flushing || !queue.length) return;
  flushing = true;
  const startedAt = Date.now();
  const items = queue.splice(0, MAX_BATCHES_PER_FLUSH);
  const userIds = [...new Set(items.map((item) => item.userId))];

  try {
    const [eventRows, summaryRows] = await Promise.all([
      insertEvents(items),
      upsertSummaries(items),
    ]);
    await touchSessions(items);
    clearUserCaches(userIds);

    console.log(JSON.stringify({
      project: 'HexTorq Learn Backend',
      task: 'flushPortalActivityQueue',
      batches: items.length,
      eventRows,
      summaryRows,
      queueDepth: queue.length,
      durationMs: Date.now() - startedAt,
    }));
  } catch (error) {
    queue.unshift(...items);
    console.error('Failed to flush portal activity queue', error);
  } finally {
    flushing = false;
  }
}

// Closes any session whose last heartbeat is older than the timeout -- the
// browser tab closed, laptop slept, or the app crashed without a clean logout.
export async function reapStalePortalSessions() {
  const cutoff = new Date(Date.now() - STALE_SESSION_TIMEOUT_MS);
  try {
    const stale = await prisma.portalSession.findMany({
      where: { logoutAt: null, lastSeenAt: { lt: cutoff } },
      select: { id: true, lastSeenAt: true },
      take: 500,
    });
    if (!stale.length) return;

    await Promise.all(stale.map((session) => (
      prisma.portalSession.update({
        where: { id: session.id },
        data: { logoutAt: session.lastSeenAt },
      })
    )));
  } catch (error) {
    console.error('Failed to reap stale portal sessions', error);
  }
}

export function startPortalActivityQueue() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushPortalActivityQueue().catch((error) => console.error('Portal activity queue flush crashed', error));
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();

  if (reapTimer) return;
  reapTimer = setInterval(() => {
    reapStalePortalSessions().catch((error) => console.error('Portal session reap crashed', error));
  }, REAP_INTERVAL_MS);
  reapTimer.unref?.();
}

export async function stopPortalActivityQueue() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
  await flushPortalActivityQueue();
}

export function todayKey() {
  return startOfUtcDay();
}
