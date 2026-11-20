-- AlterTable
ALTER TABLE "scan_jobs" ADD COLUMN "progress_message" VARCHAR(256),
ADD COLUMN "skipped_steps" JSONB DEFAULT '[]'::jsonb;
