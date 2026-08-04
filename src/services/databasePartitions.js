import { prisma } from '../prisma.js';

const PARTITION_WEEKS_AHEAD = Number(process.env.WATCH_EVENT_PARTITION_WEEKS_AHEAD || 12);
const PARTITION_WEEKS_BACK = Number(process.env.WATCH_EVENT_PARTITION_WEEKS_BACK || 1);
const PARTITION_REFRESH_MS = Number(process.env.WATCH_EVENT_PARTITION_REFRESH_MS || 24 * 60 * 60 * 1000);

let partitionTimer = null;

function startOfUtcWeek(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - day + 1);
  return start;
}

function addWeeks(date, weeks) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + weeks * 7);
  return next;
}

function partitionName(start) {
  const stamp = start.toISOString().slice(0, 10).replace(/-/g, '_');
  return `WatchEvent_${stamp}`;
}

function quotedIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function isWatchEventPartitioned() {
  const rows = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1
      FROM pg_partitioned_table pt
      JOIN pg_class c ON c.oid = pt.partrelid
      WHERE c.relname = 'WatchEvent'
    ) AS "isPartitioned"
  `;
  return Boolean(rows[0]?.isPartitioned);
}

async function createDefaultPartition() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WatchEvent_default"
    PARTITION OF "WatchEvent" DEFAULT
  `);
}

async function createWeeklyPartition(start) {
  const end = addWeeks(start, 1);
  const name = quotedIdentifier(partitionName(start));
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${name}
    PARTITION OF "WatchEvent"
    FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')
  `);
}

export async function ensureWatchEventWeeklyPartitions() {
  const startedAt = Date.now();
  const partitioned = await isWatchEventPartitioned();

  if (!partitioned) {
    console.log(JSON.stringify({
      project: 'HexTorq Learn Backend',
      task: 'ensureWatchEventWeeklyPartitions',
      status: 'skipped',
      reason: 'WatchEvent is not a partitioned table yet. Run scripts/partition-watch-events-weekly.sql during maintenance.',
      durationMs: Date.now() - startedAt,
    }));
    return;
  }

  const currentWeek = startOfUtcWeek();
  await createDefaultPartition();

  let createdOrConfirmed = 0;
  for (let offset = -PARTITION_WEEKS_BACK; offset <= PARTITION_WEEKS_AHEAD; offset += 1) {
    await createWeeklyPartition(addWeeks(currentWeek, offset));
    createdOrConfirmed += 1;
  }

  console.log(JSON.stringify({
    project: 'HexTorq Learn Backend',
    task: 'ensureWatchEventWeeklyPartitions',
    status: 'ok',
    weeklyPartitions: createdOrConfirmed,
    durationMs: Date.now() - startedAt,
  }));
}

export function startWatchEventPartitionJob() {
  if (partitionTimer) return;

  ensureWatchEventWeeklyPartitions().catch((error) => {
    console.error('Failed to ensure WatchEvent weekly partitions', error);
  });

  partitionTimer = setInterval(() => {
    ensureWatchEventWeeklyPartitions().catch((error) => {
      console.error('Failed to ensure WatchEvent weekly partitions', error);
    });
  }, PARTITION_REFRESH_MS);

  partitionTimer.unref?.();
}
