import { prisma } from '../prisma.js';
import { endOfUtcDay, formatClockParts, startOfUtcDay } from './analytics.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function secondsBetween(start, end = new Date()) {
  if (!start) return 0;
  return Math.max(0, Math.floor(((end || new Date()).getTime() - start.getTime()) / 1000));
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function groupBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

function sum(items, getValue) {
  return items.reduce((total, item) => total + getValue(item), 0);
}

function getDuration(video, heatmapRows, events) {
  const explicit = Number(video.durationSec || 0);
  if (explicit > 0) return explicit;

  const heatmapMax = heatmapRows.length ? Math.max(...heatmapRows.map((row) => row.second)) + 1 : 0;
  const eventMax = Math.max(0, ...events.map((event) => Math.floor(event.videoTimeSec || 0)));
  return Math.max(explicit, heatmapMax, eventMax, 1);
}

function buildRanges(seconds) {
  const sorted = [...new Set(seconds)].sort((a, b) => a - b);
  const ranges = [];

  for (const second of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && second <= previous.end + 1) previous.end = second;
    else ranges.push({ start: second, end: second });
  }

  return ranges;
}

function buildMissingRanges(watchedSeconds, durationSec) {
  const watched = new Set(watchedSeconds);
  const missing = [];
  let start = null;

  for (let second = 0; second < durationSec; second += 1) {
    if (!watched.has(second) && start === null) start = second;
    if ((watched.has(second) || second === durationSec - 1) && start !== null) {
      const end = watched.has(second) ? second - 1 : second;
      if (end >= start) missing.push({ start, end });
      start = null;
    }
  }

  return missing.slice(0, 20);
}

function longestStreak(dateKeys) {
  const days = [...new Set(dateKeys)].sort();
  let best = 0;
  let current = 0;
  let previousTime = null;

  for (const day of days) {
    const time = new Date(`${day}T00:00:00.000Z`).getTime();
    current = previousTime !== null && time - previousTime === DAY_MS ? current + 1 : 1;
    best = Math.max(best, current);
    previousTime = time;
  }

  return best;
}

function periodKey(date, period) {
  if (period === 'month') return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  if (period === 'week') {
    const start = startOfUtcDay(date);
    const day = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - day + 1);
    return formatDateKey(start);
  }
  return formatDateKey(startOfUtcDay(date));
}

function buildStudySeries(summaries, period) {
  const buckets = {};
  for (const row of summaries) {
    const key = periodKey(row.date, period);
    buckets[key] = (buckets[key] || 0) + row.activeWatchSeconds;
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, activeWatchSeconds]) => ({ key, activeWatchSeconds }));
}

