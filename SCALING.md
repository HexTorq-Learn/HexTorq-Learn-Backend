# HexTorq Learn Scaling Notes

## Tracking Queue

Tracking writes are buffered in-process and flushed in batches.

```env
TRACKING_QUEUE_FLUSH_MS=3000
TRACKING_QUEUE_BATCH_SIZE=1000
TRACKING_QUEUE_MAX_SIZE=50000
TRACKING_REALTIME_RECOMPUTE_MS=10000
```

This reduces direct write pressure on Postgres. Because it is in-process memory, a hard crash can lose the last few seconds of queued tracking data.

## WatchEvent Weekly Partitioning

The backend automatically maintains weekly partitions only after `"WatchEvent"` has been converted to a partitioned table.

Automatic partition settings:

```env
WATCH_EVENT_PARTITION_WEEKS_BACK=1
WATCH_EVENT_PARTITION_WEEKS_AHEAD=12
WATCH_EVENT_PARTITION_REFRESH_MS=86400000
```

One-time conversion script:

```bash
psql "$DATABASE_URL" -f scripts/partition-watch-events-weekly.sql
```

Run this during low traffic after a database backup. The script keeps the old table as `"WatchEvent_legacy"` until counts are verified.

## PgBouncer

PgBouncer is external infrastructure, not Node code. The app uses the same Prisma client; point `DATABASE_URL` at PgBouncer instead of Postgres.

Example:

```env
DATABASE_URL="postgresql://USER:PASSWORD@127.0.0.1:6432/db_hextorq_learn?pgbouncer=true&connection_limit=5"
```

Recommended topology:

```text
Node/PM2 instances -> PgBouncer -> PostgreSQL
```

Use PgBouncer transaction pooling for many simultaneous users. Keep the direct Postgres URL available only for maintenance tasks that need a normal session connection.
