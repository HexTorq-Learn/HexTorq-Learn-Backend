import express from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';

export const playlistsRouter = express.Router();

const playlistSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  color: z.string().min(3).default('#1f6f64'),
  sortOrder: z.number().int().default(0),
});

playlistsRouter.use(requireAuth);

playlistsRouter.get('/', async (_req, res, next) => {
  try {
    const playlists = await prisma.playlist.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: {
        videos: {
          orderBy: { createdAt: 'desc' },
          include: { playlist: true },
        },
      },
    });

    res.json({ playlists });
  } catch (error) {
    next(error);
  }
});

playlistsRouter.post('/', requireAdmin, async (req, res, next) => {
  try {
    const body = playlistSchema.parse(req.body);
    const playlist = await prisma.playlist.create({ data: body });
    res.status(201).json({ playlist });
  } catch (error) {
    next(error);
  }
});

playlistsRouter.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const body = playlistSchema.partial().parse(req.body);
    const playlist = await prisma.playlist.update({
      where: { id: req.params.id },
      data: body,
    });
    res.json({ playlist });
  } catch (error) {
    next(error);
  }
});

playlistsRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.playlist.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});