function computeVideoMetrics(videos, heatmapByVideo, eventsByVideo, summariesByVideo) {
  return videos.map((video) => {
    const heatmap = heatmapByVideo[video.id] || [];
    const events = eventsByVideo[video.id] || [];
    const summaries = summariesByVideo[video.id] || [];
    const durationSec = getDuration(video, heatmap, events);
    const watchedRows = heatmap.filter((row) => row.watchCount > 0);
    const uniqueWatchedSeconds = watchedRows.length;
    const totalHeatmapSeconds = sum(watchedRows, (row) => row.watchCount);
    const rewatchedSeconds = sum(watchedRows, (row) => Math.max(0, row.watchCount - 1));
    const completionPercent = Math.min(100, Math.round((uniqueWatchedSeconds / durationSec) * 100));
    const lastEventWithTime = [...events].reverse().find((event) => Number.isFinite(event.videoTimeSec));
    const dropOffTimestamp = uniqueWatchedSeconds ? Math.max(...watchedRows.map((row) => row.second)) : 0;
    const pauseEvents = events.filter((event) => event.eventType === 'PAUSE');
    const seekEvents = events.filter((event) => event.eventType === 'SEEK');
    const rewinds = seekEvents.filter((event) => Number(event.toTimeSec) < Number(event.fromTimeSec));
    const forwardSkips = seekEvents.filter((event) => Number(event.toTimeSec) > Number(event.fromTimeSec));
    const repeatedRanges = buildRanges(heatmap.filter((row) => row.watchCount >= 2).map((row) => row.second));
    const repeated3xRanges = buildRanges(heatmap.filter((row) => row.watchCount >= 3).map((row) => row.second));
    const repeated5xRanges = buildRanges(heatmap.filter((row) => row.watchCount >= 5).map((row) => row.second));
    const neverWatchedRanges = buildMissingRanges(watchedRows.map((row) => row.second), durationSec);
    const pauseDensity = durationSec ? pauseEvents.length / Math.max(1, durationSec / 60) : 0;
    const rewatchDensity = durationSec ? rewatchedSeconds / durationSec : 0;
    const confusingSectionScore = Math.round((pauseDensity * 20 + rewatchDensity * 80) * 10) / 10;

    return {
      id: video.id,
      title: video.title,
      youtubeId: video.youtubeId,
      playlistId: video.playlistId,
      playlistName: video.playlist?.name || 'No playlist',
      durationSec,
      activeWatchSeconds: sum(summaries, (row) => row.activeWatchSeconds),
      percentWatched: completionPercent,
      uniqueWatchedSeconds,
      rewatchedSeconds,
      skippedSeconds: Math.max(0, durationSec - uniqueWatchedSeconds),
      neverWatchedRanges,
      dropOffTimestamp,
      firstWatchVsRewatchRatio: {
        firstWatchSeconds: uniqueWatchedSeconds,
        rewatchSeconds: rewatchedSeconds,
      },
      averageWatchDepthPercent: completionPercent,
      lastWatchedPosition: lastEventWithTime?.videoTimeSec || 0,
      mostReplayedSecond: heatmap.reduce((best, row) => (row.watchCount > best.watchCount ? row : best), { second: 0, watchCount: 0 }),
      repeatedRanges: repeatedRanges.slice(0, 20),
      repeated3xRanges: repeated3xRanges.slice(0, 20),
      repeated5xRanges: repeated5xRanges.slice(0, 20),
      rewindCount: rewinds.length,
      rewindDistanceSec: Math.round(sum(rewinds, (event) => Math.max(0, Number(event.fromTimeSec || 0) - Number(event.toTimeSec || 0)))),
      forwardSkipCount: forwardSkips.length,
      forwardSkipDistanceSec: Math.round(sum(forwardSkips, (event) => Math.max(0, Number(event.toTimeSec || 0) - Number(event.fromTimeSec || 0)))),
      pauseCount: pauseEvents.length,
      longPauseCount: pauseEvents.filter((event, index) => {
        const next = events.slice(index + 1).find((candidate) => ['PLAY', 'END'].includes(candidate.eventType));
        return next && secondsBetween(event.serverTs, next.serverTs) >= 60;
      }).length,
      confusingSectionScore,
      hardTopicScore: Math.round((confusingSectionScore + repeatedRanges.length * 5) * 10) / 10,
    };
  });
}

function computeSessionMetrics(sessions, events) {
  const sortedEvents = [...events].sort((a, b) => a.serverTs - b.serverTs);
  const firstVideoStart = sortedEvents.find((event) => event.eventType === 'PLAY');
  const lastActiveEvent = sortedEvents.at(-1);
  const tabOpenSeconds = sum(sessions, (session) => secondsBetween(session.loginAt, session.logoutAt || new Date()));
  const focusLossEvents = sortedEvents.filter((event) => ['TAB_HIDDEN', 'WINDOW_BLUR'].includes(event.eventType));
  const idleEvents = sortedEvents.filter((event) => event.eventType === 'IDLE_START');
  const breaks = sortedEvents.filter((event) => ['PAUSE', 'IDLE_START', 'TAB_HIDDEN', 'WINDOW_BLUR'].includes(event.eventType));
  const activeMinutesPerSession = sessions.length ? Math.round((sum(sessions, (session) => secondsBetween(session.loginAt, session.logoutAt || new Date())) / 60 / sessions.length) * 10) / 10 : 0;

  return {
    sessionCount: sessions.length,
    loginTimes: sessions.map((session) => ({ id: session.id, clock: formatClockParts(session.loginAt).clock, loginAt: session.loginAt, logoutAt: session.logoutAt })),
    firstVideoStartTime: firstVideoStart ? { clock: formatClockParts(firstVideoStart.serverTs).clock, serverTs: firstVideoStart.serverTs } : null,
    lastActiveEventTime: lastActiveEvent ? { clock: formatClockParts(lastActiveEvent.serverTs).clock, serverTs: lastActiveEvent.serverTs } : null,
    totalTabOpenSeconds: tabOpenSeconds,
    breakCount: breaks.length,
    longPauseCount: 0,
    sessionDurationSeconds: tabOpenSeconds,
    activeMinutesPerSession,
    distractionCount: focusLossEvents.length,
    idleTriggerCount: idleEvents.length,
    studyMomentumScore: Math.max(0, Math.min(100, Math.round(activeMinutesPerSession * 4 - focusLossEvents.length * 3 - idleEvents.length * 5))),
  };
}

