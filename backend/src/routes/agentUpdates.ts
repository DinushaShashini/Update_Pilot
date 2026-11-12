import { Router, type Request, type Response } from 'express';
import express from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAgent } from '../middleware/auth.js';

export const agentUpdateRouter = Router();

// 2MB payload size limit for update check results
const updateResultsBodyLimit = express.json({ limit: '2mb' });

const updateCandidateSchema = z.object({
  name: z.string().max(256).optional(),
  package_id: z.string().min(1).max(256),
  installed_version: z.string().max(128).optional().default('unknown'),
  available_version: z.string().max(128),
  source: z.string().max(50).nullable().optional(),
  pinned: z.boolean().optional().default(false),
  truncated: z.boolean().optional().default(false),
});

const updateCheckResultPayloadSchema = z.object({
  winget_available: z.boolean().optional().default(true),
  updates: z.array(updateCandidateSchema).max(5000),
  warnings: z.array(z.string().max(500)).max(100).optional().default([]),
  errors: z.array(z.string().max(500)).max(100).optional().default([]),
});

const updateCheckFailureSchema = z.object({
  error_code: z.number().int().optional().default(1),
  error_message: z.string().min(1).max(1000),
});

function isUnknownVersion(ver: string | null | undefined): boolean {
  if (!ver) return true;
  const trimmed = ver.trim().toLowerCase();
  return !trimmed || trimmed === 'unknown';
}

// POST /api/agent/update-checks/:id/results - Validate & store update check results in one transaction
agentUpdateRouter.post(
  '/agent/update-checks/:id/results',
  updateResultsBodyLimit,
  requireAgent,
  async (req: Request, res: Response): Promise<void> => {
    const jobId = String(req.params.id);
    const device = req.agentDevice!;

    const parseResult = updateCheckResultPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Malformed update-check result payload',
          details: parseResult.error.format(),
        },
      });
      return;
    }

    const { winget_available, updates } = parseResult.data;

    try {
      const job = await prisma.scanJob.findFirst({
        where: {
          id: jobId,
          deviceId: device.id,
          type: 'check_updates',
        },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'JOB_NOT_FOUND', message: 'Update-check job not found for this device' },
        });
        return;
      }

      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'timed_out') {
        res.status(409).json({
          success: false,
          error: {
            code: 'JOB_ALREADY_FINISHED',
            message: `Cannot submit results for job in terminal '${job.status}' state`,
          },
        });
        return;
      }

      if (job.status !== 'running') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_JOB_STATE',
            message: `Job must be 'running' to submit results (current: '${job.status}')`,
          },
        });
        return;
      }

      const now = new Date();

      const stats = await prisma.$transaction(async (tx) => {
        // Match by package ID to the device's MATCHED installed apps ONLY
        const matchedApps = await tx.application.findMany({
          where: {
            deviceId: device.id,
            isInstalled: true,
            matchStatus: 'matched',
          },
        });

        const matchedByPkgId = new Map<string, (typeof matchedApps)[number]>();
        for (const app of matchedApps) {
          const pkgId = app.matchedPackageId || app.packageId;
          if (pkgId) {
            matchedByPkgId.set(pkgId.toLowerCase(), app);
          }
        }

        const seenAppIds = new Set<string>();
        let updatesAvailableCount = 0;
        let unknownCount = 0;

        for (const upd of updates) {
          const matchedApp = matchedByPkgId.get(upd.package_id.toLowerCase());
          // Ignore unknown package IDs or non-matched apps
          if (!matchedApp) {
            continue;
          }

          seenAppIds.add(matchedApp.id);

          if (isUnknownVersion(upd.available_version) || isUnknownVersion(upd.installed_version)) {
            unknownCount++;
            await tx.application.update({
              where: { id: matchedApp.id },
              data: {
                updateStatus: 'unknown',
                availableVersion: null,
                updateCheckedAt: now,
              },
            });
          } else {
            updatesAvailableCount++;
            await tx.application.update({
              where: { id: matchedApp.id },
              data: {
                updateStatus: 'update_available',
                availableVersion: upd.available_version.trim(),
                updateCheckedAt: now,
              },
            });
          }
        }

        // Remaining matched apps not in `updates`: mark up_to_date (or unknown if WinGet unavailable)
        const remainingIds = matchedApps
          .filter((a) => !seenAppIds.has(a.id))
          .map((a) => a.id);

        if (remainingIds.length > 0) {
          const fallbackStatus = winget_available ? 'up_to_date' : 'unknown';
          if (!winget_available) {
            unknownCount += remainingIds.length;
          }
          await tx.application.updateMany({
            where: {
              id: { in: remainingIds },
              deviceId: device.id,
            },
            data: {
              updateStatus: fallbackStatus,
              availableVersion: null,
              updateCheckedAt: now,
            },
          });
        }

        const checkedCount = matchedApps.length;
        const summaryMessage = `${checkedCount} matched apps checked: ${updatesAvailableCount} updates available, ${unknownCount} unknown`;

        await tx.scanJob.update({
          where: { id: jobId },
          data: {
            status: 'succeeded',
            finishedAt: now,
            appCount: updatesAvailableCount,
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
            eventType: 'UPDATE_CHECK_SUCCEEDED',
            entityType: 'scan_jobs',
            entityId: jobId,
            metadata: {
              checkedCount,
              updatesAvailableCount,
              unknownCount,
              ignoredCount: updates.length - seenAppIds.size,
            },
          },
        });

        return { checkedCount, updatesAvailableCount, unknownCount };
      });

      res.status(200).json({
        success: true,
        data: {
          jobId,
          status: 'succeeded',
          checkedCount: stats.checkedCount,
          updatesAvailableCount: stats.updatesAvailableCount,
          unknownCount: stats.unknownCount,
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

// POST /api/agent/update-checks/:id/failure - Report a failed update-check job
agentUpdateRouter.post(
  '/agent/update-checks/:id/failure',
  express.json(),
  requireAgent,
  async (req: Request, res: Response): Promise<void> => {
    const jobId = String(req.params.id);
    const device = req.agentDevice!;

    const parseResult = updateCheckFailureSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid failure payload' },
      });
      return;
    }

    const { error_code, error_message } = parseResult.data;

    try {
      const job = await prisma.scanJob.findFirst({
        where: {
          id: jobId,
          deviceId: device.id,
          type: 'check_updates',
        },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'JOB_NOT_FOUND', message: 'Update-check job not found for this device' },
        });
        return;
      }

      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'timed_out') {
        res.status(409).json({
          success: false,
          error: {
            code: 'JOB_ALREADY_FINISHED',
            message: `Cannot report failure for job in '${job.status}' state`,
          },
        });
        return;
      }

      if (job.status !== 'running') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_JOB_STATE', message: 'Job must be running to report failure' },
        });
        return;
      }

      const now = new Date();

      await prisma.$transaction([
        prisma.scanJob.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            finishedAt: now,
            errorCode: error_code,
            errorMessage: error_message.slice(0, 1000),
          },
        }),
        prisma.auditEvent.create({
          data: {
            deviceId: device.id,
            eventType: 'UPDATE_CHECK_FAILED',
            entityType: 'scan_jobs',
            entityId: jobId,
            metadata: {
              errorCode: error_code,
              errorMessage: error_message.slice(0, 200),
            },
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
