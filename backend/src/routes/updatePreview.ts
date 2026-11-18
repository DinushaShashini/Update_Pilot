import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { PackageMetadata } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { sanitizeHttpsUrl } from '../security/sanitizer.js';

export const updatePreviewRouter = Router();

// POST /api/updates/preview & /api/v1/updates/preview
updatePreviewRouter.post(
  ['/updates/preview', '/v1/updates/preview'],
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const { applicationId, deviceId } = req.body ?? {};

    if (!applicationId || typeof applicationId !== 'string') {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'applicationId is required and must be a string' },
      });
      return;
    }

    if (!deviceId || typeof deviceId !== 'string') {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'deviceId is required and must be a string' },
      });
      return;
    }

    try {
      // 1. Look up device and verify ownership
      const device = await prisma.device.findUnique({
        where: { id: deviceId },
      });

      if (!device || device.userId !== user.id) {
        res.status(404).json({
          success: false,
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
        });
        return;
      }

      // 2. Look up application and verify it belongs to the device
      const application = await prisma.application.findUnique({
        where: { id: applicationId },
      });

      if (!application || application.deviceId !== device.id) {
        res.status(404).json({
          success: false,
          error: { code: 'APPLICATION_NOT_FOUND', message: 'Application not found on this device' },
        });
        return;
      }

      // 3. Verify update availability and match status
      if (application.matchStatus && application.matchStatus !== 'matched') {
        res.status(400).json({
          success: false,
          error: { code: 'APP_NOT_MATCHED', message: 'Application is not matched to a supported package' },
        });
        return;
      }

      if (application.updateStatus !== 'update_available' || !application.availableVersion) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_UPDATE_AVAILABLE', message: 'No update is available for this application' },
        });
        return;
      }

      const pkgId = application.matchedPackageId || application.packageId || application.name;
      const targetVersion = application.availableVersion;
      const installedVersion = application.installedVersion;
      const source = application.source || 'winget';

      // 4. Look up cached package metadata
      let metadata: PackageMetadata | null = null;
      try {
        if (prisma.packageMetadata && pkgId) {
          metadata = await prisma.packageMetadata.findFirst({
            where: {
              packageId: pkgId,
              version: targetVersion,
            },
          });

          if (!metadata) {
            metadata = await prisma.packageMetadata.findFirst({
              where: { packageId: pkgId },
              orderBy: { fetchedAt: 'desc' },
            });
          }
        }
      } catch {
        metadata = null;
      }

      // 5. Build contextual warnings
      const warnings: string[] = [];
      if (device.status !== 'ONLINE') {
        warnings.push('device is offline');
      }

      const hasReleaseNotes = Boolean(metadata?.releaseNotesSummary || metadata?.releaseNotesUrl);
      if (!hasReleaseNotes) {
        warnings.push('release notes missing');
      }

      // Standard warning for desktop application updates
      warnings.push('app may need to close');

      // 6. Source link and publisher
      let sourceLink: string | null = null;
      if (metadata?.homepageUrl) {
        const sanitized = sanitizeHttpsUrl(metadata.homepageUrl);
        if (sanitized.valid && sanitized.url) {
          sourceLink = sanitized.url;
        }
      }

      const publisher = metadata?.publisher || application.publisher || 'Unknown';

      // 7. Generate random, single-use, 5-minute confirmation token
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      // 8. Store UpdatePreview in database
      const preview = await prisma.updatePreview.create({
        data: {
          userId: user.id,
          deviceId: device.id,
          applicationId: application.id,
          packageId: pkgId,
          installedVersion,
          targetVersion,
          source,
          tokenHash,
          expiresAt,
        },
      });

      // 9. Respond with preview details and confirmation token
      res.status(201).json({
        success: true,
        data: {
          id: preview.id,
          previewId: preview.id,
          package: pkgId,
          packageId: pkgId,
          applicationName: application.name,
          installedVersion,
          targetVersion,
          publisher,
          sourceLink,
          deviceName: device.name || device.hostname,
          warnings,
          expiresAt: expiresAt.toISOString(),
          confirmationToken: rawToken,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);
