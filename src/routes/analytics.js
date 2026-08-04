import express from 'express';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { getUserOverview, getUserTimeMap } from '../services/analytics.js';
import { getLearnerLeaderboard } from '../services/advancedMetrics.js';
import { getCachedAdvancedUserMetrics } from '../services/advancedMetricsCache.js';
import { cachedResponse } from '../services/responseCache.js';

export const analyticsRouter = express.Router();

analyticsRouter.use(requireAuth);

analyticsRouter.get('/overview', async (req, res, next) => {
  try {
    res.json(await cachedResponse(`overview:${req.user.id}`, 5000, () => getUserOverview(req.user.id)));
  } catch (error) {
    next(error);
  }
});

analyticsRouter.get('/time-map', async (req, res, next) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const key = `time-map:${req.user.id}:${date.toISOString().slice(0, 10)}`;
    res.json(await cachedResponse(key, 5000, () => getUserTimeMap(req.user.id, date)));
  } catch (error) {
    next(error);
  }
});

analyticsRouter.get('/advanced', async (req, res, next) => {
  try {
    res.json(await cachedResponse(`advanced:${req.user.id}`, 30000, () => getCachedAdvancedUserMetrics(req.user.id)));
  } catch (error) {
    next(error);
  }
});

analyticsRouter.get('/leaderboard', async (_req, res, next) => {
  try {
    res.json(await cachedResponse('leaderboard', 15000, () => getLearnerLeaderboard()));
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
