import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';

describe('Agent Job Polling, Claiming & Progress API (/api/agent/jobs)', () => {
  let server: Server;
  let baseUrl: string;

  const validToken = 'agent-secret-token-12345';
  const validTokenHash = crypto.createHash('sha256').update(validToken).digest('hex');

  const revokedToken = 'agent-revoked-token-67890';
  const revokedTokenHash = crypto.createHash('sha256').update(revokedToken).digest('hex');

  const deviceA = {
    id: 'device-aaa-111',
    userId: 'user-111',
    name: 'Office PC',
    hostname: 'DESKTOP-OFFICE',
    osVersion: 'Windows 11',
    agentVersion: '1.0.0',
    status: 'ONLINE',
  };

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('revoked agent token returns 401', async () => {
    const originalFindUnique = prisma.agentCredential.findUnique;
    prisma.agentCredential.findUnique = (async ({ where }: { where: { tokenHash: string } }) => {
      if (where.tokenHash === revokedTokenHash) {
        return {
          id: 'cred-revoked',
          deviceId: deviceA.id,
          tokenHash: revokedTokenHash,
          revokedAt: new Date(), // Revoked!
          device: deviceA,
        };
      }
      return null;
    }) as unknown as typeof prisma.agentCredential.findUnique;

    try {
      const res = await fetch(`${baseUrl}/api/agent/jobs`, {
        headers: { Authorization: `Bearer ${revokedToken}` },
      });
      assert.strictEqual(res.status, 401);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'UNAUTHORIZED_AGENT');
    } finally {
      prisma.agentCredential.findUnique = originalFindUnique;
    }
  });

  it('polling returns the oldest queued job for that device or empty list', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    // Device A has a queued job
    prisma.scanJob.findFirst = (async (args: { where: { deviceId: string; status: string } }) => {
      assert.strictEqual(args.where.deviceId, deviceA.id);
      assert.strictEqual(args.where.status, 'queued');
      return {
        id: 'job-queued-1',
        type: 'scan_inventory',
      };
    }) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/agent/jobs`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as { success: boolean; data: { jobs: Array<{ id: string; type: string }> } };
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.jobs.length, 1);
      assert.strictEqual(body.data.jobs[0].id, 'job-queued-1');
      assert.strictEqual(body.data.jobs[0].type, 'scan_inventory');
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
    }
  });

  it('polling returns empty list when no queued jobs exist', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async () => null) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/agent/jobs`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as { success: boolean; data: { jobs: unknown[] } };
      assert.strictEqual(body.data.jobs.length, 0);
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
    }
  });

  it('claiming a job on another device returns 404', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    // Agent authenticates as deviceA
    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    // Job exists, but belongs to deviceB
    prisma.scanJob.findFirst = (async () => null) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/agent/jobs/job-on-device-b/claim`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(res.status, 404);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.error.code, 'JOB_NOT_FOUND');
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
    }
  });

  it('claim race: two claims, first succeeds and second gets 409', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;
    const originalUpdateMany = prisma.scanJob.updateMany;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async () => ({
      id: 'job-race-1',
      deviceId: deviceA.id,
      status: 'queued',
    })) as unknown as typeof prisma.scanJob.findFirst;

    // Simulate database: first call updates 1 row, second updates 0 rows
    let claimAttempt = 0;
    prisma.scanJob.updateMany = (async () => {
      claimAttempt += 1;
      return { count: claimAttempt === 1 ? 1 : 0 };
    }) as unknown as typeof prisma.scanJob.updateMany;

    try {
      // First claim
      const res1 = await fetch(`${baseUrl}/api/agent/jobs/job-race-1/claim`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(res1.status, 200);
      const body1 = (await res1.json()) as { success: boolean; data: { job: { status: string } } };
      assert.strictEqual(body1.success, true);
      assert.strictEqual(body1.data.job.status, 'running');

      // Second claim (concurrent race)
      const res2 = await fetch(`${baseUrl}/api/agent/jobs/job-race-1/claim`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(res2.status, 409);
      const body2 = (await res2.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body2.success, false);
      assert.strictEqual(body2.error.code, 'JOB_ALREADY_CLAIMED');
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
      prisma.scanJob.updateMany = originalUpdateMany;
    }
  });

  it('progress on a running job updates percent and step monotonically', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;
    const originalUpdate = prisma.scanJob.update;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    // Running job currently at 35%
    prisma.scanJob.findFirst = (async () => ({
      id: 'job-running-1',
      deviceId: deviceA.id,
      status: 'running',
      progressPercent: 35,
      progressStep: 'listing_winget',
      progressMessage: 'Found 40 WinGet apps',
      skippedSteps: [],
    })) as unknown as typeof prisma.scanJob.findFirst;

    prisma.scanJob.update = (async (args: {
      data: {
        progressPercent: number;
        progressStep: string;
        progressMessage?: string;
        skippedSteps?: string[];
      };
    }) => ({
      id: 'job-running-1',
      status: 'running',
      progressPercent: args.data.progressPercent,
      progressStep: args.data.progressStep,
      progressMessage: args.data.progressMessage,
      skippedSteps: args.data.skippedSteps,
    })) as unknown as typeof prisma.scanJob.update;

    try {
      const res = await fetch(`${baseUrl}/api/agent/jobs/job-running-1/progress`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          percent: 60,
          step: 'reading_registry',
          message: 'Found 87 apps',
          skipped: false,
        }),
      });

      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as {
        success: boolean;
        data: { job: { progressPercent: number; progressStep: string; progressMessage: string; skippedSteps: string[] } };
      };
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.job.progressPercent, 60);
      assert.strictEqual(body.data.job.progressStep, 'reading_registry');
      assert.strictEqual(body.data.job.progressMessage, 'Found 87 apps');

      // Test skipped step and non-decreasing percent (sending 10% when already at 35% stays 35%)
      const resSkipped = await fetch(`${baseUrl}/api/agent/jobs/job-running-1/progress`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          percent: 10,
          step: 'enriching_publishers',
          message: 'Skipped (disabled)',
          skipped: true,
        }),
      });
      assert.strictEqual(resSkipped.status, 200);
      const skippedBody = (await resSkipped.json()) as {
        success: boolean;
        data: { job: { progressPercent: number; skippedSteps: string[] } };
      };
      assert.strictEqual(skippedBody.data.job.progressPercent, 35);
      assert.deepStrictEqual(skippedBody.data.job.skippedSteps, ['enriching_publishers']);
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
      prisma.scanJob.update = originalUpdate;
    }
  });

  it('progress on a non-running job returns 400', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    // Job is completed (terminal state)
    prisma.scanJob.findFirst = (async () => ({
      id: 'job-done',
      deviceId: deviceA.id,
      status: 'succeeded',
      progressPercent: 100,
    })) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/agent/jobs/job-done/progress`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ percent: 50 }),
      });

      assert.strictEqual(res.status, 400);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.error.code, 'INVALID_JOB_STATE');
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
    }
  });
});
