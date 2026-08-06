import { prisma } from '../prisma.js';
import { formatClockParts, formatDateKey, startOfUtcDay } from './analytics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Kolkata';

function secondsBetween(start, end = new Date()) {
  if (!start) return 0;
  return Math.max(0, Math.floor(((end || new Date()).getTime() - start.getTime()) / 1000));
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
  const dateKey = formatDateKey(date);
  if (period === 'month') return dateKey.slice(0, 7);
  if (period === 'week') {
    const start = new Date(`${dateKey}T00:00:00.000Z`);
    const day = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - day + 1);
    return start.toISOString().slice(0, 10);
  }
  return dateKey;
}

function formatHourLabel(hour) {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:00 ${suffix}`;
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
    const hour = formatClockParts(event.serverTs).hour;
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
    bestStudyHour: best ? formatHourLabel(best.hour) : null,
    mostFrequentLearningHour: best ? best.hour : null,
    peakConcentrationWindow: best ? `${formatHourLabel(best.hour)}-${formatHourLabel((best.hour + 1) % 24)}` : null,
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

function badgeDefinition(key, label, category, unlocked, progress, target, description) {
  return {
    key,
    label,
    category,
    unlocked,
    progress: Math.max(0, Math.min(target, Math.round(progress))),
    target,
    percent: Math.max(0, Math.min(100, Math.round((progress / Math.max(1, target)) * 100))),
    description,
  };
}

function buildBadges(metrics) {
  const activeMinutes = Math.floor(metrics.learningTime.trueActiveStudySeconds / 60);
  const activeHours = Math.floor(activeMinutes / 60);
  const streak = metrics.learningTime.studyStreakDays;
  const completed = metrics.learningProgress.completedVideos;
  const partial = metrics.learningProgress.partiallyWatchedVideos;
  const completionRate = metrics.charts.insightCards.completionRate;
  const focusScore = metrics.charts.insightCards.focusScore;
  const consistencyScore = metrics.charts.insightCards.consistencyScore;
  const rewatchedMinutes = Math.floor(sum(metrics.videoCompletion, (video) => video.rewatchedSeconds) / 60);
  const rewindCount = sum(metrics.videoCompletion, (video) => video.rewindCount);
  const seekCount = sum(metrics.videoCompletion, (video) => video.rewindCount + video.forwardSkipCount);
  const playlistCompletion = metrics.playlistMetrics.length
    ? Math.round(sum(metrics.playlistMetrics, (playlist) => playlist.completionPercent) / metrics.playlistMetrics.length)
    : 0;
  const studiedDays = metrics.learningTime.dailySeries.filter((row) => row.activeWatchSeconds > 0).length;
  const morningEvents = metrics.timeOfDay.morningVsEvening.morningEvents;
  const eveningEvents = metrics.timeOfDay.morningVsEvening.eveningEvents;
  const lateNight = metrics.timeOfDay.lateNightStudyEvents;
  const lowIdle = Math.max(0, 100 - Math.floor(metrics.learningTime.idleSeconds / 60));
  const activeSessions = metrics.sessionQuality.sessionCount;
  const momentum = metrics.sessionQuality.studyMomentumScore;

  return [
    badgeDefinition('first_minute', 'First Minute', 'Time', activeMinutes >= 1, activeMinutes, 1, 'Study for 1 active minute'),
    badgeDefinition('study_5m', 'Warm Start', 'Time', activeMinutes >= 5, activeMinutes, 5, 'Study for 5 active minutes'),
    badgeDefinition('study_15m', 'Quarter Focus', 'Time', activeMinutes >= 15, activeMinutes, 15, 'Study for 15 active minutes'),
    badgeDefinition('study_30m', 'Deep Start', 'Time', activeMinutes >= 30, activeMinutes, 30, 'Study for 30 active minutes'),
    badgeDefinition('hour_1', 'First Study Hour', 'Time', activeHours >= 1, activeMinutes, 60, 'Study for 1 active hour'),
    badgeDefinition('hour_3', 'Three Hour Climb', 'Time', activeHours >= 3, activeMinutes, 180, 'Study for 3 active hours'),
    badgeDefinition('hour_5', 'Five Hour Focus', 'Time', activeHours >= 5, activeMinutes, 300, 'Study for 5 active hours'),
    badgeDefinition('hour_10', 'Ten Hour Builder', 'Time', activeHours >= 10, activeMinutes, 600, 'Study for 10 active hours'),
    badgeDefinition('hour_25', 'Course Grinder', 'Time', activeHours >= 25, activeMinutes, 1500, 'Study for 25 active hours'),
    badgeDefinition('hour_50', 'Marathon Learner', 'Time', activeHours >= 50, activeMinutes, 3000, 'Study for 50 active hours'),
    badgeDefinition('streak_1', 'Day One Streak', 'Streak', streak >= 1, streak, 1, 'Study for 1 day'),
    badgeDefinition('streak_3', '3 Day Streak', 'Streak', streak >= 3, streak, 3, 'Study 3 days in a row'),
    badgeDefinition('streak_5', '5 Day Rhythm', 'Streak', streak >= 5, streak, 5, 'Study 5 days in a row'),
    badgeDefinition('streak_7', 'Weekly Warrior', 'Streak', streak >= 7, streak, 7, 'Study 7 days in a row'),
    badgeDefinition('streak_14', 'Fortnight Focus', 'Streak', streak >= 14, streak, 14, 'Study 14 days in a row'),
    badgeDefinition('streak_21', 'Habit Architect', 'Streak', streak >= 21, streak, 21, 'Study 21 days in a row'),
    badgeDefinition('streak_30', 'Monthly Master', 'Streak', streak >= 30, streak, 30, 'Study 30 days in a row'),
    badgeDefinition('days_3', 'Three Study Days', 'Consistency', studiedDays >= 3, studiedDays, 3, 'Study on 3 separate days'),
    badgeDefinition('days_7', 'Seven Study Days', 'Consistency', studiedDays >= 7, studiedDays, 7, 'Study on 7 separate days'),
    badgeDefinition('days_15', 'Fifteen Study Days', 'Consistency', studiedDays >= 15, studiedDays, 15, 'Study on 15 separate days'),
    badgeDefinition('days_30', 'Thirty Study Days', 'Consistency', studiedDays >= 30, studiedDays, 30, 'Study on 30 separate days'),
    badgeDefinition('consistency_25', 'Consistency Spark', 'Consistency', consistencyScore >= 25, consistencyScore, 25, 'Reach 25 consistency score'),
    badgeDefinition('consistency_50', 'Consistency Core', 'Consistency', consistencyScore >= 50, consistencyScore, 50, 'Reach 50 consistency score'),
    badgeDefinition('consistency_75', 'Consistency Engine', 'Consistency', consistencyScore >= 75, consistencyScore, 75, 'Reach 75 consistency score'),
    badgeDefinition('consistency_100', 'Consistency Legend', 'Consistency', consistencyScore >= 100, consistencyScore, 100, 'Reach 100 consistency score'),
    badgeDefinition('complete_1', 'Video Finisher', 'Completion', completed >= 1, completed, 1, 'Complete 1 video'),
    badgeDefinition('complete_3', 'Triple Finisher', 'Completion', completed >= 3, completed, 3, 'Complete 3 videos'),
    badgeDefinition('complete_5', 'Five Video Run', 'Completion', completed >= 5, completed, 5, 'Complete 5 videos'),
    badgeDefinition('complete_10', 'Ten Video Run', 'Completion', completed >= 10, completed, 10, 'Complete 10 videos'),
    badgeDefinition('complete_25', 'Playlist Crusher', 'Completion', completed >= 25, completed, 25, 'Complete 25 videos'),
    badgeDefinition('partial_5', 'Explorer', 'Completion', partial >= 5, partial, 5, 'Start 5 videos'),
    badgeDefinition('partial_15', 'Wide Explorer', 'Completion', partial >= 15, partial, 15, 'Start 15 videos'),
    badgeDefinition('completion_25', '25% Course Mark', 'Completion', completionRate >= 25, completionRate, 25, 'Reach 25% average completion'),
    badgeDefinition('completion_50', '50% Course Mark', 'Completion', completionRate >= 50, completionRate, 50, 'Reach 50% average completion'),
    badgeDefinition('completion_75', '75% Course Mark', 'Completion', completionRate >= 75, completionRate, 75, 'Reach 75% average completion'),
    badgeDefinition('completion_90', 'Completion Elite', 'Completion', completionRate >= 90, completionRate, 90, 'Reach 90% average completion'),
    badgeDefinition('playlist_25', 'Playlist Starter', 'Playlist', playlistCompletion >= 25, playlistCompletion, 25, 'Reach 25% playlist progress'),
    badgeDefinition('playlist_50', 'Playlist Halfway', 'Playlist', playlistCompletion >= 50, playlistCompletion, 50, 'Reach 50% playlist progress'),
    badgeDefinition('playlist_75', 'Playlist Dominator', 'Playlist', playlistCompletion >= 75, playlistCompletion, 75, 'Reach 75% playlist progress'),
    badgeDefinition('playlist_100', 'Playlist Conqueror', 'Playlist', playlistCompletion >= 100, playlistCompletion, 100, 'Complete a playlist'),
    badgeDefinition('focus_25', 'Focus Spark', 'Focus', focusScore >= 25, focusScore, 25, 'Reach 25 focus score'),
    badgeDefinition('focus_50', 'Focus Builder', 'Focus', focusScore >= 50, focusScore, 50, 'Reach 50 focus score'),
    badgeDefinition('focus_75', 'Deep Focus', 'Focus', focusScore >= 75, focusScore, 75, 'Reach 75 focus score'),
    badgeDefinition('focus_90', 'Laser Focus', 'Focus', focusScore >= 90, focusScore, 90, 'Reach 90 focus score'),
    badgeDefinition('idle_low', 'Low Idle Learner', 'Focus', lowIdle >= 90, lowIdle, 90, 'Keep idle time low'),
    badgeDefinition('revision_5m', 'Revision Starter', 'Revision', rewatchedMinutes >= 5, rewatchedMinutes, 5, 'Rewatch 5 minutes'),
    badgeDefinition('revision_15m', 'Revision Builder', 'Revision', rewatchedMinutes >= 15, rewatchedMinutes, 15, 'Rewatch 15 minutes'),
    badgeDefinition('revision_30m', 'Revision Master', 'Revision', rewatchedMinutes >= 30, rewatchedMinutes, 30, 'Rewatch 30 minutes'),
    badgeDefinition('rewind_5', 'Rewind Curious', 'Revision', rewindCount >= 5, rewindCount, 5, 'Rewind 5 times'),
    badgeDefinition('rewind_20', 'Rewind Analyst', 'Revision', rewindCount >= 20, rewindCount, 20, 'Rewind 20 times'),
    badgeDefinition('rewind_50', 'Rewind Specialist', 'Revision', rewindCount >= 50, rewindCount, 50, 'Rewind 50 times'),
    badgeDefinition('seek_25', 'Timeline Navigator', 'Behavior', seekCount >= 25, seekCount, 25, 'Use seeks 25 times'),
    badgeDefinition('seek_100', 'Timeline Expert', 'Behavior', seekCount >= 100, seekCount, 100, 'Use seeks 100 times'),
    badgeDefinition('sessions_3', 'Session Starter', 'Session', activeSessions >= 3, activeSessions, 3, 'Start 3 sessions'),
    badgeDefinition('sessions_10', 'Session Builder', 'Session', activeSessions >= 10, activeSessions, 10, 'Start 10 sessions'),
    badgeDefinition('sessions_25', 'Session Veteran', 'Session', activeSessions >= 25, activeSessions, 25, 'Start 25 sessions'),
    badgeDefinition('momentum_25', 'Momentum Spark', 'Session', momentum >= 25, momentum, 25, 'Reach 25 momentum'),
    badgeDefinition('momentum_50', 'Momentum Builder', 'Session', momentum >= 50, momentum, 50, 'Reach 50 momentum'),
    badgeDefinition('momentum_75', 'Momentum Machine', 'Session', momentum >= 75, momentum, 75, 'Reach 75 momentum'),
    badgeDefinition('morning_10', 'Morning Learner', 'Time of Day', morningEvents >= 10, morningEvents, 10, 'Study in the morning often'),
    badgeDefinition('evening_10', 'Evening Learner', 'Time of Day', eveningEvents >= 10, eveningEvents, 10, 'Study in the evening often'),
    badgeDefinition('night_10', 'Night Owl Learner', 'Time of Day', lateNight >= 10, lateNight, 10, 'Study late-night often'),
  ];
}

function computeGameProfile(metrics) {
  const allBadges = buildBadges(metrics);
  const unlockedBadges = allBadges.filter((badge) => badge.unlocked);
  const xp = Math.round(
    metrics.learningTime.trueActiveStudySeconds / 60 * 10
    + metrics.learningTime.studyStreakDays * 50
    + metrics.learningProgress.completedVideos * 100
    + metrics.charts.insightCards.focusScore * 5
    + unlockedBadges.length * 35
  );
  const level = Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp)) / 3) + 1);
  const nextLevelXp = Math.pow(level * 3, 2);
  const previousLevelXp = Math.pow(Math.max(0, level - 1) * 3, 2);
  const role = level >= 25 ? 'Legend' : level >= 18 ? 'Master' : level >= 12 ? 'Expert' : level >= 7 ? 'Builder' : level >= 3 ? 'Explorer' : 'Starter';
  const coins = Math.floor(xp / 12) + unlockedBadges.length * 10;
  const achievements = [
    { key: 'learning_time', label: 'Learning Time', percent: Math.min(100, Math.round((metrics.learningTime.trueActiveStudySeconds / (10 * 60 * 60)) * 100)) },
    { key: 'consistency', label: 'Consistency Strategy', percent: metrics.charts.insightCards.consistencyScore },
    { key: 'completion', label: 'Course Completion', percent: metrics.charts.insightCards.completionRate },
    { key: 'focus', label: 'Focus Control', percent: metrics.charts.insightCards.focusScore },
    { key: 'revision', label: 'Revision Power', percent: Math.min(100, Math.round(sum(metrics.videoCompletion, (video) => video.rewatchedSeconds) / 60)) },
    { key: 'playlist', label: 'Playlist Progress', percent: metrics.playlistMetrics.length ? Math.round(sum(metrics.playlistMetrics, (playlist) => playlist.completionPercent) / metrics.playlistMetrics.length) : 0 },
  ];

  return {
    xp,
    level,
    role,
    coins,
    nextLevelXp,
    previousLevelXp,
    levelProgressPercent: Math.min(100, Math.round(((xp - previousLevelXp) / Math.max(1, nextLevelXp - previousLevelXp)) * 100)),
    badges: unlockedBadges,
    allBadges,
    lockedBadges: allBadges.filter((badge) => !badge.unlocked),
    badgeCount: unlockedBadges.length,
    totalBadgeCount: allBadges.length,
    achievements,
    strategy: {
      consistencyScore: metrics.charts.insightCards.consistencyScore,
      focusScore: metrics.charts.insightCards.focusScore,
      completionRate: metrics.charts.insightCards.completionRate,
      momentumScore: metrics.sessionQuality.studyMomentumScore,
      nextBestActions: allBadges.filter((badge) => !badge.unlocked).sort((a, b) => b.percent - a.percent).slice(0, 5),
    },
  };
}

function computeLightGameProfile({ activeStudySeconds, consistencyScore, completedVideos, completionRatePercent, focusScore, rewatchedSeconds }) {
  const xp = Math.round(
    activeStudySeconds / 60 * 10
    + consistencyScore * 50
    + completedVideos * 100
    + focusScore * 5
  );
  const level = Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp)) / 3) + 1);
  const nextLevelXp = Math.pow(level * 3, 2);
  const previousLevelXp = Math.pow(Math.max(0, level - 1) * 3, 2);
  const role = level >= 25 ? 'Legend' : level >= 18 ? 'Master' : level >= 12 ? 'Expert' : level >= 7 ? 'Builder' : level >= 3 ? 'Explorer' : 'Starter';
  const allBadges = [
    badgeDefinition('first_minute', 'First Minute', 'Time', activeStudySeconds >= 60, activeStudySeconds / 60, 1, 'Study for 1 active minute'),
    badgeDefinition('study_15m', 'Quarter Focus', 'Time', activeStudySeconds >= 15 * 60, activeStudySeconds / 60, 15, 'Study for 15 active minutes'),
    badgeDefinition('study_30m', 'Deep Start', 'Time', activeStudySeconds >= 30 * 60, activeStudySeconds / 60, 30, 'Study for 30 active minutes'),
    badgeDefinition('hour_1', 'First Study Hour', 'Time', activeStudySeconds >= 60 * 60, activeStudySeconds / 60, 60, 'Study for 1 active hour'),
    badgeDefinition('streak_1', 'Day One Streak', 'Streak', consistencyScore >= 1, consistencyScore, 1, 'Study for 1 day'),
    badgeDefinition('streak_3', '3 Day Streak', 'Streak', consistencyScore >= 3, consistencyScore, 3, 'Study 3 days in a row'),
    badgeDefinition('complete_1', 'Video Finisher', 'Completion', completedVideos >= 1, completedVideos, 1, 'Complete 1 video'),
    badgeDefinition('completion_50', '50% Course Mark', 'Completion', completionRatePercent >= 50, completionRatePercent, 50, 'Reach 50% average completion'),
    badgeDefinition('focus_75', 'Deep Focus', 'Focus', focusScore >= 75, focusScore, 75, 'Reach 75 focus score'),
    badgeDefinition('revision_15m', 'Revision Builder', 'Revision', rewatchedSeconds >= 15 * 60, rewatchedSeconds / 60, 15, 'Rewatch 15 minutes'),
  ];
  const badges = allBadges.filter((badge) => badge.unlocked);

  return {
    xp,
    level,
    role,
    coins: Math.floor(xp / 12) + badges.length * 10,
    nextLevelXp,
    previousLevelXp,
    levelProgressPercent: Math.min(100, Math.round(((xp - previousLevelXp) / Math.max(1, nextLevelXp - previousLevelXp)) * 100)),
    badges,
    allBadges,
    lockedBadges: allBadges.filter((badge) => !badge.unlocked),
    badgeCount: badges.length,
    totalBadgeCount: allBadges.length,
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
  const eventWindowStart = new Date(Date.now() - 90 * DAY_MS);
  const [user, videos, sessions, events, heatmap, summaries, playlists] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, createdAt: true } }),
    prisma.video.findMany({ include: { playlist: true } }),
    prisma.watchSession.findMany({
      where: { userId },
      orderBy: { loginAt: 'desc' },
      take: 500,
    }),
    prisma.watchEvent.findMany({
      where: { userId, serverTs: { gte: eventWindowStart } },
      orderBy: { serverTs: 'desc' },
      take: 1500,
      select: {
        eventType: true,
        videoId: true,
        videoTimeSec: true,
        fromTimeSec: true,
        toTimeSec: true,
        clientTs: true,
        serverTs: true,
      },
    }),
    prisma.videoSecondHeatmap.findMany({
      where: { userId },
      orderBy: [{ videoId: 'asc' }, { second: 'asc' }],
      select: { videoId: true, second: true, watchCount: true },
    }),
    prisma.dailyWatchSummary.findMany({
      where: { userId },
      orderBy: { date: 'asc' },
      select: {
        videoId: true,
        date: true,
        activeWatchSeconds: true,
        pauseCount: true,
        seekCount: true,
        sessionCount: true,
      },
    }),
    prisma.playlist.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] }),
  ]);

  if (!user) return null;

  sessions.reverse();
  events.reverse();
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
  const eventWindowStart = new Date(Date.now() - 30 * DAY_MS);
  const [users, videos, summaries, eventHourRows, heatmapGroups, stuckGroups, playlistRows] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.video.findMany({ select: { id: true, playlistId: true, durationSec: true } }),
    prisma.dailyWatchSummary.findMany({
      select: { userId: true, videoId: true, date: true, activeWatchSeconds: true, pauseCount: true, seekCount: true, sessionCount: true },
      orderBy: { date: 'asc' },
    }),
    prisma.$queryRaw`
      SELECT
        "userId",
        EXTRACT(HOUR FROM "serverTs" AT TIME ZONE 'UTC' AT TIME ZONE ${APP_TIME_ZONE})::int AS hour,
        COUNT(*)::int AS events,
        SUM(CASE WHEN "eventType" IN ('TAB_HIDDEN', 'WINDOW_BLUR') THEN 1 ELSE 0 END)::int AS "distractionCount",
        SUM(CASE WHEN "eventType" = 'IDLE_START' THEN 1 ELSE 0 END)::int AS "idleCount"
      FROM "WatchEvent"
      WHERE "serverTs" >= ${eventWindowStart}
      GROUP BY "userId", hour
    `,
    prisma.videoSecondHeatmap.groupBy({
      by: ['userId', 'videoId'],
      where: { watchCount: { gt: 0 } },
      _count: { second: true },
      _sum: { watchCount: true },
    }),
    prisma.videoSecondHeatmap.groupBy({
      by: ['userId'],
      where: { watchCount: { gte: 5 } },
      _count: { id: true },
    }),
    prisma.playlist.findMany({ include: { videos: true } }),
  ]);

  const videosById = Object.fromEntries(videos.map((video) => [video.id, video]));
  const summariesByUser = groupBy(summaries, (row) => row.userId);
  const eventHoursByUser = groupBy(eventHourRows, (row) => row.userId);
  const heatmapByUser = groupBy(heatmapGroups, (row) => row.userId);
  const stuckByUser = Object.fromEntries(stuckGroups.map((row) => [row.userId, row._count.id]));

  const rows = users.map((user) => {
    const userSummaries = summariesByUser[user.id] || [];
    const userEventHours = eventHoursByUser[user.id] || [];
    const userHeatmap = heatmapByUser[user.id] || [];
    const activeStudySeconds = sum(userSummaries, (row) => row.activeWatchSeconds);
    const studiedDays = userSummaries
      .filter((row) => row.activeWatchSeconds > 0)
      .map((row) => formatDateKey(row.date));
    const consistencyScore = longestStreak(studiedDays);
    const dailySeries = buildStudySeries(userSummaries, 'day');
    const hourlyDistribution = Array.from({ length: 24 }, (_, hour) => ({ hour, events: 0, activeWatchSeconds: 0 }));

    for (const row of userEventHours) {
      const hour = Number(row.hour);
      if (hour >= 0 && hour < 24) {
        hourlyDistribution[hour].events += Number(row.events || 0);
      }
    }

    const progressRows = userHeatmap.map((row) => {
      const duration = Number(videosById[row.videoId]?.durationSec || 0) || Math.max(1, row._count.second);
      const percentWatched = Math.min(100, Math.round((row._count.second / duration) * 100));
      return {
        videoId: row.videoId,
        playlistId: videosById[row.videoId]?.playlistId || 'none',
        percentWatched,
        rewatchedSeconds: Math.max(0, Number(row._sum.watchCount || 0) - row._count.second),
      };
    });
    const completionRatePercent = videos.length
      ? Math.round(sum(progressRows, (row) => row.percentWatched) / videos.length)
      : 0;
    const completedVideos = progressRows.filter((row) => row.percentWatched >= 90).length;
    const playlistProgress = playlistRows.map((playlist) => {
      const playlistVideoIds = new Set(playlist.videos.map((video) => video.id));
      const playlistProgressRows = progressRows.filter((row) => playlistVideoIds.has(row.videoId));
      const completed = playlistProgressRows.filter((row) => row.percentWatched >= 90).length;
      return playlist.videos.length ? Math.round((completed / playlist.videos.length) * 100) : 0;
    });
    const playlistProgressPercent = playlistProgress.length
      ? Math.round(sum(playlistProgress, (value) => value) / playlistProgress.length)
      : 0;
    const distractionRate = sum(userEventHours, (row) => Number(row.distractionCount || 0));
    const idleEvents = sum(userEventHours, (row) => Number(row.idleCount || 0));
    const rewatchedSeconds = sum(progressRows, (row) => row.rewatchedSeconds);
    const focusScore = Math.max(0, Math.min(100, activeStudySeconds ? 100 - distractionRate * 2 - idleEvents * 5 : 0));

    return {
      user,
      publicLearnerId: publicLearnerId(user.id),
      activeStudySeconds,
      consistencyScore,
      playlistProgressPercent,
      completionRatePercent,
      distractionRate,
      lowCompletion: completionRatePercent < 50,
      highDistraction: distractionRate >= 5,
      stuckSegments: stuckByUser[user.id] || 0,
      dailySeries,
      hourlyDistribution,
      radar: {
        focus: focusScore,
        completion: completionRatePercent,
        consistency: Math.min(100, consistencyScore * 10),
        rewatch: Math.min(100, Math.round(rewatchedSeconds / 10)),
        idle: Math.max(0, 100 - idleEvents * 10),
      },
      game: computeLightGameProfile({
        activeStudySeconds,
        consistencyScore,
        completedVideos,
        completionRatePercent,
        focusScore,
        rewatchedSeconds,
      }),
    };
  });

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
  const cohortMap = {};
  for (const user of users) {
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
      role: row.game?.role || 'Starter',
      coins: row.game?.coins || 0,
      badgeCount: row.game?.badgeCount || row.game?.badges?.length || 0,
      totalBadgeCount: row.game?.totalBadgeCount || row.game?.allBadges?.length || row.game?.badges?.length || 0,
      badges: row.game?.badges || [],
      rankScore: row.activeStudySeconds + row.consistencyScore * 60 + row.completionRatePercent * 30,
    })).sort((a, b) => b.rankScore - a.rankScore),
  };
}
