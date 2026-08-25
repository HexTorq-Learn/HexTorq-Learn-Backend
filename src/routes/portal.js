import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { enqueuePortalActivity, todayKey } from '../services/portalActivityQueue.js';

export const portalRouter = express.Router();

const portalEventTypes = new Set([
  'LOGIN',
  'HEARTBEAT',
  'IDLE_START',
  'IDLE_END',
  'TAB_HIDDEN',
  'TAB_VISIBLE',
  'LOGOUT',
]);

const optionalString = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  z.string().optional(),
);

const heartbeatSchema = z.object({
  sessionId: optionalString,
  activeSeconds: z.number().finite().min(0).max(3600).default(0),
  idleSeconds: z.number().finite().min(0).max(3600).default(0),
  events: z.array(z.record(z.string(), z.unknown())).default([]),
});

const beaconEndSchema = z.object({
  token: z.string().min(1),
  sessionId: z.string().min(1),
});

function normalizeClientTs(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function normalizeEvents(events) {
  return events
    .filter((event) => portalEventTypes.has(event.eventType))
    .map((event) => ({
      eventType: event.eventType,
      clientTs: normalizeClientTs(event.clientTs),
      metadata: event.metadata && typeof event.metadata === 'object' ? event.metadata : undefined,
    }));
}

portalRouter.post('/sessions', requireAuth, async (req, res, next) => {
  try {
    const session = await prisma.$transaction(async (tx) => {
      const created = await tx.portalSession.create({
        data: {
          userId: req.user.id,
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip,
        },
      });

      const today = todayKey();
      await tx.$executeRaw`
        INSERT INTO "DailyPortalSummary" ("id", "userId", "date", "loginCount", "updatedAt")
        VALUES (gen_random_uuid()::text, ${req.user.id}, ${today}, 1, NOW())
        ON CONFLICT ("userId", "date")
        DO UPDATE SET "loginCount" = "DailyPortalSummary"."loginCount" + 1, "updatedAt" = NOW()
      `;

      return created;
    });

    enqueuePortalActivity({
      userId: req.user.id,
      sessionId: session.id,
      day: todayKey(),
      activeSeconds: 0,
      idleSeconds: 0,
      loginCount: 0,
      events: [{ eventType: 'LOGIN', clientTs: new Date(), metadata: undefined }],
    });

    res.status(201).json({ session });
  } catch (error) {
    next(error);
  }
});

portalRouter.patch('/sessions/:id/end', requireAuth, async (req, res, next) => {
  try {
    const updated = await prisma.portalSession.updateMany({
      where: { id: req.params.id, userId: req.user.id, logoutAt: null },
      data: { logoutAt: new Date() },
    });

    res.json({ updated: updated.count });
  } catch (error) {
    next(error);
  }
});

portalRouter.post('/heartbeat', requireAuth, async (req, res, next) => {
  try {
    const body = heartbeatSchema.parse(req.body);
    const events = normalizeEvents(body.events);

    const queued = enqueuePortalActivity({
      userId: req.user.id,
      sessionId: body.sessionId,
      day: todayKey(),
      activeSeconds: Math.round(body.activeSeconds),
      idleSeconds: Math.round(body.idleSeconds),
      loginCount: 0,
      events,
    });

    res.json({ acceptedEvents: events.length, ...queued });
  } catch (error) {
    next(error);
  }
});

// navigator.sendBeacon cannot set custom headers, so tab-close/unload uses a
// dedicated endpoint that verifies the JWT from the request body instead of
// the usual Authorization header (requireAuth middleware is not used here).
portalRouter.post('/beacon-end', async (req, res, next) => {
  try {
    const body = beaconEndSchema.parse(
      typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body,
    );
    const payload = jwt.verify(body.token, process.env.JWT_SECRET);

    await prisma.portalSession.updateMany({
      where: { id: body.sessionId, userId: payload.sub, logoutAt: null },
      data: { logoutAt: new Date() },
    });

    res.json({ ended: true });
  } catch (error) {
    next(error);
  }
});