function computeTimeOfDay(events, summaries) {
  const hourCounts = Array.from({ length: 24 }, (_, hour) => ({ hour, events: 0, activeWatchSeconds: 0 }));
  const eventDays = {};

  for (const event of events) {
    const hour = event.serverTs.getHours();
    hourCounts[hour].events += 1;
    const day = formatDateKey(event.serverTs);
    eventDays[day] = (eventDays[day] || 0) + 1;
  }

  for (const row of summaries) {
    const key = formatDateKey(row.date);
    eventDays[key] = eventDays[key] || 0;
  }

  const best = [...hourCounts].sort((a, b) => b.events - a.events)[0];
  const morningEvents = sum(hourCounts.filter((row) => row.hour >= 5 && row.hour < 12), (row) => row.events);
  const eveningEvents = sum(hourCounts.filter((row) => row.hour >= 17 && row.hour < 24), (row) => row.events);
  const lateNightEvents = sum(hourCounts.filter((row) => row.hour < 5), (row) => row.events);

  return {
    bestStudyHour: best ? `${String(best.hour).padStart(2, '0')}:00` : null,
    mostFrequentLearningHour: best ? best.hour : null,
    peakConcentrationWindow: best ? `${String(best.hour).padStart(2, '0')}:00-${String((best.hour + 1) % 24).padStart(2, '0')}:00` : null,
    lateNightStudyEvents: lateNightEvents,
    morningVsEvening: { morningEvents, eveningEvents },
    mostConsistentDays: Object.entries(eventDays).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([date, events]) => ({ date, events })),
    hourlyDistribution: hourCounts,
  };
}

function computeBehavior(events, totalActiveSeconds) {
  const minutes = Math.max(1, totalActiveSeconds / 60);
  const pauses = events.filter((event) => event.eventType === 'PAUSE');
  const seeks = events.filter((event) => event.eventType === 'SEEK');
  const rewinds = seeks.filter((event) => Number(event.toTimeSec) < Number(event.fromTimeSec));
  const forwardSkips = seeks.filter((event) => Number(event.toTimeSec) > Number(event.fromTimeSec));
  const sortedEvents = [...events].sort((a, b) => a.serverTs - b.serverTs);
  const gaps = sortedEvents.slice(1).map((event, index) => secondsBetween(sortedEvents[index].serverTs, event.serverTs));
  const playbackRates = sortedEvents
    .map((event) => Number(event.metadata?.playbackRate))
    .filter((rate) => Number.isFinite(rate));

  return {
    pauseFrequencyPerMinute: Math.round((pauses.length / minutes) * 100) / 100,
    seekFrequencyPerMinute: Math.round((seeks.length / minutes) * 100) / 100,
    rewindCount: rewinds.length,
    forwardSkipCount: forwardSkips.length,
    averageSecondsBetweenInteractions: gaps.length ? Math.round(sum(gaps, (gap) => gap) / gaps.length) : 0,
    playPausePattern: sortedEvents.filter((event) => ['PLAY', 'PAUSE'].includes(event.eventType)).slice(-40).map((event) => ({ type: event.eventType, clock: formatClockParts(event.serverTs).clock })),
    watchSpeedConsistency: playbackRates.length ? {
      samples: playbackRates.length,
      min: Math.min(...playbackRates),
      max: Math.max(...playbackRates),
      average: Math.round((sum(playbackRates, (rate) => rate) / playbackRates.length) * 100) / 100,
    } : null,
    tabSwitchingFrequency: events.filter((event) => ['TAB_HIDDEN', 'WINDOW_BLUR'].includes(event.eventType)).length,
    outOfFocusRecoveryCount: events.filter((event) => ['TAB_VISIBLE', 'WINDOW_FOCUS'].includes(event.eventType)).length,
  };
}

