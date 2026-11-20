-- AlterTable
ALTER TABLE "scan_jobs" ADD COLUMN "matched_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "ambiguous_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "unsupported_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "applications" ADD COLUMN "candidates" JSONB DEFAULT '[]'::jsonb;
