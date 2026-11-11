import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';

describe('Scan Jobs API (/api/devices/:id/scans)', () => {
  let server: Server;
  let baseUrl: string;

  const userA = { id: '11111111-1111-1111-1111-111111111111', email: 'usera@example.com' };
  const userB = { id: '22222222-2222-2222-2222-222222222222', email: 'userb@example.com' };

  const tokenUserA = signToken({ sub: userA.id, email: userA.email });
  const tokenUserB = signToken({ sub: userB.id, email: userB.email });

  const deviceA = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    userId: userA.id,
    name: 'Work PC',
    hostname: 'DESKTOP-A',
    osVersion: 'Windows 11',
    agentVersion: '1.0.0',
    status: 'ONLINE',
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
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

  it('unauthenticated request returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.code, 'UNAUTHORIZED');
  });

  it('user accessing another users device returns 404', async () => {
    const originalFindUnique = prisma.device.findUnique;
    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;

    try {
      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/scans`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserB}`,
          'Content-Type': 'application/json',
        },
      });

      assert.strictEqual(res.status, 404);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'DEVICE_NOT_FOUND');
    } finally {
      prisma.device.findUnique = originalFindUnique;
    }
  });

  it('creates a queued scan job and writes audit event for owner', async () => {
    const originalFindUnique = prisma.device.findUnique;
    const originalFindFirst = prisma.scanJob.findFirst;
    const originalTransaction = prisma.$transaction;

    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;
    prisma.scanJob.findFirst = (async () => null) as unknown as typeof prisma.scanJob.findFirst;

    let transactionCalled = false;
    prisma.$transaction = (async (_promises: unknown) => {
      transactionCalled = true;
      return [
        {
          id: 'job-12345',
          deviceId: deviceA.id,
          requestedByUserId: userA.id,
          type: 'scan_inventory',
          status: 'queued',
          progressPercent: 0,
          progressStep: 'queued',
          createdAt: new Date(),
        },
        { id: 'audit-123' },
      ];
    }) as unknown as typeof prisma.$transaction;

    try {
      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/scans`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
        },
      });

      assert.strictEqual(res.status, 201);
      const body = (await res.json()) as {
        success: boolean;
        data: { job: { id: string; status: string } };
      };
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.job.id, 'job-12345');
      assert.strictEqual(body.data.job.status, 'queued');
      assert.strictEqual(transactionCalled, true);
    } finally {
      prisma.device.findUnique = originalFindUnique;
      prisma.scanJob.findFirst = originalFindFirst;
      prisma.$transaction = originalTransaction;
    }
  });

  it('rejects duplicate scan request with 409 when an active scan exists', async () => {
    const originalFindUnique = prisma.device.findUnique;
    const originalFindFirst = prisma.scanJob.findFirst;

    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;
    prisma.scanJob.findFirst = (async () => ({
      id: 'active-job-999',
      deviceId: deviceA.id,
      status: 'running',
    })) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/scans`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
        },
      });

      assert.strictEqual(res.status, 409);
      const body = (await res.json()) as {
        success: boolean;
        error: { code: string; existingJobId: string; status: string };
      };
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'ACTIVE_SCAN_EXISTS');
      assert.strictEqual(body.error.existingJobId, 'active-job-999');
      assert.strictEqual(body.error.status, 'running');
    } finally {
      prisma.device.findUnique = originalFindUnique;
      prisma.scanJob.findFirst = originalFindFirst;
    }
  });

  it('GET /api/devices/:id/scans/:jobId returns job details for owner and 404 for non-owner', async () => {
    const originalFindUnique = prisma.device.findUnique;
    const originalFindFirst = prisma.scanJob.findFirst;

    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;
    prisma.scanJob.findFirst = (async (args: { where: { id: string } }) => {
      if (args.where.id === 'job-12345') {
        return {
          id: 'job-12345',
          deviceId: deviceA.id,
          status: 'queued',
          progressPercent: 0,
        };
      }
      return null;
    }) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const resOwner = await fetch(`${baseUrl}/api/devices/${deviceA.id}/scans/job-12345`, {
        headers: { Authorization: `Bearer ${tokenUserA}` },
      });
      assert.strictEqual(resOwner.status, 200);
      const bodyOwner = (await resOwner.json()) as { data: { job: { id: string } } };
      assert.strictEqual(bodyOwner.data.job.id, 'job-12345');

      const resNonOwner = await fetch(`${baseUrl}/api/devices/${deviceA.id}/scans/job-12345`, {
        headers: { Authorization: `Bearer ${tokenUserB}` },
      });
      assert.strictEqual(resNonOwner.status, 404);
    } finally {
      prisma.device.findUnique = originalFindUnique;
      prisma.scanJob.findFirst = originalFindFirst;
    }
  });

  it('GET /api/devices/:id/scans/latest returns latest job', async () => {
    const originalFindUnique = prisma.device.findUnique;
    const originalFindFirst = prisma.scanJob.findFirst;

    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;
    prisma.scanJob.findFirst = (async () => ({
      id: 'latest-job-888',
      deviceId: deviceA.id,
      status: 'succeeded',
      appCount: 42,
    })) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/scans/latest`, {
        headers: { Authorization: `Bearer ${tokenUserA}` },
      });
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as { data: { job: { id: string; status: string } } };
      assert.strictEqual(body.data.job.id, 'latest-job-888');
      assert.strictEqual(body.data.job.status, 'succeeded');
    } finally {
      prisma.device.findUnique = originalFindUnique;
      prisma.scanJob.findFirst = originalFindFirst;
    }
  });
});