function computePlaylistMetrics(playlists, videoMetrics) {
  const byPlaylist = groupBy(videoMetrics, (video) => video.playlistId || 'none');

  return [
    ...playlists.map((playlist) => ({ id: playlist.id, name: playlist.name, color: playlist.color })),
    { id: 'none', name: 'No playlist', color: '#aab4c3' },
  ].map((playlist) => {
    const videos = byPlaylist[playlist.id] || [];
    const completedVideos = videos.filter((video) => video.percentWatched >= 90).length;
    const activeWatchSeconds = sum(videos, (video) => video.activeWatchSeconds);
    const hardestVideo = [...videos].sort((a, b) => b.hardTopicScore - a.hardTopicScore)[0] || null;
    const mostRewatchedVideo = [...videos].sort((a, b) => b.rewatchedSeconds - a.rewatchedSeconds)[0] || null;
    const completionPercent = videos.length ? Math.round((completedVideos / videos.length) * 100) : 0;

    return {
      ...playlist,
      videoCount: videos.length,
      completedVideos,
      partialVideos: videos.filter((video) => video.percentWatched > 0 && video.percentWatched < 90).length,
      unstartedVideos: videos.filter((video) => video.percentWatched === 0).length,
      completionPercent,
      activeWatchSeconds,
      hardestVideo,
      mostRewatchedVideo,
      bestPerformingScore: completionPercent,
      folderWiseDailyProgress: videos.map((video) => ({ videoId: video.id, title: video.title, percentWatched: video.percentWatched })),
      courseProgressTimeline: videos.map((video) => ({ title: video.title, percentWatched: video.percentWatched, lastWatchedPosition: video.lastWatchedPosition })),
    };
  }).filter((playlist) => playlist.videoCount > 0 || playlist.id !== 'none');
}

function computeProgress(summaries, videoMetrics) {
  const today = formatDateKey(new Date());
  const yesterday = formatDateKey(new Date(Date.now() - DAY_MS));
  const todaySeconds = sum(summaries.filter((row) => formatDateKey(row.date) === today), (row) => row.activeWatchSeconds);
  const yesterdaySeconds = sum(summaries.filter((row) => formatDateKey(row.date) === yesterday), (row) => row.activeWatchSeconds);
  const weekSeries = buildStudySeries(summaries, 'week');
  const thisWeek = weekSeries.at(-1)?.activeWatchSeconds || 0;
  const lastWeek = weekSeries.at(-2)?.activeWatchSeconds || 0;
  const remainingSeconds = sum(videoMetrics, (video) => Math.max(0, video.durationSec - video.uniqueWatchedSeconds));
  const recentDaily = buildStudySeries(summaries, 'day').slice(-7);
  const averageDaily = recentDaily.length ? sum(recentDaily, (row) => row.activeWatchSeconds) / recentDaily.length : 0;

  return {
    todayVsYesterday: { todaySeconds, yesterdaySeconds, deltaSeconds: todaySeconds - yesterdaySeconds },
    thisWeekVsLastWeek: { thisWeekSeconds: thisWeek, lastWeekSeconds: lastWeek, deltaSeconds: thisWeek - lastWeek },
    estimatedCourseCompletionDays: averageDaily ? Math.ceil(remainingSeconds / averageDaily) : null,
    progressVelocitySecondsPerDay: Math.round(averageDaily),
    remainingVideoSeconds: remainingSeconds,
    completedVideos: videoMetrics.filter((video) => video.percentWatched >= 90).length,
    partiallyWatchedVideos: videoMetrics.filter((video) => video.percentWatched > 0 && video.percentWatched < 90).length,
    unstartedVideos: videoMetrics.filter((video) => video.percentWatched === 0).length,
    watchTargetCompletionPercent: Math.min(100, Math.round((todaySeconds / (60 * 60)) * 100)),
  };
}

function computeStreakCalendar(summaries) {
  const daily = buildStudySeries(summaries, 'day');
  return daily.map((row) => ({
    date: row.key,
    activeWatchSeconds: row.activeWatchSeconds,
    level: Math.min(4, Math.ceil(row.activeWatchSeconds / (15 * 60))),
  }));
}

function computeCompletionFunnel(videoMetrics) {
  const total = Math.max(1, videoMetrics.length);
  const steps = [
    { key: 'assigned', label: 'Assigned', count: videoMetrics.length },
    { key: 'started', label: 'Started', count: videoMetrics.filter((video) => video.percentWatched > 0).length },
    { key: 'watched25', label: '25%', count: videoMetrics.filter((video) => video.percentWatched >= 25).length },
    { key: 'watched50', label: '50%', count: videoMetrics.filter((video) => video.percentWatched >= 50).length },
    { key: 'watched75', label: '75%', count: videoMetrics.filter((video) => video.percentWatched >= 75).length },
    { key: 'completed', label: 'Completed', count: videoMetrics.filter((video) => video.percentWatched >= 90).length },
  ];

  return steps.map((step) => ({
    ...step,
    percent: Math.round((step.count / total) * 100),
  }));
}

