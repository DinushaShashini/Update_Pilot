import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { determinePackagesNeedingFetch } from '../metadata/cache.js';

export const scanRouter = Router();

const lastRefreshByDevice = new Map<string, number>();
const METADATA_REFRESH_COOLDOWN_MS = 10_000;

export function resetMetadataRefreshRateLimits(): void {
  lastRefreshByDevice.clear();
}

async function createDeviceJob(
  deviceId: string,
  userId: string,
  jobType: 'scan_inventory' | 'check_updates',
  auditEventType: 'SCAN_QUEUED' | 'UPDATE_CHECK_QUEUED',
  res: Response
): Promise<void> {
  try {
    // 1. Verify device exists and belongs to the authenticated user
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device || device.userId !== userId) {
      res.status(404).json({
        success: false,
        error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
      });
      return;
    }

    // 2. Concurrency rule: strictly one active job of this type per device
    const activeJob = await prisma.scanJob.findFirst({
      where: {
        deviceId: device.id,
        type: jobType,
        status: { in: ['queued', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (activeJob) {
      res.status(409).json({
        success: false,
        error: {
          code: jobType === 'scan_inventory' ? 'ACTIVE_SCAN_EXISTS' : 'ACTIVE_JOB_EXISTS',
          message: `An active ${activeJob.type} job is already queued or running for this device.`,
          existingJobId: activeJob.id,
          status: activeJob.status,
        },
      });
      return;
    }

    // 3. Create the queued ScanJob and write an audit event
    const [job] = await prisma.$transaction([
      prisma.scanJob.create({
        data: {
          deviceId: device.id,
          requestedByUserId: userId,
          type: jobType,
          status: 'queued',
          progressPercent: 0,
          progressStep: 'queued',
        },
      }),
      prisma.auditEvent.create({
        data: {
          userId,
          deviceId: device.id,
          eventType: auditEventType,
          entityType: 'scan_jobs',
          metadata: {
            type: jobType,
            trigger: 'MANUAL',
          },
        },
      }),
    ]);

    res.status(201).json({
      success: true,
      data: {
        job,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
}

// POST /api/devices/:id/scans - Queue a new scan job for a device
scanRouter.post('/devices/:id/scans', requireAuth, async (req: Request, res: Response): Promise<void> => {
  await createDeviceJob(String(req.params.id), req.user!.id, 'scan_inventory', 'SCAN_QUEUED', res);
});

// POST /api/devices/:id/update-checks - Queue a new check_updates job for a device
scanRouter.post('/devices/:id/update-checks', requireAuth, async (req: Request, res: Response): Promise<void> => {
  await createDeviceJob(String(req.params.id), req.user!.id, 'check_updates', 'UPDATE_CHECK_QUEUED', res);
});

// GET /api/devices/:id/update-checks/latest - Retrieve the latest update-check job for a device
scanRouter.get('/devices/:id/update-checks/latest', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = String(req.params.id);
  const user = req.user!;

  try {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== user.id) {
      res.status(404).json({
        success: false,
        error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
      });
      return;
    }

    const latestJob = await prisma.scanJob.findFirst({
      where: { deviceId: device.id, type: 'check_updates' },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestJob) {
      res.status(404).json({
        success: false,
        error: { code: 'NO_JOBS_FOUND', message: 'No update-check jobs found for this device' },
      });
      return;
    }

    res.status(200).json({ success: true, data: { job: latestJob } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

// GET /api/devices/:id/update-checks/:jobId - Retrieve specific update-check job details
scanRouter.get('/devices/:id/update-checks/:jobId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = String(req.params.id);
  const jobId = String(req.params.jobId);
  const user = req.user!;

  try {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== user.id) {
      res.status(404).json({
        success: false,
        error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
      });
      return;
    }

    const job = await prisma.scanJob.findFirst({
      where: { id: jobId, deviceId: device.id, type: 'check_updates' },
    });

    if (!job) {
      res.status(404).json({
        success: false,
        error: { code: 'JOB_NOT_FOUND', message: 'Update-check job not found' },
      });
      return;
    }

    res.status(200).json({ success: true, data: { job } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

// POST /api/devices/:id/metadata-jobs - Queue metadata fetch job for apps with update_available that are missing or stale
scanRouter.post('/devices/:id/metadata-jobs', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = String(req.params.id);
  const user = req.user!;

  try {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== user.id) {
      res.status(404).json({
        success: false,
        error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
      });
      return;
    }

    // 1. Determine which apps with updateStatus === 'update_available' need metadata (missing or stale)
    const { packagesToFetch, freshMetadata } = await determinePackagesNeedingFetch(device.id);

    if (packagesToFetch.length === 0) {
      res.status(200).json({
        success: true,
        data: {
          queued: false,
          message: 'All metadata is fresh or no updates available',
          freshCount: freshMetadata.length,
          packagesToFetch: [],
        },
      });
      return;
    }

    // 2. Concurrency check: one active job of type get_package_metadata
    const activeJob = await prisma.scanJob.findFirst({
      where: {
        deviceId: device.id,
        type: 'get_package_metadata',
        status: { in: ['queued', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (activeJob) {
      res.status(409).json({
        success: false,
        error: {
          code: 'ACTIVE_JOB_EXISTS',
          message: 'An active metadata job is already queued or running for this device.',
          existingJobId: activeJob.id,
          status: activeJob.status,
        },
      });
      return;
    }

    const packageIds = packagesToFetch.map((p) => p.packageId);

    // 3. Create ScanJob and audit event
    const [job] = await prisma.$transaction([
      prisma.scanJob.create({
        data: {
          deviceId: device.id,
          requestedByUserId: user.id,
          type: 'get_package_metadata',
          status: 'queued',
          progressPercent: 0,
          progressStep: 'queued',
          progressMessage: `Queued metadata fetch for ${packageIds.length} package(s)`,
          appCount: packageIds.length,
          skippedSteps: packageIds,
        },
      }),
      prisma.auditEvent.create({
        data: {
          userId: user.id,
          deviceId: device.id,
          eventType: 'METADATA_JOB_QUEUED',
          entityType: 'scan_jobs',
          metadata: {
            packageCount: packageIds.length,
            packageIds,
          },
        },
      }),
    ]);

    res.status(201).json({
      success: true,
      data: {
        queued: true,
        job,
        packagesToFetch,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

// POST /api/devices/:id/metadata-refresh - Manual refresh of package metadata (owner only, rate-limited, audited)
scanRouter.post('/devices/:id/metadata-refresh', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = String(req.params.id);
  const user = req.user!;

  try {
    // 1. Rate limiting check (cooldown per device)
    const lastRefresh = lastRefreshByDevice.get(deviceId) || 0;
    const now = Date.now();
    if (now - lastRefresh < METADATA_REFRESH_COOLDOWN_MS) {
      const retryAfterSec = Math.max(1, Math.ceil((METADATA_REFRESH_COOLDOWN_MS - (now - lastRefresh)) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: `Metadata refresh is rate limited. Please wait ${retryAfterSec}s before refreshing again.`,
        },
      });
      return;
    }

    // 2. Ownership & existence check
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== user.id) {
      res.status(404).json({
        success: false,
        error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
      });
      return;
    }

    // 3. Concurrency check: one active metadata job per device
    const activeJob = await prisma.scanJob.findFirst({
      where: {
        deviceId: device.id,
        type: 'get_package_metadata',
        status: { in: ['queued', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (activeJob) {
      res.status(409).json({
        success: false,
        error: {
          code: 'ACTIVE_JOB_EXISTS',
          message: 'An active metadata job is already queued or running for this device.',
          existingJobId: activeJob.id,
          status: activeJob.status,
        },
      });
      return;
    }

    // 4. Determine package IDs to refresh
    const specificPkgId = req.body?.packageId ? String(req.body.packageId).trim() : null;

    const apps = await prisma.application.findMany({
      where: {
        deviceId: device.id,
        isInstalled: true,
        updateStatus: 'update_available',
      },
    });

    let packageIds = apps
      .map((a) => a.matchedPackageId || a.packageId)
      .filter((id): id is string => Boolean(id && /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(id)));

    // De-duplicate package IDs
    packageIds = Array.from(new Set(packageIds));

    if (specificPkgId) {
      packageIds = packageIds.filter((id) => id.toLowerCase() === specificPkgId.toLowerCase());
    }

    if (packageIds.length === 0) {
      res.status(200).json({
        success: true,
        data: {
          queued: false,
          message: 'No applications with available updates found to refresh',
          packageIds: [],
        },
      });
      return;
    }

    // Cap to 20 package IDs per execution
    const cappedPackageIds = packageIds.slice(0, 20);

    // Update rate limit timestamp
    lastRefreshByDevice.set(deviceId, now);

    // 5. Create queued ScanJob and write audit event in transaction
    const [job] = await prisma.$transaction([
      prisma.scanJob.create({
        data: {
          deviceId: device.id,
          requestedByUserId: user.id,
          type: 'get_package_metadata',
          status: 'queued',
          progressPercent: 0,
          progressStep: 'queued',
          progressMessage: `Queued metadata refresh for ${cappedPackageIds.length} package(s)`,
          appCount: cappedPackageIds.length,
          skippedSteps: cappedPackageIds,
        },
      }),
      prisma.auditEvent.create({
        data: {
          userId: user.id,
          deviceId: device.id,
          eventType: 'METADATA_REFRESH_REQUESTED',
          entityType: 'devices',
          entityId: device.id,
          metadata: {
            packageCount: cappedPackageIds.length,
            packageIds: cappedPackageIds,
            trigger: 'MANUAL_REFRESH',
          },
        },
      }),
    ]);

    res.status(201).json({
      success: true,
      data: {
        queued: true,
        job,
        packageIds: cappedPackageIds,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

// GET /api/devices/:id/metadata-jobs/latest - Retrieve latest metadata job
scanRouter.get('/devices/:id/metadata-jobs/latest', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = String(req.params.id);
  const user = req.user!;

  try {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== user.id) {
      res.status(404).json({
        success: false,
        error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
      });
      return;
    }

    const latestJob = await prisma.scanJob.findFirst({
      where: { deviceId: device.id, type: 'get_package_metadata' },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestJob) {
      res.status(404).json({
        success: false,
        error: { code: 'NO_JOBS_FOUND', message: 'No metadata jobs found for this device' },
      });
      return;
    }

    res.status(200).json({ success: true, data: { job: latestJob } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

// GET /api/devices/:id/metadata-jobs/:jobId - Retrieve specific metadata job details
scanRouter.get('/devices/:id/metadata-jobs/:jobId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = String(req.params.id);
  const jobId = String(req.params.jobId);
  const user = req.user!;

  try {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== user.id) {
      res.status(404).json({
        success: false,
        error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
      });
      return;
    }

    const job = await prisma.scanJob.findFirst({
      where: { id: jobId, deviceId: device.id, type: 'get_package_metadata' },
    });

    if (!job) {
      res.status(404).json({
        success: false,
        error: { code: 'JOB_NOT_FOUND', message: 'Metadata job not found' },
      });
      return;
    }

    res.status(200).json({ success: true, data: { job } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});


// GET /api/devices/:id/scans/latest - Retrieve the latest scan job for a device
scanRouter.get('/devices/:id/scans/latest', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = String(req.params.id);
  const user = req.user!;

  try {
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

    const latestJob = await prisma.scanJob.findFirst({
      where: { deviceId: device.id },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestJob) {
      res.status(404).json({
        success: false,
        error: { code: 'NO_SCANS_FOUND', message: 'No scan jobs found for this device' },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        job: latestJob,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

// GET /api/devices/:id/scans/:jobId - Retrieve specific scan job details
scanRouter.get('/devices/:id/scans/:jobId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = String(req.params.id);
  const jobId = String(req.params.jobId);
  const user = req.user!;

  try {
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

    const job = await prisma.scanJob.findFirst({
      where: {
        id: jobId,
        deviceId: device.id,
      },
    });

    if (!job) {
      res.status(404).json({
        success: false,
        error: { code: 'SCAN_JOB_NOT_FOUND', message: 'Scan job not found' },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        job,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});
