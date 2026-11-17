import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

export const scanRouter = Router();

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