function computeFocusSplit(totalActiveSeconds, pauseTimeSeconds, idleTimeSeconds, unfocusedTimeSeconds) {
  return [
    { key: 'active', label: 'Active', seconds: totalActiveSeconds },
    { key: 'paused', label: 'Paused', seconds: pauseTimeSeconds },
    { key: 'idle', label: 'Idle', seconds: idleTimeSeconds },
    { key: 'unfocused', label: 'Out of focus', seconds: unfocusedTimeSeconds },
  ];
}

function computeInsightCards(metrics) {
  const hardest = [...metrics.videoMetrics].sort((a, b) => b.hardTopicScore - a.hardTopicScore)[0];
  const skipped = [...metrics.videoMetrics].sort((a, b) => b.forwardSkipCount - a.forwardSkipCount)[0];
  const repeated = [...metrics.videoMetrics].sort((a, b) => b.mostReplayedSecond.watchCount - a.mostReplayedSecond.watchCount)[0];
  const mostFocused = [...metrics.learningTime.dailySeries].sort((a, b) => b.activeWatchSeconds - a.activeWatchSeconds)[0];
  const completionRate = metrics.videoMetrics.length
    ? Math.round(sum(metrics.videoMetrics, (video) => video.percentWatched) / metrics.videoMetrics.length)
    : 0;
  const focusScore = Math.max(0, Math.min(100, metrics.learningTime.studyEfficiencyPercent - metrics.sessionQuality.distractionCount * 2));
  const consistencyScore = Math.min(100, metrics.learningTime.studyStreakDays * 10);

  return {
    bestStudyHour: metrics.learningTime.bestStudyHour,
    mostFocusedDay: mostFocused?.key || null,
    mostDistractedDay: metrics.timeOfDay.mostConsistentDays.at(-1)?.date || null,
    mostRepeatedVideoSection: repeated ? {
      title: repeated.title,
      second: repeated.mostReplayedSecond.second,
      count: repeated.mostReplayedSecond.watchCount,
    } : null,
    hardestVideo: hardest ? { title: hardest.title, score: hardest.hardTopicScore } : null,
    mostSkippedVideo: skipped ? { title: skipped.title, skips: skipped.forwardSkipCount } : null,
    completionRate,
    focusScore,
    consistencyScore,
    stuckSegmentAlert: metrics.alerts.find((alert) => alert.type === 'repeated_section') || null,
    inactiveUserAlert: metrics.alerts.find((alert) => alert.type === 'inactive_user') || null,
    todayVsYesterday: metrics.learningProgress.todayVsYesterday,
    thisWeekVsLastWeek: metrics.learningProgress.thisWeekVsLastWeek,
    estimatedPlaylistCompletionDays: metrics.learningProgress.estimatedCourseCompletionDays,
  };
}

function computeResumeVideo(videoMetrics) {
  return [...videoMetrics]
    .filter((video) => video.percentWatched > 0 && video.percentWatched < 90)
    .sort((a, b) => b.lastWatchedPosition - a.lastWatchedPosition)[0] || null;
}

function publicLearnerId(userId) {
  return `LRN-${userId.slice(-6).toUpperCase()}`;
}

function computeGameProfile(metrics) {
  const xp = Math.round(
    metrics.learningTime.trueActiveStudySeconds / 60 * 10
    + metrics.learningTime.studyStreakDays * 50
    + metrics.learningProgress.completedVideos * 100
    + metrics.charts.insightCards.focusScore * 5,
  );
  const level = Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp)) / 3) + 1);
  const nextLevelXp = Math.pow(level * 3, 2);
  const badges = [];

  if (metrics.learningTime.studyStreakDays >= 3) badges.push({ key: 'streak_3', label: '3 Day Streak' });
  if (metrics.learningTime.studyStreakDays >= 7) badges.push({ key: 'streak_7', label: 'Weekly Warrior' });
  if (metrics.learningTime.trueActiveStudySeconds >= 60 * 60) badges.push({ key: 'hour_1', label: 'First Study Hour' });
  if (metrics.learningProgress.completedVideos >= 1) badges.push({ key: 'first_complete', label: 'Video Finisher' });
  if (metrics.charts.insightCards.focusScore >= 80) badges.push({ key: 'focused', label: 'Deep Focus' });
  if (metrics.videoCompletion.some((video) => video.rewatchedSeconds >= 60)) badges.push({ key: 'rewatcher', label: 'Revision Master' });

  return {
    xp,
    level,
    nextLevelXp,
    levelProgressPercent: Math.min(100, Math.round((xp / Math.max(1, nextLevelXp)) * 100)),
    badges,
  };
}

