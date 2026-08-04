import express from 'express';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { emitUserMetrics } from '../realtime.js';
import { getUserOverview, getUserTimeMap, startOfUtcDay } from '../services/analytics.js';
import { clearCachePrefix } from '../services/responseCache.js';

export const trackingRouter = express.Router();

const sessionSchema = z.object({
  videoId: z.string().optional(),
});

const optionalNumber = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  z.number().finite().optional(),
);

const optionalString = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  z.string().optional(),
);

const watchEventTypes = new Set([
  'PLAY',
  'PAUSE',
  'SEEK',
  'BUFFER',
  'END',
  'TAB_HIDDEN',
  'TAB_VISIBLE',
  'WINDOW_BLUR',
  'WINDOW_FOCUS',
  'IDLE_START',
  'IDLE_END',
  'FLUSH',
]);
const realtimeEmitState = new Map();
const REALTIME_RECOMPUTE_MS = 10000;

const ingestSchema = z.object({
  videoId: z.string().min(1),
  sessionId: optionalString,
  events: z.array(z.record(z.string(), z.unknown())).default([]),
  heatmapTicks: z.record(z.string(), z.unknown()).default({}),
});

function finiteNumberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeClientTs(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function normalizeEvents(events) {
  return events
    .filter((event) => watchEventTypes.has(event.eventType))
    .map((event) => ({
      eventType: event.eventType,
      videoTimeSec: finiteNumberOrUndefined(event.videoTimeSec),
      fromTimeSec: finiteNumberOrUndefined(event.fromTimeSec),
      toTimeSec: finiteNumberOrUndefined(event.toTimeSec),
      clientTs: normalizeClientTs(event.clientTs),
      metadata: event.metadata && typeof event.metadata === 'object' ? event.metadata : undefined,
    }));
}

function normalizeHeatmapTicks(ticks) {
  return Object.entries(ticks)
    .map(([second, count]) => ({
      second: Number(second),
      count: Math.floor(Number(count)),
    }))
    .filter((entry) => Number.isInteger(entry.second) && entry.second >= 0 && entry.count > 0);
}

function shouldRecomputeRealtime(userId) {
  const last = realtimeEmitState.get(userId) || 0;
  const current = Date.now();
  if (current - last < REALTIME_RECOMPUTE_MS) return false;
  realtimeEmitState.set(userId, current);
  return true;
}

async function bulkUpsertHeatmapTicks(userId, videoId, heatmapEntries) {
  if (!heatmapEntries.length) return;

  const chunkSize = 500;
  for (let index = 0; index < heatmapEntries.length; index += chunkSize) {
    const chunk = heatmapEntries.slice(index, index + chunkSize);
    const values = Prisma.join(chunk.map((entry) => Prisma.sql`(${randomUUID()}, ${userId}, ${videoId}, ${entry.second}, ${entry.count}, NOW())`));
    await prisma.$executeRaw`
      INSERT INTO "VideoSecondHeatmap" ("id", "userId", "videoId", "second", "watchCount", "updatedAt")
      VALUES ${values}
      ON CONFLICT ("userId", "videoId", "second")
      DO UPDATE SET
        "watchCount" = "VideoSecondHeatmap"."watchCount" + EXCLUDED."watchCount",
        "updatedAt" = NOW()
    `;
  }
}

trackingRouter.use(requireAuth);

trackingRouter.post('/sessions', async (req, res, next) => {
  try {
    const body = sessionSchema.parse(req.body);
    const session = await prisma.$transaction(async (tx) => {
      const created = await tx.watchSession.create({
        data: {
          userId: req.user.id,
          videoId: body.videoId,
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip,
        },
      });

      if (body.videoId) {
        const today = startOfUtcDay();
        await tx.dailyWatchSummary.upsert({
          where: {
            userId_videoId_date: {
              userId: req.user.id,
              videoId: body.videoId,
              date: today,
            },
          },
          update: { sessionCount: { increment: 1 } },
          create: {
            userId: req.user.id,
            videoId: body.videoId,
            date: today,
            sessionCount: 1,
          },
        });
      }

      return created;
    });

    res.status(201).json({ session });
  } catch (error) {
    next(error);
  }
});

trackingRouter.patch('/sessions/:id/end', async (req, res, next) => {
  try {
    const session = await prisma.watchSession.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data: { logoutAt: new Date() },
    });

    res.json({ updated: session.count });
  } catch (error) {
    next(error);
  }
});

trackingRouter.post('/ingest', async (req, res, next) => {
  try {
    const body = ingestSchema.parse(req.body);
    const day = startOfUtcDay();
    const events = normalizeEvents(body.events);
    const heatmapEntries = normalizeHeatmapTicks(body.heatmapTicks);

    const activeWatchSeconds = heatmapEntries.reduce((total, entry) => total + entry.count, 0);
    const pauseCount = events.filter((event) => event.eventType === 'PAUSE').length;
    const seekCount = events.filter((event) => event.eventType === 'SEEK').length;

    if (events.length > 0) {
      await prisma.watchEvent.createMany({
        data: events.map((event) => ({
          userId: req.user.id,
          videoId: body.videoId,
          sessionId: body.sessionId,
          eventType: event.eventType,
          videoTimeSec: event.videoTimeSec,
          fromTimeSec: event.fromTimeSec,
          toTimeSec: event.toTimeSec,
          clientTs: event.clientTs,
          metadata: event.metadata,
        })),
      });
    }

    await bulkUpsertHeatmapTicks(req.user.id, body.videoId, heatmapEntries);

    if (activeWatchSeconds || pauseCount || seekCount) {
      await prisma.dailyWatchSummary.upsert({
        where: {
          userId_videoId_date: {
            userId: req.user.id,
            videoId: body.videoId,
            date: day,
          },
        },
        update: {
          activeWatchSeconds: { increment: activeWatchSeconds },
          pauseCount: { increment: pauseCount },
          seekCount: { increment: seekCount },
        },
        create: {
          userId: req.user.id,
          videoId: body.videoId,
          date: day,
          activeWatchSeconds,
          pauseCount,
          seekCount,
        },
      });
    }

    const result = {
      acceptedEvents: events.length,
      acceptedHeatmapTicks: heatmapEntries.length,
      activeWatchSeconds,
    };

    clearCachePrefix(`overview:${req.user.id}`);
    clearCachePrefix(`time-map:${req.user.id}`);
    clearCachePrefix(`advanced:${req.user.id}`);
    clearCachePrefix('leaderboard');

    res.json(result);

    if (shouldRecomputeRealtime(req.user.id)) {
      Promise.all([
        getUserOverview(req.user.id),
        getUserTimeMap(req.user.id),
      ])
        .then(([overview, timeMap]) => emitUserMetrics(req.user.id, { overview, timeMap }))
        .catch((error) => console.error('Failed to emit realtime metrics', error));
    }
  } catch (error) {
    next(error);
  }
});
