import { Router, type Request, type Response } from 'express';
import express from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAgent } from '../middleware/auth.js';
import { upsertPackageMetadata, calculateExpiry } from '../metadata/cache.js';

export const agentMetadataRouter = Router();

const metadataResultsBodyLimit = express.json({ limit: '2mb' });

const packageMetadataItemSchema = z.object({
  package_id: z.string().min(1).max(256),
  version: z.string().max(128).nullable().optional(),
  publisher: z.string().max(256).nullable().optional(),
  homepage_url: z.string().max(2048).nullable().optional(),
  publisher_url: z.string().max(2048).nullable().optional(),
  release_notes_url: z.string().max(2048).nullable().optional(),
  release_notes_text: z.string().max(65536).nullable().optional(),
  installer_type: z.string().max(50).nullable().optional(),
  fetch_status: z.enum(['success', 'not_found', 'timeout', 'error']).default('success'),
  error: z.string().max(1024).nullable().optional(),
});

const metadataResultsPayloadSchema = z.object({
  packages: z.array(packageMetadataItemSchema).max(20),
  fetched_at: z.string().optional(),
  warnings: z.array(z.string().max(500)).max(100).optional().default([]),
  errors: z.array(z.string().max(500)).max(100).optional().default([]),
});

const metadataFailurePayloadSchema = z.object({
  error_code: z.number().int().optional().default(1),
  error_message: z.string().min(1).max(1000),
});

// POST /api/agent/metadata/:id/results - Submit metadata fetch results
agentMetadataRouter.post(
  '/agent/metadata/:id/results',
  metadataResultsBodyLimit,
  requireAgent,
  async (req: Request, res: Response): Promise<void> => {
    const jobId = String(req.params.id);
    const device = req.agentDevice!;

    try {
      const job = await prisma.scanJob.findFirst({
        where: { id: jobId, deviceId: device.id, type: 'get_package_metadata' },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'JOB_NOT_FOUND', message: 'Metadata job not found for this device' },
        });
        return;
      }

      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) {
        res.status(409).json({
          success: false,
          error: { code: 'JOB_ALREADY_FINISHED', message: `Job has already finished with status '${job.status}'` },
        });
        return;
      }

      if (job.status !== 'running') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_JOB_STATE', message: `Job must be 'running' to submit results (current: '${job.status}')` },
        });
        return;
      }

      const parseResult = metadataResultsPayloadSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid metadata result payload',
            details: parseResult.error.format(),
          },
        });
        return;
      }

      const { packages } = parseResult.data;
      const now = new Date();

      // Find the available versions of apps on this device for fallback if version was not parsed
      const deviceApps = await prisma.application.findMany({
        where: { deviceId: device.id, isInstalled: true },
      });
      const appVerMap = new Map<string, string>();
      for (const app of deviceApps) {
        const pkgId = (app.matchedPackageId || app.packageId || '').toLowerCase();
        if (pkgId && app.availableVersion) {
          appVerMap.set(pkgId, app.availableVersion);
        }
      }

      await prisma.$transaction(async (tx) => {
        for (const item of packages) {
          const pkgId = item.package_id.trim();
          const ver = (item.version || appVerMap.get(pkgId.toLowerCase()) || 'unknown').trim();

          const isSuccess = item.fetch_status === 'success';
          // If fetch failed or not found, use a shorter expiry (e.g. 1 hour) instead of full 24h
          const expiry = isSuccess ? calculateExpiry(now) : new Date(now.getTime() + 1 * 60 * 60 * 1000);

          await upsertPackageMetadata(
            {
              packageId: pkgId,
              version: ver,
              publisher: item.publisher,
              homepageUrl: item.homepage_url,
              releaseNotesUrl: item.release_notes_url,
              releaseNotesSummary: item.release_notes_text,
              fetchStatus: isSuccess ? 'success' : item.fetch_status === 'not_found' ? 'not_found' : 'failed',
              fetchedAt: now,
              expiresAt: expiry,
            },
            tx
          );
        }

        const summaryMessage = `Metadata fetched for ${packages.length} packages`;

        await tx.scanJob.update({
          where: { id: jobId },
          data: {
            status: 'succeeded',
            finishedAt: now,
            appCount: packages.length,
            progressPercent: 100,
            progressStep: 'completed',
            progressMessage: summaryMessage,
            errorCode: 0,
          },
        });

        await tx.device.update({
          where: { id: device.id },
          data: { lastSeenAt: now },
        });

        await tx.auditEvent.create({
          data: {
            deviceId: device.id,
            eventType: 'METADATA_JOB_SUCCEEDED',
            entityType: 'scan_jobs',
            entityId: jobId,
            metadata: {
              packageCount: packages.length,
            },
          },
        });
      });

      res.status(200).json({
        success: true,
        data: {
          jobId,
          status: 'succeeded',
          packageCount: packages.length,
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

// POST /api/agent/metadata/:id/failure - Report failed metadata job
agentMetadataRouter.post(
  '/agent/metadata/:id/failure',
  express.json(),
  requireAgent,
  async (req: Request, res: Response): Promise<void> => {
    const jobId = String(req.params.id);
    const device = req.agentDevice!;

    try {
      const job = await prisma.scanJob.findFirst({
        where: { id: jobId, deviceId: device.id, type: 'get_package_metadata' },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'JOB_NOT_FOUND', message: 'Metadata job not found for this device' },
        });
        return;
      }

      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) {
        res.status(409).json({
          success: false,
          error: { code: 'JOB_ALREADY_FINISHED', message: `Job already finished with status '${job.status}'` },
        });
        return;
      }

      const parseResult = metadataFailurePayloadSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid failure payload' },
        });
        return;
      }

      const { error_code, error_message } = parseResult.data;
      const now = new Date();

      await prisma.$transaction([
        prisma.scanJob.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            finishedAt: now,
            errorCode: error_code,
            errorMessage: error_message,
            progressStep: 'failed',
            progressMessage: `Failed: ${error_message}`,
          },
        }),
        prisma.device.update({
          where: { id: device.id },
          data: { lastSeenAt: now },
        }),
        prisma.auditEvent.create({
          data: {
            deviceId: device.id,
            eventType: 'METADATA_JOB_FAILED',
            entityType: 'scan_jobs',
            entityId: jobId,
            metadata: { error_code, error_message },
          },
        }),
      ]);

      res.status(200).json({
        success: true,
        data: { jobId, status: 'failed' },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);