function computeAlerts(events, summaries, videoMetrics, playlistMetrics) {
  const latestEvent = [...events].sort((a, b) => b.serverTs - a.serverTs)[0];
  const daysSinceActive = latestEvent ? Math.floor((Date.now() - latestEvent.serverTs.getTime()) / DAY_MS) : null;
  const todaySeconds = sum(summaries.filter((row) => formatDateKey(row.date) === formatDateKey(new Date())), (row) => row.activeWatchSeconds);
  const focusLoss = events.filter((event) => ['TAB_HIDDEN', 'WINDOW_BLUR'].includes(event.eventType)).length;
  const alerts = [];

  if (daysSinceActive === null || daysSinceActive >= 3) alerts.push({ type: 'inactive_user', severity: 'high', message: 'User inactive for 3 or more days' });
  if (todaySeconds < 30 * 60) alerts.push({ type: 'below_daily_target', severity: 'medium', message: 'User watched less than 30 active minutes today' });
  if (focusLoss >= 5) alerts.push({ type: 'focus_loss', severity: 'medium', message: 'User leaves tab or app frequently' });

  for (const video of videoMetrics) {
    if (video.repeated5xRanges.length) alerts.push({ type: 'repeated_section', severity: 'medium', message: `${video.title} has sections repeated 5x or more` });
    if (video.forwardSkipCount >= 5) alerts.push({ type: 'skipped_sections', severity: 'medium', message: `${video.title} has frequent forward skips` });
  }

  for (const playlist of playlistMetrics) {
    if (playlist.videoCount && playlist.completionPercent < 50) alerts.push({ type: 'playlist_incomplete', severity: 'low', message: `${playlist.name} is below 50% completion` });
  }

  return alerts.slice(0, 30);
}

