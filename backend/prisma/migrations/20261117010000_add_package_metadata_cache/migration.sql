-- CreateTable
CREATE TABLE "package_metadata" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "package_id" VARCHAR(256) NOT NULL,
    "version" VARCHAR(128) NOT NULL,
    "publisher" VARCHAR(256),
    "homepage_url" VARCHAR(2048),
    "release_notes_url" VARCHAR(2048),
    "release_notes_summary" TEXT,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "fetch_status" VARCHAR(50) NOT NULL DEFAULT 'success',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "package_metadata_package_id_version_key" ON "package_metadata"("package_id", "version");

-- CreateIndex
CREATE INDEX "package_metadata_package_id_idx" ON "package_metadata"("package_id");

-- CreateIndex
CREATE INDEX "package_metadata_expires_at_idx" ON "package_metadata"("expires_at");
