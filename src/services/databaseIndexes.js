import { prisma } from '../prisma.js';

const INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS "User_createdAt_idx" ON "User" ("createdAt")',
  'CREATE INDEX IF NOT EXISTS "Playlist_sortOrder_createdAt_idx" ON "Playlist" ("sortOrder", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "Video_createdAt_idx" ON "Video" ("createdAt")',
  'CREATE INDEX IF NOT EXISTS "Video_playlistId_idx" ON "Video" ("playlistId")',
  'CREATE INDEX IF NOT EXISTS "WatchSession_userId_loginAt_idx" ON "WatchSession" ("userId", "loginAt")',
  'CREATE INDEX IF NOT EXISTS "WatchSession_videoId_loginAt_idx" ON "WatchSession" ("videoId", "loginAt")',
  'CREATE INDEX IF NOT EXISTS "WatchEvent_serverTs_idx" ON "WatchEvent" ("serverTs")',
  'CREATE INDEX IF NOT EXISTS "WatchEvent_userId_serverTs_idx" ON "WatchEvent" ("userId", "serverTs")',
  'CREATE INDEX IF NOT EXISTS "WatchEvent_videoId_serverTs_idx" ON "WatchEvent" ("videoId", "serverTs")',
  'CREATE INDEX IF NOT EXISTS "WatchEvent_userId_eventType_serverTs_idx" ON "WatchEvent" ("userId", "eventType", "serverTs")',
  'CREATE INDEX IF NOT EXISTS "VideoSecondHeatmap_userId_videoId_idx" ON "VideoSecondHeatmap" ("userId", "videoId")',
  'CREATE INDEX IF NOT EXISTS "VideoSecondHeatmap_userId_watchCount_idx" ON "VideoSecondHeatmap" ("userId", "watchCount")',
  'CREATE INDEX IF NOT EXISTS "VideoSecondHeatmap_watchCount_idx" ON "VideoSecondHeatmap" ("watchCount")',
  'CREATE INDEX IF NOT EXISTS "DailyWatchSummary_date_idx" ON "DailyWatchSummary" ("date")',
  'CREATE INDEX IF NOT EXISTS "DailyWatchSummary_videoId_date_idx" ON "DailyWatchSummary" ("videoId", "date")',
];

export async function ensureAnalyticsIndexes() {
  const startedAt = Date.now();
  for (const statement of INDEX_STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
  console.log(JSON.stringify({
    project: 'HexTorq Learn Backend',
    task: 'ensureAnalyticsIndexes',
    indexCount: INDEX_STATEMENTS.length,
    durationMs: Date.now() - startedAt,
  }));
}
