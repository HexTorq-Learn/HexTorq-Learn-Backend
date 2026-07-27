import express from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';

export const videosRouter = express.Router();

const videoSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).optional(),
  durationSec: z.number().int().positive().optional(),
});

function parseYoutubeId(url) {
  const parsed = new URL(url);

  if (parsed.hostname.includes('youtu.be')) {
    return parsed.pathname.replace('/', '').slice(0, 32);
  }

  if (parsed.searchParams.get('v')) {
    return parsed.searchParams.get('v').slice(0, 32);
  }

  const embedMatch = parsed.pathname.match(/\/(embed|shorts)\/([^/?]+)/);
  if (embedMatch) {
    return embedMatch[2].slice(0, 32);
  }

  return null;
}

videosRouter.use(requireAuth);

videosRouter.get('/', async (_req, res, next) => {
  try {
    const videos = await prisma.video.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { events: true },
        },
      },
    });

    res.json({ videos });
  } catch (error) {
    next(error);
  }
});

videosRouter.post('/', async (req, res, next) => {
  try {
    const body = videoSchema.parse(req.body);
    const youtubeId = parseYoutubeId(body.url);

    if (!youtubeId) {
      return res.status(400).json({ message: 'Could not read YouTube video id from URL' });
    }

    const video = await prisma.video.upsert({
      where: { youtubeId },
      update: {
        title: body.title || `YouTube ${youtubeId}`,
        url: body.url,
        durationSec: body.durationSec,
      },
      create: {
        youtubeId,
        title: body.title || `YouTube ${youtubeId}`,
        url: body.url,
        durationSec: body.durationSec,
      },
    });

    res.status(201).json({ video });
  } catch (error) {
    next(error);
  }
});

videosRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = z.object({
      title: z.string().min(1).optional(),
      durationSec: z.number().int().positive().optional(),
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
