-- AlterTable: add next_retry_at for exponential backoff on failed outbox events
ALTER TABLE "outbox_events" ADD COLUMN "nextRetryAt" TIMESTAMP(3);
