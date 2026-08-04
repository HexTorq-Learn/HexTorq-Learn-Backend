import { prisma } from '../prisma.js';

const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Kolkata';

function zonedParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zonedOffsetMs(date) {
  const parts = zonedParts(date);
  const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return zonedAsUtc - date.getTime();
}

export function formatDateKey(date = new Date()) {
  const parts = zonedParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function startOfUtcDay(date = new Date()) {
  const parts = zonedParts(date);
  const utcGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return new Date(utcGuess.getTime() - zonedOffsetMs(utcGuess));
}

export function endOfUtcDay(date = new Date()) {
  const start = startOfUtcDay(date);
  return startOfUtcDay(new Date(start.getTime() + 36 * 60 * 60 * 1000));
}

export function formatClockParts(date) {
  const parts = zonedParts(date);
  return {
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    clock: date.toLocaleTimeString('en-US', { timeZone: APP_TIME_ZONE, hour12: true }),
  };
}

export async function getUserOverview(userId) {
  const [summaries, recentEvents, videos] = await Promise.all([
    prisma.dailyWatchSummary.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      include: { video: { include: { playlist: true } } },
      take: 60,
    }),
    prisma.watchEvent.findMany({
      where: { userId },
      orderBy: { serverTs: 'desc' },
      include: { video: { include: { playlist: true } } },
      take: 50,
    }),
    prisma.video.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        playlist: true,
        summaries: {
          where: { userId },
        },
      },
    }),
  ]);

  const totalActiveSeconds = summaries.reduce((total, row) => total + row.activeWatchSeconds, 0);
  const totalPauseCount = summaries.reduce((total, row) => total + row.pauseCount, 0);
  const totalSeekCount = summaries.reduce((total, row) => total + row.seekCount, 0);

  return {
    totals: { totalActiveSeconds, totalPauseCount, totalSeekCount },
    summaries,
    recentEvents,
    videos,
  };
}

export async function getUserTimeMap(userId, date = new Date()) {
  const dayStart = startOfUtcDay(date);
  const dayEnd = endOfUtcDay(date);
  const [buckets, recentEvents] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        EXTRACT(HOUR FROM "serverTs" AT TIME ZONE ${APP_TIME_ZONE})::int AS hour,
        EXTRACT(MINUTE FROM "serverTs" AT TIME ZONE ${APP_TIME_ZONE})::int AS minute,
        COUNT(*)::int AS "activeEvents",
        SUM(CASE WHEN "eventType" = 'PLAY' THEN 1 ELSE 0 END)::int AS "playEvents",
        SUM(CASE WHEN "eventType" = 'PAUSE' THEN 1 ELSE 0 END)::int AS "pauseEvents",
        SUM(CASE WHEN "eventType" = 'SEEK' THEN 1 ELSE 0 END)::int AS "seekEvents"
      FROM "WatchEvent"
      WHERE "userId" = ${userId}
        AND "serverTs" >= ${dayStart}
        AND "serverTs" < ${dayEnd}
      GROUP BY hour, minute
    `,
    prisma.watchEvent.findMany({
      where: {
        userId,
        serverTs: { gte: dayStart, lt: dayEnd },
      },
      orderBy: { serverTs: 'desc' },
      take: 120,
      include: { video: true },
    }),
  ]);

  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    activeEvents: 0,
    playEvents: 0,
    pauseEvents: 0,
    seekEvents: 0,
    seconds: Array.from({ length: 60 }, (_, minute) => ({ minute, count: 0 })),
  }));

  for (const row of buckets) {
    const hour = Number(row.hour);
    const minute = Number(row.minute);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;
    const bucket = hours[hour];
    bucket.activeEvents += Number(row.activeEvents || 0);
    bucket.playEvents += Number(row.playEvents || 0);
    bucket.pauseEvents += Number(row.pauseEvents || 0);
    bucket.seekEvents += Number(row.seekEvents || 0);
    bucket.seconds[minute].count += Number(row.activeEvents || 0);
  }

  const timeline = recentEvents.reverse().map((event) => ({
    id: event.id,
    type: event.eventType,
    clock: formatClockParts(event.serverTs).clock,
    serverTs: event.serverTs,
    videoTimeSec: event.videoTimeSec,
    fromTimeSec: event.fromTimeSec,
    toTimeSec: event.toTimeSec,
    video: {
      id: event.video.id,
      title: event.video.title,
      youtubeId: event.video.youtubeId,
    },
  }));

  return { date: dayStart, dateKey: formatDateKey(dayStart), timeZone: APP_TIME_ZONE, hours, timeline };
}
