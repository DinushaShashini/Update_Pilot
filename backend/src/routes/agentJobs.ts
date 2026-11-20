import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAgent } from '../middleware/auth.js';
import { getActivePairingCode, redeemPairingCode } from './deviceData.js';

export const agentJobRouter = Router();

// POST /api/agent/pair & POST /api/v1/agent/pair - Agent device registration
agentJobRouter.post(
  ['/agent/pair', '/v1/agent/pair'],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { code, pairing_token, hostname, computer_name, os_version, agent_version } = req.body || {};
      const pairingCode = (code || pairing_token || '').trim();

      if (!pairingCode) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CODE', message: 'Pairing code is required.' },
        });
        return;
      }

      const activeRecord = getActivePairingCode(pairingCode);
      if (!activeRecord) {
        res.status(401).json({
          success: false,
          error: { code: 'INVALID_PAIRING_CODE', message: 'Invalid pairing code provided.' },
        });
        return;
      }

      if (Date.now() > activeRecord.expiresAt) {
        res.status(403).json({
          success: false,
          error: { code: 'TOKEN_EXPIRED', message: 'The pairing code has expired.' },
        });
        return;
      }

      if (activeRecord.redeemed) {
        res.status(403).json({
          success: false,
          error: { code: 'TOKEN_ALREADY_USED', message: 'This pairing code has already been redeemed.' },
        });
        return;
      }

      redeemPairingCode(pairingCode);

      // Create new device and permanent token
      const deviceHostname = hostname || computer_name || 'DESKTOP-AGENT';
      const deviceOs = os_version || 'Windows';
      const deviceAgentVer = agent_version || '1.0.0';

      const agentRawToken = `agt_${crypto.randomBytes(24).toString('hex')}`;
      const tokenHash = crypto.createHash('sha256').update(agentRawToken).digest('hex');

      // Ensure the user exists in database before creating device
      await prisma.user.upsert({
        where: { id: activeRecord.userId },
        update: {},
        create: {
          id: activeRecord.userId,
          email: 'dinusha@example.com',
          role: 'USER',
          passwordHash: 'dummy_dev_hash',
        },
      });

      const device = await prisma.device.create({
        data: {
          userId: activeRecord.userId,
          name: deviceHostname,
          hostname: deviceHostname,
          osVersion: deviceOs,
          agentVersion: deviceAgentVer,
          status: 'ONLINE',
          lastSeenAt: new Date(),
        },
      });

      await prisma.agentCredential.create({
        data: {
          deviceId: device.id,
          tokenHash,
        },
      });

      res.status(200).json({
        success: true,
        data: {
          device_id: device.id,
          token: agentRawToken,
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

// POST /api/agent/heartbeat & POST /api/v1/agent/heartbeat - Heartbeat ping
agentJobRouter.post(
  ['/agent/heartbeat', '/v1/agent/heartbeat'],
  requireAgent,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const device = req.agentDevice!;
      await prisma.device.update({
        where: { id: device.id },
        data: {
          status: 'ONLINE',
          lastSeenAt: new Date(),
        },
      });

      res.status(200).json({
        success: true,
        data: { status: 'ONLINE', received_at: new Date().toISOString() },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  }
);

const progressSchema = z.object({
  percent: z.number().int().min(0).max(100),
  step: z.string().max(100).optional(),
  message: z.string().max(256).optional(),
  skipped: z.boolean().optional(),
});

// GET /api/agent/jobs - Poll oldest queued job for authenticated agent device
agentJobRouter.get('/agent/jobs', requireAgent, async (req: Request, res: Response): Promise<void> => {
  const device = req.agentDevice!;

  try {
    const oldestQueuedJob = await prisma.scanJob.findFirst({
      where: {
        deviceId: device.id,
        status: 'queued',
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
      },
    });

    res.status(200).json({
      success: true,
      data: {
        jobs: oldestQueuedJob ? [oldestQueuedJob] : [],
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

// POST /api/agent/jobs/:id/claim - Atomically claim a queued job
agentJobRouter.post('/agent/jobs/:id/claim', requireAgent, async (req: Request, res: Response): Promise<void> => {
  const jobId = String(req.params.id);
  const device = req.agentDevice!;

  try {
    // 1. Verify job exists for this device
    const existingJob = await prisma.scanJob.findFirst({
      where: {
        id: jobId,
        deviceId: device.id,
      },
    });

    if (!existingJob) {
      res.status(404).json({
        success: false,
        error: { code: 'JOB_NOT_FOUND', message: 'Job not found for this device' },
      });
      return;
    }

    // 2. Conditional atomic update: only transitions from 'queued' to 'running'
    const now = new Date();
    const updateResult = await prisma.scanJob.updateMany({
      where: {
        id: jobId,
        deviceId: device.id,
        status: 'queued',
      },
      data: {
        status: 'running',
        startedAt: now,
      },
    });

    if (updateResult.count === 0) {
      // Job was already claimed or moved to terminal state
      res.status(409).json({
        success: false,
        error: {
          code: 'JOB_ALREADY_CLAIMED',
          message: 'Job has already been claimed or is no longer in queued status',
          currentStatus: existingJob.status,
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        job: {
          id: jobId,
          status: 'running',
          startedAt: now.toISOString(),
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});

// POST /api/agent/jobs/:id/progress - Report job execution progress
agentJobRouter.post('/agent/jobs/:id/progress', requireAgent, async (req: Request, res: Response): Promise<void> => {
  const jobId = String(req.params.id);
  const device = req.agentDevice!;

  const parseResult = progressSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid progress parameters',
        details: parseResult.error.format(),
      },
    });
    return;
  }

  const { percent, step, message, skipped } = parseResult.data;

  try {
    // 1. Check job belongs to this device
    const job = await prisma.scanJob.findFirst({
      where: {
        id: jobId,
        deviceId: device.id,
      },
    });

    if (!job) {
      res.status(404).json({
        success: false,
        error: { code: 'JOB_NOT_FOUND', message: 'Job not found for this device' },
      });
      return;
    }

    // 2. Only allow progress updates while job is 'running'
    if (job.status !== 'running') {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_JOB_STATE',
          message: `Cannot update progress for job in '${job.status}' status. Job must be 'running'.`,
        },
      });
      return;
    }

    // 3. Monotonically increasing progress
    const updatedPercent = Math.max(job.progressPercent, percent);
    const updatedStep = step || job.progressStep;
    const updatedMessage = message !== undefined ? message : job.progressMessage;

    const currentSkipped = Array.isArray(job.skippedSteps) ? (job.skippedSteps as string[]) : [];
    const nextSkipped =
      skipped && step && !currentSkipped.includes(step) ? [...currentSkipped, step] : currentSkipped;

    const updatedJob = await prisma.scanJob.update({
      where: { id: jobId },
      data: {
        progressPercent: updatedPercent,
        progressStep: updatedStep,
        progressMessage: updatedMessage,
        skippedSteps: nextSkipped as unknown as Prisma.InputJsonValue,
      },
    });

    res.status(200).json({
      success: true,
      data: {
        job: {
          id: updatedJob.id,
          status: updatedJob.status,
          progressPercent: updatedJob.progressPercent,
          progressStep: updatedJob.progressStep,
          progressMessage: updatedJob.progressMessage,
          skippedSteps: updatedJob.skippedSteps,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
    });
  }
});
