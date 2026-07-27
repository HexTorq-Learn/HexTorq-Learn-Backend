import express from 'express';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';

export const analyticsRouter = express.Router();

analyticsRouter.use(requireAuth);

analyticsRouter.get('/overview', async (req, res, next) => {
  try {
    const [summaries, recentEvents, videos] = await Promise.all([
      prisma.dailyWatchSummary.findMany({
        where: { userId: req.user.id },
        orderBy: { date: 'desc' },
        include: { video: true },
        take: 60,
      }),
      prisma.watchEvent.findMany({
        where: { userId: req.user.id },
        orderBy: { serverTs: 'desc' },
        include: { video: true },
        take: 50,
      }),
      prisma.video.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          summaries: {
            where: { userId: req.user.id },
          },
        },
      }),
    ]);

    const totalActiveSeconds = summaries.reduce((total, row) => total + row.activeWatchSeconds, 0);
    const totalPauseCount = summaries.reduce((total, row) => total + row.pauseCount, 0);
    const totalSeekCount = summaries.reduce((total, row) => total + row.seekCount, 0);

    res.json({
      totals: { totalActiveSeconds, totalPauseCount, totalSeekCount },
      summaries,
      recentEvents,
      videos,
    });
  } catch (error) {
    next(error);
  }
});

analyticsRouter.get('/videos/:id/heatmap', async (req, res, next) => {
  try {
    const heatmap = await prisma.videoSecondHeatmap.findMany({
      where: { userId: req.user.id, videoId: req.params.id },
      orderBy: { second: 'asc' },
    });

    const maxWatchCount = heatmap.reduce((max, row) => Math.max(max, row.watchCount), 0);
    const repeatedFrames = heatmap
      .filter((row) => row.watchCount > 1)
      .sort((a, b) => b.watchCount - a.watchCount)
      .slice(0, 20);

    res.json({ heatmap, maxWatchCount, repeatedFrames });
  } catch (error) {
    next(error);
  }
});
