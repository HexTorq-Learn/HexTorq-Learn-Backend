import express from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';

export const trackingRouter = express.Router();

const sessionSchema = z.object({
  videoId: z.string().optional(),
});

const eventSchema = z.object({
  eventType: z.enum([
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
  ]),
  videoTimeSec: z.number().optional(),
  fromTimeSec: z.number().optional(),
  toTimeSec: z.number().optional(),
  clientTs: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ingestSchema = z.object({
  videoId: z.string(),
  sessionId: z.string().optional(),
  events: z.array(eventSchema).default([]),
  heatmapTicks: z.record(z.string(), z.number().int().positive()).default({}),
});

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
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
    const heatmapEntries = Object.entries(body.heatmapTicks)
      .map(([second, count]) => ({ second: Number(second), count }))
      .filter((entry) => Number.isInteger(entry.second) && entry.second >= 0 && entry.count > 0);

    const activeWatchSeconds = heatmapEntries.reduce((total, entry) => total + entry.count, 0);
    const pauseCount = body.events.filter((event) => event.eventType === 'PAUSE').length;
    const seekCount = body.events.filter((event) => event.eventType === 'SEEK').length;

    await prisma.$transaction(async (tx) => {
      if (body.events.length > 0) {
        await tx.watchEvent.createMany({
          data: body.events.map((event) => ({
            userId: req.user.id,
            videoId: body.videoId,
            sessionId: body.sessionId,
            eventType: event.eventType,
            videoTimeSec: event.videoTimeSec,
            fromTimeSec: event.fromTimeSec,
            toTimeSec: event.toTimeSec,
            clientTs: new Date(event.clientTs),
            metadata: event.metadata,
          })),
        });
      }

      for (const entry of heatmapEntries) {
        await tx.videoSecondHeatmap.upsert({
          where: {
            userId_videoId_second: {
              userId: req.user.id,
              videoId: body.videoId,
              second: entry.second,
            },
          },
          update: { watchCount: { increment: entry.count } },
          create: {
            userId: req.user.id,
            videoId: body.videoId,
            second: entry.second,
            watchCount: entry.count,
          },
        });
      }

      if (activeWatchSeconds || pauseCount || seekCount) {
        await tx.dailyWatchSummary.upsert({
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
    });

    res.json({
      acceptedEvents: body.events.length,
      acceptedHeatmapTicks: heatmapEntries.length,
      activeWatchSeconds,
    });
  } catch (error) {
    next(error);
  }
});
