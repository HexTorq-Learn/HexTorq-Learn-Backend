import { prisma } from '../prisma.js';
import { emitNotification } from '../realtime.js';
import { sendMail, isMailerConfigured } from './mailer.js';
import { startOfUtcDay } from './analytics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_INTERVAL_MS = Number(process.env.NOTIFICATION_SCAN_INTERVAL_MS || 6 * 60 * 60 * 1000);
const NOTIFICATION_COOLDOWN_MS = Number(process.env.NOTIFICATION_COOLDOWN_MS || 20 * 60 * 60 * 1000);

let scanTimer = null;

export async function hasRecentNotification(userId, type, withinMs = NOTIFICATION_COOLDOWN_MS) {
  const since = new Date(Date.now() - withinMs);
  const existing = await prisma.notification.findFirst({
    where: { userId, type, createdAt: { gte: since } },
    select: { id: true },
  });
  return Boolean(existing);
}

// Creates the in-portal notification immediately (always) and fires the email
// in the background if channel requests it and SMTP is configured -- the
// portal notification never waits on (or fails because of) email delivery.
export async function createNotification({ userId, type, severity = 'medium', title, message, channel = 'portal', email }) {
  const notification = await prisma.notification.create({
    data: { userId, type, severity, title, message, channel },
  });

  emitNotification(userId, notification);

  if ((channel === 'email' || channel === 'both') && email && isMailerConfigured()) {
    sendMail({ to: email, subject: title, text: message })
      .then(() => prisma.notification.update({ where: { id: notification.id }, data: { emailSentAt: new Date() } }))
      .catch((error) => {
        console.error('Failed to send notification email', error);
        return prisma.notification.update({ where: { id: notification.id }, data: { emailError: error.message } }).catch(() => {});
      });
  }

  return notification;
}

async function maybeNotify(user, type, severity, title, message) {
  const recent = await hasRecentNotification(user.id, type);
  if (recent) return;
  await createNotification({ userId: user.id, type, severity, title, message, channel: 'both', email: user.email });
}

// Scans for the same alert conditions computeAlerts() surfaces to admins
// (inactive_user, below_daily_target, focus_loss), but as a lightweight
// cross-user scan (grouped queries, not a full per-user metrics computation)
// so it can run on an interval for every user without recomputing everything
// getAdvancedUserMetrics does.
export async function runNotificationScan() {
  const users = await prisma.user.findMany({ select: { id: true, email: true, createdAt: true } });
  if (!users.length) return;

  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * DAY_MS);
  const oneDayAgo = new Date(now - DAY_MS);
  const yesterdayStart = startOfUtcDay(new Date(now - DAY_MS));
  const yesterdayEnd = startOfUtcDay(new Date(now));

  const [lastEventByUser, focusLossByUser, yesterdaySummaries] = await Promise.all([
    prisma.watchEvent.groupBy({ by: ['userId'], _max: { serverTs: true } }),
    prisma.watchEvent.groupBy({
      by: ['userId'],
      where: { serverTs: { gte: oneDayAgo }, eventType: { in: ['TAB_HIDDEN', 'WINDOW_BLUR'] } },
      _count: { id: true },
    }),
    prisma.dailyWatchSummary.groupBy({
      by: ['userId'],
      where: { date: { gte: yesterdayStart, lt: yesterdayEnd } },
      _sum: { activeWatchSeconds: true },
    }),
  ]);

  const lastEventMap = Object.fromEntries(lastEventByUser.map((row) => [row.userId, row._max.serverTs]));
  const focusLossMap = Object.fromEntries(focusLossByUser.map((row) => [row.userId, row._count.id]));
  const yesterdayMap = Object.fromEntries(yesterdaySummaries.map((row) => [row.userId, row._sum.activeWatchSeconds || 0]));

  for (const user of users) {
    const lastEvent = lastEventMap[user.id];
    const hasHistory = Boolean(lastEvent);

    try {
      if ((!lastEvent || lastEvent < threeDaysAgo) && user.createdAt < threeDaysAgo) {
        await maybeNotify(
          user,
          'inactive_user',
          'high',
          'We miss you!',
          "You haven't studied in 3 or more days. Jump back in to keep your streak alive.",
        );
      }

      if (hasHistory && (yesterdayMap[user.id] || 0) < 30 * 60) {
        await maybeNotify(
          user,
          'below_daily_target',
          'medium',
          'Below your daily goal',
          'You watched less than 30 active minutes yesterday. Try to hit your 1-hour daily goal today.',
        );
      }

      if ((focusLossMap[user.id] || 0) >= 5) {
        await maybeNotify(
          user,
          'focus_loss',
          'medium',
          'Lots of distractions',
          "You've switched away from the tab frequently in the last day. Try a focused study session.",
        );
      }
    } catch (error) {
      console.error(`Failed to evaluate notifications for user ${user.id}`, error);
    }
  }
}

export function startNotificationScanJob() {
  if (scanTimer) return;
  runNotificationScan().catch((error) => console.error('Initial notification scan failed', error));
  scanTimer = setInterval(() => {
    runNotificationScan().catch((error) => console.error('Notification scan crashed', error));
  }, SCAN_INTERVAL_MS);
  scanTimer.unref?.();
}

export function stopNotificationScanJob() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}
