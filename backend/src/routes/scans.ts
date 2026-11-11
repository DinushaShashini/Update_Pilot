import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

export const scanRouter = Router();

// POST /api/devices/:id/scans - Queue a new scan job for a device
scanRouter.post('/devices/:id/scans', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const deviceId = String(req.params.id);
  const user = req.user!;

  try {
    // 1. Verify device exists and belongs to the authenticated user
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

    // 2. Concurrency rule: strictly one active scan per device
    const activeScan = await prisma.scanJob.findFirst({
      where: {
        deviceId: device.id,
        status: { in: ['queued', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (activeScan) {
      res.status(409).json({
        success: false,
        error: {
          code: 'ACTIVE_SCAN_EXISTS',
          message: 'An active scan is already queued or running for this device.',
          existingJobId: activeScan.id,
          status: activeScan.status,
        },
      });
      return;
    }

    // 3. Create the queued ScanJob and write an audit event
    const [scanJob] = await prisma.$transaction([
      prisma.scanJob.create({
        data: {
          deviceId: device.id,
          requestedByUserId: user.id,
          type: 'scan_inventory',
          status: 'queued',
          progressPercent: 0,
          progressStep: 'queued',
        },
      }),
      prisma.auditEvent.create({
        data: {
          userId: user.id,
          deviceId: device.id,
          eventType: 'SCAN_QUEUED',
          entityType: 'scan_jobs',
          metadata: {
            type: 'scan_inventory',
            trigger: 'MANUAL',
          },
        },
      }),
    ]);

    res.status(201).json({
      success: true,
      data: {
        job: scanJob,
      },
    });
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
