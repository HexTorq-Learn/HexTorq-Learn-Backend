import { prisma } from '../prisma.js';

export function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function endOfUtcDay(date = new Date()) {
  const start = startOfUtcDay(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

export function formatClockParts(date) {
  return {
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    clock: date.toLocaleTimeString('en-GB', { hour12: false }),
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
  const events = await prisma.watchEvent.findMany({
    where: {
      userId,
      serverTs: { gte: dayStart, lt: dayEnd },
    },
    orderBy: { serverTs: 'asc' },
    include: { video: true },
  });

  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    activeEvents: 0,
    playEvents: 0,
    pauseEvents: 0,
    seekEvents: 0,
    seconds: Array.from({ length: 60 }, (_, minute) => ({ minute, count: 0 })),
  }));

  for (const event of events) {
    const parts = formatClockParts(event.serverTs);
    const bucket = hours[parts.hour];
    bucket.activeEvents += 1;
    bucket.seconds[parts.minute].count += 1;
    if (event.eventType === 'PLAY') bucket.playEvents += 1;
    if (event.eventType === 'PAUSE') bucket.pauseEvents += 1;
    if (event.eventType === 'SEEK') bucket.seekEvents += 1;
  }

  const timeline = events.slice(-120).map((event) => ({
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

  return { date: dayStart, hours, timeline };
}
