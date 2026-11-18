-- CreateTable
CREATE TABLE "update_previews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "package_id" VARCHAR(256) NOT NULL,
    "installed_version" VARCHAR(128) NOT NULL,
    "target_version" VARCHAR(128) NOT NULL,
    "source" VARCHAR(50) NOT NULL DEFAULT 'winget',
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "update_previews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "update_previews_user_id_device_id_idx" ON "update_previews"("user_id", "device_id");

-- CreateIndex
CREATE INDEX "update_previews_token_hash_idx" ON "update_previews"("token_hash");

-- CreateIndex
CREATE INDEX "update_previews_expires_at_idx" ON "update_previews"("expires_at");

-- AddForeignKey
ALTER TABLE "update_previews" ADD CONSTRAINT "update_previews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "update_previews" ADD CONSTRAINT "update_previews_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "update_previews" ADD CONSTRAINT "update_previews_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
