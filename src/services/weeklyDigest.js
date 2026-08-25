import { prisma } from '../prisma.js';
import { startOfUtcDay } from './analytics.js';
import { getLearnerLeaderboard } from './advancedMetrics.js';
import { createNotification, hasRecentNotification } from './notifications.js';

const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Kolkata';
const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_DAY = Number(process.env.WEEKLY_DIGEST_DAY ?? 0); // 0 = Sunday
const DIGEST_HOUR = Number(process.env.WEEKLY_DIGEST_HOUR ?? 20); // 24h, in APP_TIME_ZONE
const CHECK_INTERVAL_MS = Number(process.env.WEEKLY_DIGEST_CHECK_INTERVAL_MS || 30 * 60 * 1000);
const DIGEST_COOLDOWN_MS = 6 * DAY_MS;

let checkTimer = null;

function zonedNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    day: weekdayMap[parts.weekday],
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
  };
}

function formatHours(seconds) {
  const hours = seconds / 3600;
  if (hours >= 1) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round(seconds / 60)}m`;
}

async function buildDigestForUser(user, weekStart, weekEnd, leaderboard) {
  const summaries = await prisma.dailyWatchSummary.findMany({
    where: { userId: user.id, date: { gte: weekStart, lt: weekEnd } },
    select: { videoId: true, activeWatchSeconds: true },
  });

  const weeklyActiveSeconds = summaries.reduce((total, row) => total + row.activeWatchSeconds, 0);
  const touchedVideoIds = [...new Set(summaries.map((row) => row.videoId))];

  let completedThisWeek = 0;
  if (touchedVideoIds.length) {
    const [videos, allTimeSummaries] = await Promise.all([
      prisma.video.findMany({ where: { id: { in: touchedVideoIds } }, select: { id: true, durationSec: true } }),
      prisma.dailyWatchSummary.groupBy({
        by: ['videoId'],
        where: { userId: user.id, videoId: { in: touchedVideoIds } },
        _sum: { activeWatchSeconds: true },
      }),
    ]);
    const totalByVideo = Object.fromEntries(allTimeSummaries.map((row) => [row.videoId, row._sum.activeWatchSeconds || 0]));
    completedThisWeek = videos.filter((video) => (
      video.durationSec && (totalByVideo[video.id] || 0) / video.durationSec >= 0.9
    )).length;
  }

  const rankIndex = leaderboard.leaderboard.findIndex((row) => row.userId === user.id);
  const rank = rankIndex >= 0 ? rankIndex + 1 : null;

  return { weeklyActiveSeconds, completedThisWeek, rank, totalLearners: leaderboard.leaderboard.length };
}

async function sendDigestForUser(user, weekStart, weekEnd, leaderboard) {
  const digest = await buildDigestForUser(user, weekStart, weekEnd, leaderboard);

  const title = 'Your weekly learning digest';
  const message = digest.weeklyActiveSeconds > 0
    ? `This week: ${formatHours(digest.weeklyActiveSeconds)} studied, ${digest.completedThisWeek} video${digest.completedThisWeek === 1 ? '' : 's'} completed${digest.rank ? `, rank #${digest.rank} of ${digest.totalLearners}` : ''}. Keep it up!`
    : "You didn't log any study time this week. Pick up a video and get back on track!";

  await createNotification({
    userId: user.id,
    type: 'weekly_digest',
    severity: 'low',
    title,
    message,
    channel: 'both',
    email: user.email,
  });
}

export async function runWeeklyDigestForAllUsers() {
  const weekEnd = startOfUtcDay(new Date(Date.now() + DAY_MS));
  const weekStart = new Date(weekEnd.getTime() - 7 * DAY_MS);

  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  if (!users.length) return;

  const leaderboard = await getLearnerLeaderboard();

  for (const user of users) {
    try {
      if (await hasRecentNotification(user.id, 'weekly_digest', DIGEST_COOLDOWN_MS)) continue;
      await sendDigestForUser(user, weekStart, weekEnd, leaderboard);
    } catch (error) {
      console.error(`Failed to build weekly digest for user ${user.id}`, error);
    }
  }
}

function runWeeklyDigestCheck() {
  const { day, hour } = zonedNow();
  if (day !== DIGEST_DAY || hour !== DIGEST_HOUR) return;
  runWeeklyDigestForAllUsers().catch((error) => console.error('Weekly digest run failed', error));
}

export function startWeeklyDigestJob() {
  if (checkTimer) return;
  checkTimer = setInterval(runWeeklyDigestCheck, CHECK_INTERVAL_MS);
  checkTimer.unref?.();
}

export function stopWeeklyDigestJob() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
