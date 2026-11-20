-- AlterTable
ALTER TABLE "applications" ADD COLUMN "match_status" VARCHAR(50) NOT NULL DEFAULT 'pending',
ADD COLUMN "match_reason" VARCHAR(100),
ADD COLUMN "match_method" VARCHAR(50) NOT NULL DEFAULT 'none',
ADD COLUMN "matched_package_id" VARCHAR(256),
ADD COLUMN "match_confidence" DOUBLE PRECISION,
ADD COLUMN "matched_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "applications_device_id_match_status_idx" ON "applications"("device_id", "match_status");
