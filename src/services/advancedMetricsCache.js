import { prisma } from '../prisma.js';
import { getAdvancedUserMetrics } from './advancedMetrics.js';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const STALE_AFTER_MS = REFRESH_INTERVAL_MS;
const INITIAL_REFRESH_DELAY_MS = 5000;

let refreshTimer = null;
let refreshRunning = false;
const pendingUserRefreshes = new Map();

function withCacheMetadata(metrics, snapshot) {
  if (!metrics) return null;
  return {
    ...metrics,
    cache: {
      source: 'db_snapshot',
      calculatedAt: snapshot.calculatedAt,
      updatedAt: snapshot.updatedAt,
      stale: Date.now() - snapshot.calculatedAt.getTime() > STALE_AFTER_MS,
    },
  };
}

async function saveAdvancedMetricsSnapshot(userId, metrics) {
  const now = new Date();
  const snapshot = await prisma.advancedMetricsSnapshot.upsert({
    where: { userId },
    update: {
      metrics,
      calculatedAt: now,
    },
    create: {
      userId,
      metrics,
      calculatedAt: now,
    },
  });

  return withCacheMetadata(snapshot.metrics, snapshot);
}

export async function refreshAdvancedMetricsForUser(userId) {
  if (pendingUserRefreshes.has(userId)) return pendingUserRefreshes.get(userId);

  const promise = getAdvancedUserMetrics(userId)
    .then((metrics) => {
      if (!metrics) return null;
      return saveAdvancedMetricsSnapshot(userId, metrics);
    })
    .finally(() => {
      pendingUserRefreshes.delete(userId);
    });

  pendingUserRefreshes.set(userId, promise);
  return promise;
}

export async function getCachedAdvancedUserMetrics(userId) {
  const snapshot = await prisma.advancedMetricsSnapshot.findUnique({
    where: { userId },
  });

  if (snapshot) {
    if (Date.now() - snapshot.calculatedAt.getTime() > STALE_AFTER_MS) {
      refreshAdvancedMetricsForUser(userId).catch((error) => {
        console.error('Failed to refresh stale advanced metrics snapshot', { userId, error });
      });
    }
    return withCacheMetadata(snapshot.metrics, snapshot);
  }

  return refreshAdvancedMetricsForUser(userId);
}

export async function refreshAllAdvancedMetricsSnapshots() {
  if (refreshRunning) return;
  refreshRunning = true;
  const startedAt = Date.now();
  let refreshed = 0;
  let failed = 0;

  try {
    const users = await prisma.user.findMany({
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    for (const user of users) {
      try {
        await refreshAdvancedMetricsForUser(user.id);
        refreshed += 1;
      } catch (error) {
        failed += 1;
        console.error('Failed to refresh advanced metrics snapshot', { userId: user.id, error });
      }
    }

    console.log(JSON.stringify({
      project: 'HexTorq Learn Backend',
      task: 'refreshAllAdvancedMetricsSnapshots',
      refreshed,
      failed,
      durationMs: Date.now() - startedAt,
    }));
  } finally {
    refreshRunning = false;
  }
}

export function startAdvancedMetricsCacheJob() {
  if (refreshTimer) return;

  setTimeout(() => {
    refreshAllAdvancedMetricsSnapshots().catch((error) => {
      console.error('Initial advanced metrics cache refresh failed', error);
    });
  }, INITIAL_REFRESH_DELAY_MS);

  refreshTimer = setInterval(() => {
    refreshAllAdvancedMetricsSnapshots().catch((error) => {
      console.error('Advanced metrics cache refresh failed', error);
    });
  }, REFRESH_INTERVAL_MS);

  refreshTimer.unref?.();
}
