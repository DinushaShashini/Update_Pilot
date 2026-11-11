import { Router, type Request, type Response } from 'express';
import express from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAgent } from '../middleware/auth.js';

export const agentScanRouter = Router();

// 2MB payload size limit for scan inventory reporting
const scanResultsBodyLimit = express.json({ limit: '2mb' });

const discoveredPackageSchema = z.object({
  name: z.string().min(1).max(256),
  package_id: z.string().max(256).nullable().optional(),
  installed_version: z.string().max(128),
  available_version: z.string().max(128).nullable().optional(),
  publisher: z.string().max(256).nullable().optional(),
  source: z.string().max(50).nullable().optional(),
  is_managed: z.boolean().default(false),
});

const scanResultPayloadSchema = z.object({
  exit_code: z.number().int().optional().default(0),
  discovered_packages: z.array(discoveredPackageSchema).max(5000),
  available_upgrades: z.array(z.unknown()).optional().default([]),
  raw_stderr: z.string().max(65536).optional().default(''),
});

const scanFailurePayloadSchema = z.object({
  error_code: z.number().int().optional().default(1),
  error_message: z.string().max(1024),
});

// POST /api/agent/scans/:id/results - Submit inventory scan results
agentScanRouter.post(
  '/agent/scans/:id/results',
  scanResultsBodyLimit,
  requireAgent,
  async (req: Request, res: Response): Promise<void> => {
    const jobId = String(req.params.id);
    const device = req.agentDevice!;

    try {
      // 1. Verify job exists for this device
      const job = await prisma.scanJob.findFirst({
        where: {
          id: jobId,
          deviceId: device.id,
        },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'JOB_NOT_FOUND', message: 'Scan job not found for this device' },
        });
        return;
      }

      // 2. Reject second submission for finished job with 409
      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) {
        res.status(409).json({
          success: false,
          error: {
            code: 'JOB_ALREADY_FINISHED',
            message: `Scan job has already finished with status '${job.status}'`,
          },
        });
        return;
      }

      // Must be running
      if (job.status !== 'running') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_JOB_STATE',
            message: `Scan job must be in 'running' status (current status: '${job.status}')`,
          },
        });
        return;
      }

      // 3. Validate payload with Zod
      const parseResult = scanResultPayloadSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid scan result payload',
            details: parseResult.error.format(),
          },
        });
        return;
      }

      const { discovered_packages } = parseResult.data;
      const now = new Date();

      // 4. Save results in a single database transaction
      await prisma.$transaction(async (tx) => {
        // Fetch existing applications for this device
        const existingApps = await tx.application.findMany({
          where: { deviceId: device.id },
        });

        const existingByPkgId = new Map<string, typeof existingApps[0]>();
        const existingByName = new Map<string, typeof existingApps[0]>();

        for (const app of existingApps) {
          if (app.packageId) {
            existingByPkgId.set(app.packageId.toLowerCase(), app);
          }
          existingByName.set(app.name.toLowerCase(), app);
        }

        const matchedAppIds = new Set<string>();

        // Upsert applications
        for (const pkg of discovered_packages) {
          let matchedApp: typeof existingApps[0] | undefined;

          if (pkg.package_id) {
            matchedApp = existingByPkgId.get(pkg.package_id.toLowerCase());
          }
          if (!matchedApp) {
            matchedApp = existingByName.get(pkg.name.toLowerCase());
          }

          if (matchedApp) {
            matchedAppIds.add(matchedApp.id);
            await tx.application.update({
              where: { id: matchedApp.id },
              data: {
                installedVersion: pkg.installed_version,
                availableVersion: pkg.available_version ?? matchedApp.availableVersion,
                publisher: pkg.publisher ?? matchedApp.publisher,
                source: pkg.source ?? matchedApp.source,
                isManaged: pkg.is_managed,
                isInstalled: true,
                lastScannedAt: now,
              },
            });
          } else {
            const created = await tx.application.create({
              data: {
                deviceId: device.id,
                packageId: pkg.package_id || null,
                name: pkg.name,
                installedVersion: pkg.installed_version,
                availableVersion: pkg.available_version || null,
                publisher: pkg.publisher || null,
                source: pkg.source || null,
                isManaged: pkg.is_managed,
                isInstalled: true,
                lastScannedAt: now,
              },
            });
            matchedAppIds.add(created.id);
            if (created.packageId) {
              existingByPkgId.set(created.packageId.toLowerCase(), created);
            }
            existingByName.set(created.name.toLowerCase(), created);
          }
        }

        // Mark applications not present in this scan as isInstalled = false
        if (existingApps.length > 0) {
          const missingIds = existingApps
            .filter((app) => !matchedAppIds.has(app.id))
            .map((app) => app.id);

          if (missingIds.length > 0) {
            await tx.application.updateMany({
              where: {
                id: { in: missingIds },
                deviceId: device.id,
              },
              data: {
                isInstalled: false,
              },
            });
          }
        }

        // Set job status to succeeded with finishedAt and appCount
        await tx.scanJob.update({
          where: { id: jobId },
          data: {
            status: 'succeeded',
            finishedAt: now,
            appCount: discovered_packages.length,
            progressPercent: 100,
            progressStep: 'completed',
            errorCode: 0,
          },
        });

        // Update device lastSeenAt
        await tx.device.update({
          where: { id: device.id },
          data: {
            lastSeenAt: now,
          },
        });

        // Write audit event for success
        await tx.auditEvent.create({
          data: {
            deviceId: device.id,
            eventType: 'SCAN_SUCCEEDED',
            entityType: 'scan_jobs',
            entityId: jobId,
            metadata: {
              appCount: discovered_packages.length,
            },
          },
        });
      });

      res.status(200).json({
        success: true,
        data: {
          jobId,
          appCount: discovered_packages.length,
          status: 'succeeded',
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

// POST /api/agent/scans/:id/failure - Report failed scan job
agentScanRouter.post(
  '/agent/scans/:id/failure',
  express.json(),
  requireAgent,
  async (req: Request, res: Response): Promise<void> => {
    const jobId = String(req.params.id);
    const device = req.agentDevice!;

    try {
      const job = await prisma.scanJob.findFirst({
        where: {
          id: jobId,
          deviceId: device.id,
        },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'JOB_NOT_FOUND', message: 'Scan job not found for this device' },
        });
        return;
      }

      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) {
        res.status(409).json({
          success: false,
          error: {
            code: 'JOB_ALREADY_FINISHED',
            message: `Scan job has already finished with status '${job.status}'`,
          },
        });
        return;
      }

      if (job.status !== 'running') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_JOB_STATE',
            message: `Scan job must be in 'running' status (current status: '${job.status}')`,
          },
        });
        return;
      }

      const parseResult = scanFailurePayloadSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid scan failure payload',
            details: parseResult.error.format(),
          },
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
          },
        }),
        prisma.device.update({
          where: { id: device.id },
          data: {
            lastSeenAt: now,
          },
        }),
        prisma.auditEvent.create({
          data: {
            deviceId: device.id,
            eventType: 'SCAN_FAILED',
            entityType: 'scan_jobs',
            entityId: jobId,
            metadata: {
              errorCode: error_code,
              errorMessage: error_message,
            },
          },
        }),
      ]);

      res.status(200).json({
        success: true,
        data: {
          jobId,
          status: 'failed',
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
