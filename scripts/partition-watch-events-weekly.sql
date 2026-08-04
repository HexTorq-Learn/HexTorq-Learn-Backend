-- One-time maintenance migration for PostgreSQL native weekly partitioning.
-- Run during low traffic after taking a DB backup.
-- This rewrites "WatchEvent" into a partitioned table by "serverTs".

BEGIN;

LOCK TABLE "WatchEvent" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "WatchEvent" RENAME TO "WatchEvent_legacy";

CREATE TABLE "WatchEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "videoId" TEXT NOT NULL,
  "sessionId" TEXT,
  "eventType" "WatchEventType" NOT NULL,
  "videoTimeSec" DOUBLE PRECISION,
  "fromTimeSec" DOUBLE PRECISION,
  "toTimeSec" DOUBLE PRECISION,
  "clientTs" TIMESTAMP(3) NOT NULL,
  "serverTs" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB
) PARTITION BY RANGE ("serverTs");

CREATE TABLE "WatchEvent_default" PARTITION OF "WatchEvent" DEFAULT;

CREATE INDEX "WatchEvent_id_idx" ON "WatchEvent" ("id");
CREATE INDEX "WatchEvent_userId_videoId_serverTs_idx" ON "WatchEvent" ("userId", "videoId", "serverTs");
CREATE INDEX "WatchEvent_serverTs_idx" ON "WatchEvent" ("serverTs");
CREATE INDEX "WatchEvent_userId_serverTs_idx" ON "WatchEvent" ("userId", "serverTs");
CREATE INDEX "WatchEvent_videoId_serverTs_idx" ON "WatchEvent" ("videoId", "serverTs");
CREATE INDEX "WatchEvent_userId_eventType_serverTs_idx" ON "WatchEvent" ("userId", "eventType", "serverTs");
CREATE INDEX "WatchEvent_eventType_idx" ON "WatchEvent" ("eventType");

DO $$
DECLARE
  partition_start DATE;
  partition_end DATE;
  max_week DATE;
  partition_name TEXT;
BEGIN
  SELECT date_trunc('week', COALESCE(MIN("serverTs"), CURRENT_TIMESTAMP))::date
  INTO partition_start
  FROM "WatchEvent_legacy";

  SELECT date_trunc('week', COALESCE(MAX("serverTs"), CURRENT_TIMESTAMP))::date + INTERVAL '12 weeks'
  INTO max_week
  FROM "WatchEvent_legacy";

  WHILE partition_start <= max_week LOOP
    partition_end := partition_start + INTERVAL '1 week';
    partition_name := 'WatchEvent_' || to_char(partition_start, 'YYYY_MM_DD');

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "WatchEvent" FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      partition_start::timestamp,
      partition_end::timestamp
    );

    partition_start := partition_end;
  END LOOP;
END $$;

ALTER TABLE "WatchEvent"
  ADD CONSTRAINT "WatchEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WatchEvent"
  ADD CONSTRAINT "WatchEvent_videoId_fkey"
  FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WatchEvent"
  ADD CONSTRAINT "WatchEvent_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "WatchSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "WatchEvent" (
  "id",
  "userId",
  "videoId",
  "sessionId",
  "eventType",
  "videoTimeSec",
  "fromTimeSec",
  "toTimeSec",
  "clientTs",
  "serverTs",
  "metadata"
)
SELECT
  "id",
  "userId",
  "videoId",
  "sessionId",
  "eventType",
  "videoTimeSec",
  "fromTimeSec",
  "toTimeSec",
  "clientTs",
  "serverTs",
  "metadata"
FROM "WatchEvent_legacy";

COMMIT;

-- After confirming the app works and counts match:
-- SELECT COUNT(*) FROM "WatchEvent";
-- SELECT COUNT(*) FROM "WatchEvent_legacy";
-- DROP TABLE "WatchEvent_legacy";