export async function getAdvancedUserMetrics(userId) {
  const [user, videos, sessions, events, heatmap, summaries, playlists] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, createdAt: true } }),
    prisma.video.findMany({ include: { playlist: true } }),
    prisma.watchSession.findMany({ where: { userId }, orderBy: { loginAt: 'asc' } }),
    prisma.watchEvent.findMany({ where: { userId }, orderBy: { serverTs: 'asc' }, include: { video: { include: { playlist: true } } } }),
    prisma.videoSecondHeatmap.findMany({ where: { userId }, orderBy: [{ videoId: 'asc' }, { second: 'asc' }] }),
    prisma.dailyWatchSummary.findMany({ where: { userId }, orderBy: { date: 'asc' }, include: { video: { include: { playlist: true } } } }),
    prisma.playlist.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] }),
  ]);

  if (!user) return null;

  const heatmapByVideo = groupBy(heatmap, (row) => row.videoId);
  const eventsByVideo = groupBy(events, (event) => event.videoId);
  const summariesByVideo = groupBy(summaries, (row) => row.videoId);
  const totalActiveSeconds = sum(summaries, (row) => row.activeWatchSeconds);
  const tabOpenSeconds = sum(sessions, (session) => secondsBetween(session.loginAt, session.logoutAt || new Date()));
  const pauseTimeSeconds = sum(events.filter((event) => event.eventType === 'PAUSE'), (event, index) => {
    const later = events.slice(index + 1).find((candidate) => ['PLAY', 'END'].includes(candidate.eventType));
    return later ? Math.min(secondsBetween(event.serverTs, later.serverTs), 30 * 60) : 0;
  });
  const bufferingTimeSeconds = events.filter((event) => event.eventType === 'BUFFER').length;
  const idleTimeSeconds = events.filter((event) => event.eventType === 'IDLE_START').length * 5 * 60;
  const unfocusedTimeSeconds = events.filter((event) => ['TAB_HIDDEN', 'WINDOW_BLUR'].includes(event.eventType)).length * 5 * 60;
  const videoMetrics = computeVideoMetrics(videos, heatmapByVideo, eventsByVideo, summariesByVideo);
  const playlistMetrics = computePlaylistMetrics(playlists, videoMetrics);
  const progress = computeProgress(summaries, videoMetrics);
  const learningTime = {
    trueActiveStudySeconds: totalActiveSeconds,
    totalTabOpenSeconds: tabOpenSeconds,
    focusedSeconds: Math.max(0, tabOpenSeconds - unfocusedTimeSeconds),
    unfocusedSeconds: unfocusedTimeSeconds,
    idleSeconds: idleTimeSeconds,
    pauseSeconds: pauseTimeSeconds,
    bufferingSeconds: bufferingTimeSeconds,
    studyEfficiencyPercent: tabOpenSeconds ? Math.round((totalActiveSeconds / tabOpenSeconds) * 100) : 0,
    dailySeries: buildStudySeries(summaries, 'day'),
    weeklySeries: buildStudySeries(summaries, 'week'),
    monthlySeries: buildStudySeries(summaries, 'month'),
    studyStreakDays: longestStreak(summaries.filter((row) => row.activeWatchSeconds > 0).map((row) => formatDateKey(row.date))),
    ...computeTimeOfDay(events, summaries),
  };
  const sessionQuality = computeSessionMetrics(sessions, events);
  const timeOfDay = computeTimeOfDay(events, summaries);
  const behavior = computeBehavior(events, totalActiveSeconds);
  const alerts = computeAlerts(events, summaries, videoMetrics, playlistMetrics);
  const common = {
    learningTime,
    videoMetrics,
    sessionQuality,
    timeOfDay,
    behavior,
    alerts,
    learningProgress: progress,
  };

  const response = {
    user,
    generatedAt: new Date(),
    learningTime,
    videoCompletion: videoMetrics,
    rewatchDifficulty: videoMetrics.map((video) => ({
      videoId: video.id,
      title: video.title,
      mostReplayedSecond: video.mostReplayedSecond,
      repeatedRanges: video.repeatedRanges,
      repeated2xRanges: video.repeatedRanges,
      repeated3xRanges: video.repeated3xRanges,
      repeated5xRanges: video.repeated5xRanges,
      confusingSectionScore: video.confusingSectionScore,
      hardTopicScore: video.hardTopicScore,
      pauseCount: video.pauseCount,
      longPauseCount: video.longPauseCount,
      rewindCount: video.rewindCount,
      rewindDistanceSec: video.rewindDistanceSec,
      forwardSkipCount: video.forwardSkipCount,
    })),
    sessionQuality,
    timeOfDay,
    behavior,
    playlistMetrics,
    learningProgress: progress,
    alerts,
    charts: {
      streakCalendar: computeStreakCalendar(summaries),
      completionFunnel: computeCompletionFunnel(videoMetrics),
      focusIdleStack: computeFocusSplit(totalActiveSeconds, pauseTimeSeconds, idleTimeSeconds, unfocusedTimeSeconds),
      playlistProgress: playlistMetrics,
      videoCompletionList: videoMetrics,
      repeatedSections: videoMetrics.flatMap((video) => video.repeatedRanges.map((range) => ({ videoId: video.id, title: video.title, ...range }))).slice(0, 30),
      dailyGoal: {
        targetSeconds: 60 * 60,
        actualSeconds: progress.todayVsYesterday.todaySeconds,
        percent: progress.watchTargetCompletionPercent,
      },
      resumeVideo: computeResumeVideo(videoMetrics),
      insightCards: computeInsightCards(common),
    },
  };

  response.game = {
    publicLearnerId: publicLearnerId(user.id),
    ...computeGameProfile(response),
  };

  return response;
}

