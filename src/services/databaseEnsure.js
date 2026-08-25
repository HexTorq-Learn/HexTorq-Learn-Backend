import { prisma } from '../prisma.js';

export async function ensureUserContactColumns() {
  await prisma.$executeRawUnsafe('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT');
  await prisma.$executeRawUnsafe('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT');
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username")');
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_key" ON "User"("phone")');
}

export async function ensureAdvancedMetricsSnapshotTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AdvancedMetricsSnapshot" (
      "userId" TEXT PRIMARY KEY,
      "metrics" JSONB NOT NULL,
      "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "AdvancedMetricsSnapshot_calculatedAt_idx" ON "AdvancedMetricsSnapshot"("calculatedAt")');
}

export async function ensureNotificationsTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Notification" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
      "type" TEXT NOT NULL,
      "severity" TEXT NOT NULL DEFAULT 'medium',
      "title" TEXT NOT NULL,
      "message" TEXT NOT NULL,
      "channel" TEXT NOT NULL DEFAULT 'portal',
      "read" BOOLEAN NOT NULL DEFAULT false,
      "emailSentAt" TIMESTAMP(3),
      "emailError" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "Notification_userId_type_createdAt_idx" ON "Notification"("userId", "type", "createdAt")');
}

export async function ensurePortalActivityTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PortalSession" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
      "loginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "logoutAt" TIMESTAMP(3),
      "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "userAgent" TEXT,
      "ipAddress" TEXT
    )
  `);
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "PortalSession_userId_loginAt_idx" ON "PortalSession"("userId", "loginAt")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "PortalSession_lastSeenAt_idx" ON "PortalSession"("lastSeenAt")');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PortalActivityEvent" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
      "sessionId" TEXT REFERENCES "PortalSession"("id") ON DELETE SET NULL,
      "eventType" TEXT NOT NULL,
      "clientTs" TIMESTAMP(3) NOT NULL,
      "serverTs" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "metadata" JSONB
    )
  `);
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "PortalActivityEvent_userId_serverTs_idx" ON "PortalActivityEvent"("userId", "serverTs")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "PortalActivityEvent_serverTs_idx" ON "PortalActivityEvent"("serverTs")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "PortalActivityEvent_userId_eventType_serverTs_idx" ON "PortalActivityEvent"("userId", "eventType", "serverTs")');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "DailyPortalSummary" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
      "date" TIMESTAMP(3) NOT NULL,
      "activeSeconds" INTEGER NOT NULL DEFAULT 0,
      "idleSeconds" INTEGER NOT NULL DEFAULT 0,
      "loginCount" INTEGER NOT NULL DEFAULT 0,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "DailyPortalSummary_userId_date_key" ON "DailyPortalSummary"("userId", "date")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "DailyPortalSummary_userId_date_idx" ON "DailyPortalSummary"("userId", "date")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "DailyPortalSummary_date_idx" ON "DailyPortalSummary"("date")');
}
