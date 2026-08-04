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