export async function getAdminComparisonMetrics() {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true },
    orderBy: { createdAt: 'desc' },
  });

  const rows = [];
  for (const user of users) {
    const metrics = await getAdvancedUserMetrics(user.id);
    if (!metrics) continue;
    const completionAvg = metrics.videoCompletion.length
      ? Math.round(sum(metrics.videoCompletion, (video) => video.percentWatched) / metrics.videoCompletion.length)
      : 0;
    rows.push({
      user,
      publicLearnerId: publicLearnerId(user.id),
      activeStudySeconds: metrics.learningTime.trueActiveStudySeconds,
      consistencyScore: metrics.learningTime.studyStreakDays,
      playlistProgressPercent: metrics.playlistMetrics.length
        ? Math.round(sum(metrics.playlistMetrics, (playlist) => playlist.completionPercent) / metrics.playlistMetrics.length)
        : 0,
      completionRatePercent: completionAvg,
      distractionRate: metrics.sessionQuality.distractionCount,
      lowCompletion: completionAvg < 50,
      highDistraction: metrics.sessionQuality.distractionCount >= 5,
      stuckSegments: sum(metrics.rewatchDifficulty, (video) => video.repeated5xRanges.length),
      dailySeries: metrics.learningTime.dailySeries,
      hourlyDistribution: metrics.timeOfDay.hourlyDistribution,
      radar: {
        focus: metrics.charts.insightCards.focusScore,
        completion: completionAvg,
        consistency: Math.min(100, metrics.consistencyScore || metrics.learningTime.studyStreakDays * 10),
        rewatch: Math.min(100, sum(metrics.videoCompletion, (video) => video.rewatchedSeconds) / 10),
        idle: Math.max(0, 100 - Math.min(100, metrics.learningTime.idleSeconds / 60)),
      },
      game: metrics.game,
    });
  }

  const allHourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    events: sum(rows, (row) => row.hourlyDistribution.find((bucket) => bucket.hour === hour)?.events || 0),
  }));
  const dailyActiveMap = {};
  for (const row of rows) {
    for (const day of row.dailySeries) {
      dailyActiveMap[day.key] = dailyActiveMap[day.key] || { date: day.key, activeUsers: 0, totalStudySeconds: 0 };
      if (day.activeWatchSeconds > 0) dailyActiveMap[day.key].activeUsers += 1;
      dailyActiveMap[day.key].totalStudySeconds += day.activeWatchSeconds;
    }
  }
  const playlistRows = await prisma.playlist.findMany({ include: { videos: true } });
  const cohortMap = {};
  const cohortUsers = await prisma.user.findMany({ select: { id: true, createdAt: true } });
  for (const user of cohortUsers) {
    const cohort = periodKey(user.createdAt, 'week');
    cohortMap[cohort] = cohortMap[cohort] || { cohort, users: 0, day1: 0, day2: 0, day7: 0 };
    cohortMap[cohort].users += 1;
  }

  return {
    leaderboards: {
      byActiveStudy: [...rows].sort((a, b) => b.activeStudySeconds - a.activeStudySeconds),
      byConsistency: [...rows].sort((a, b) => b.consistencyScore - a.consistencyScore),
      byPlaylistProgress: [...rows].sort((a, b) => b.playlistProgressPercent - a.playlistProgressPercent),
    },
    inactiveUsers: rows.filter((row) => row.activeStudySeconds === 0),
    highDistractionUsers: rows.filter((row) => row.highDistraction),
    lowCompletionUsers: rows.filter((row) => row.lowCompletion),
    stuckUsers: rows.filter((row) => row.stuckSegments > 0),
    userComparison: rows,
    charts: {
      allUsers24HourHeatmap: allHourly,
      dailyActiveLearners: Object.values(dailyActiveMap).sort((a, b) => a.date.localeCompare(b.date)),
      totalStudyTimeByDay: Object.values(dailyActiveMap).sort((a, b) => a.date.localeCompare(b.date)),
      playlistCompletion: playlistRows.map((playlist) => {
        const related = rows.flatMap((row) => row.dailySeries).length;
        return { id: playlist.id, name: playlist.name, videoCount: playlist.videos.length, activityRows: related };
      }),
      cohortRetention: Object.values(cohortMap).sort((a, b) => a.cohort.localeCompare(b.cohort)),
    },
  };
}

export async function getLearnerLeaderboard() {
  const comparison = await getAdminComparisonMetrics();
  return {
    leaderboard: comparison.userComparison.map((row) => ({
      userId: row.user.id,
      publicLearnerId: row.publicLearnerId,
      name: row.user.name,
      activeStudySeconds: row.activeStudySeconds,
      consistencyScore: row.consistencyScore,
      completionRatePercent: row.completionRatePercent,
      playlistProgressPercent: row.playlistProgressPercent,
      xp: row.game?.xp || 0,
      level: row.game?.level || 1,
      badges: row.game?.badges || [],
      rankScore: row.activeStudySeconds + row.consistencyScore * 60 + row.completionRatePercent * 30,
    })).sort((a, b) => b.rankScore - a.rankScore),
  };
}
