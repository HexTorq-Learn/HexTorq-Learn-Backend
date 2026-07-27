import bcrypt from 'bcryptjs';
import express from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { getUserTimeMap } from '../services/analytics.js';

export const adminRouter = express.Router();

adminRouter.use(requireAuth, requireAdmin);

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['ADMIN', 'STUDENT']).default('STUDENT'),
});

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  role: z.enum(['ADMIN', 'STUDENT']).optional(),
});

const updateVideoSchema = z.object({
  title: z.string().min(1).optional(),
  durationSec: z.number().int().positive().nullable().optional(),
});

adminRouter.get('/summary', async (_req, res, next) => {
  try {
    const [userCount, videoCount, playlistCount, eventCount, totals] = await Promise.all([
      prisma.user.count(),
      prisma.video.count(),
      prisma.playlist.count(),
      prisma.watchEvent.count(),
      prisma.dailyWatchSummary.aggregate({
        _sum: {
          activeWatchSeconds: true,
          pauseCount: true,
          seekCount: true,
          sessionCount: true,
        },
      }),
    ]);

    res.json({
      userCount,
      videoCount,
      playlistCount,
      eventCount,
      totals: {
        activeWatchSeconds: totals._sum.activeWatchSeconds || 0,
        pauseCount: totals._sum.pauseCount || 0,
        seekCount: totals._sum.seekCount || 0,
        sessionCount: totals._sum.sessionCount || 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/users', async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        summaries: {
          include: { video: { include: { playlist: true } } },
          orderBy: { date: 'desc' },
          take: 30,
        },
        _count: {
          select: { events: true, sessions: true },
        },
      },
    });

    res.json({ users });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/users', async (req, res, next) => {
  try {
    const body = createUserSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email.toLowerCase(),
        passwordHash,
        role: body.role,
      },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });

    res.status(201).json({ user });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'Email already exists' });
    }
    next(error);
  }
});

adminRouter.patch('/users/:id', async (req, res, next) => {
  try {
    const body = updateUserSchema.parse(req.body);

    if (req.user.id === req.params.id && body.role && body.role !== 'ADMIN') {
      return res.status(400).json({ message: 'Cannot remove admin role from your own account' });
    }

    const data = {
      ...(body.name ? { name: body.name } : {}),
      ...(body.email ? { email: body.email.toLowerCase() } : {}),
      ...(body.role ? { role: body.role } : {}),
    };

    if (body.password) {
      data.passwordHash = await bcrypt.hash(body.password, 12);
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });

    res.json({ user });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'Email already exists' });
    }
    next(error);
  }
});

adminRouter.delete('/users/:id', async (req, res, next) => {
  try {
    if (req.user.id === req.params.id) {
      return res.status(400).json({ message: 'Cannot delete your own account while logged in' });
    }

    const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.role === 'ADMIN' && adminCount <= 1) {
      return res.status(400).json({ message: 'Cannot delete the last admin' });
    }

    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/videos', async (_req, res, next) => {
  try {
    const videos = await prisma.video.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        playlist: true,
        summaries: {
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { date: 'desc' },
          take: 50,
        },
        _count: {
          select: { events: true, sessions: true, heatmap: true },
        },
      },
    });

    res.json({ videos });
  } catch (error) {
    next(error);
  }
});

adminRouter.patch('/videos/:id', async (req, res, next) => {
  try {
    const body = updateVideoSchema.extend({
      playlistId: z.string().nullable().optional(),
    }).parse(req.body);
    const video = await prisma.video.update({
      where: { id: req.params.id },
      data: body,
    });

    res.json({ video });
  } catch (error) {
    next(error);
  }
});

adminRouter.delete('/videos/:id', async (req, res, next) => {
  try {
    await prisma.video.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/analytics/users/:id', async (req, res, next) => {
  try {
    const [user, summaries, recentEvents] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
      }),
      prisma.dailyWatchSummary.findMany({
        where: { userId: req.params.id },
        orderBy: { date: 'desc' },
        include: { video: { include: { playlist: true } } },
        take: 120,
      }),
      prisma.watchEvent.findMany({
        where: { userId: req.params.id },
        orderBy: { serverTs: 'desc' },
        include: { video: { include: { playlist: true } } },
        take: 100,
      }),
    ]);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const totals = summaries.reduce((acc, row) => {
      acc.activeWatchSeconds += row.activeWatchSeconds;
      acc.pauseCount += row.pauseCount;
      acc.seekCount += row.seekCount;
      acc.sessionCount += row.sessionCount;
      return acc;
    }, { activeWatchSeconds: 0, pauseCount: 0, seekCount: 0, sessionCount: 0 });

    res.json({ user, totals, summaries, recentEvents });
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/analytics/users/:id/time-map', async (req, res, next) => {
  try {
    res.json(await getUserTimeMap(req.params.id, req.query.date ? new Date(req.query.date) : new Date()));
  } catch (error) {
    next(error);
  }
});
