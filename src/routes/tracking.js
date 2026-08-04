import express from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { startOfUtcDay } from '../services/analytics.js';
import { enqueueTrackingBatch } from '../services/trackingQueue.js';

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

    const queued = enqueueTrackingBatch({
      userId: req.user.id,
      videoId: body.videoId,
      sessionId: body.sessionId,
      day,
      events,
      heatmapEntries,
    });

    const result = {
      acceptedEvents: events.length,
      acceptedHeatmapTicks: heatmapEntries.length,
      activeWatchSeconds,
      ...queued,
    };

    res.json(result);
  } catch (error) {
    next(error);
  }
});
