-- AlterTable
ALTER TABLE "applications" ADD COLUMN "update_status" VARCHAR(30) NOT NULL DEFAULT 'not_checked',
ADD COLUMN "update_checked_at" TIMESTAMPTZ(6);
