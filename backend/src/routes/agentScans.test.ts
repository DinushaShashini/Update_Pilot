import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';

describe('Agent Scan Results & Failure API (/api/agent/scans)', () => {
  let server: Server;
  let baseUrl: string;

  const validToken = 'agent-secret-token-scans';
  const validTokenHash = crypto.createHash('sha256').update(validToken).digest('hex');

  const deviceA = {
    id: 'device-aaa-111',
    userId: 'user-111',
    name: 'Office PC',
    hostname: 'DESKTOP-OFFICE',
    osVersion: 'Windows 11',
    agentVersion: '1.0.0',
    status: 'ONLINE',
  };

  const sampleRunningJob = {
    id: 'job-running-1',
    deviceId: deviceA.id,
    type: 'scan_inventory',
    status: 'running',
    startedAt: new Date(),
    finishedAt: null,
    errorCode: null,
    errorMessage: null,
    appCount: 0,
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

  it('valid scan results submission updates apps, marks missing apps not installed, updates job to succeeded', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;
    const originalTransaction = prisma.$transaction;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async (args: { where: { id: string; deviceId: string } }) => {
      if (args.where.id === sampleRunningJob.id && args.where.deviceId === deviceA.id) {
        return sampleRunningJob;
      }
      return null;
    }) as unknown as typeof prisma.scanJob.findFirst;

    // Track database writes
    const updatedApps: Array<{ id: string; data: Record<string, unknown> }> = [];
    const createdApps: Array<Record<string, unknown>> = [];
    let markedMissingIds: string[] = [];
    let updatedJobData: Record<string, unknown> | undefined;
    let createdAuditEvent: Record<string, unknown> | undefined;
    let updatedDeviceData: Record<string, unknown> | undefined;

    // Existing apps on device: Git (to be updated), and OldApp (missing in scan, to be marked not installed)
    const existingAppsInDb = [
      {
        id: 'app-git-1',
        deviceId: deviceA.id,
        packageId: 'Git.Git',
        name: 'Git for Windows',
        installedVersion: '2.40.0',
        availableVersion: null,
        publisher: 'Git',
        source: 'winget',
        isManaged: true,
        isInstalled: true,
      },
      {
        id: 'app-old-2',
        deviceId: deviceA.id,
        packageId: 'Old.App',
        name: 'Old Application',
        installedVersion: '1.0.0',
        availableVersion: null,
        publisher: 'Legacy',
        source: 'winget',
        isManaged: true,
        isInstalled: true,
      },
    ];

    const mockTx = {
      application: {
        findMany: async () => existingAppsInDb,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updatedApps.push({ id: where.id, data });
          return { id: where.id, ...data };
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createdApps.push(data);
          return { id: 'app-new-created', ...data };
        },
        updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
          markedMissingIds = where.id.in;
          return { count: where.id.in.length, ...data };
        },
      },
      scanJob: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updatedJobData = data;
          return { id: sampleRunningJob.id, ...data };
        },
      },
      device: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updatedDeviceData = data;
          return { id: deviceA.id, ...data };
        },
      },
      auditEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createdAuditEvent = data;
          return { id: 'audit-1', ...data };
        },
      },
    };

    prisma.$transaction = (async (fn: (tx: typeof mockTx) => Promise<unknown>) => {
      return fn(mockTx);
    }) as unknown as typeof prisma.$transaction;

    try {
      const payload = {
        exit_code: 0,
        discovered_packages: [
          {
            name: 'Git for Windows',
            package_id: 'Git.Git',
            installed_version: '2.50.0',
            available_version: '2.56.0',
            publisher: 'Git Authors',
            source: 'winget',
            is_managed: true,
          },
          {
            name: 'VS Code',
            package_id: 'Microsoft.VisualStudioCode',
            installed_version: '1.85.0',
            available_version: null,
            publisher: 'Microsoft Corporation',
            source: 'winget',
            is_managed: true,
          },
        ],
        available_upgrades: [],
        raw_stderr: '',
      };

      const res = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/results`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify(payload),
      });

      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as { success: boolean; data: { jobId: string; appCount: number; status: string } };
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.jobId, sampleRunningJob.id);
      assert.strictEqual(body.data.appCount, 2);
      assert.strictEqual(body.data.status, 'succeeded');

      // Verify Git was updated
      assert.strictEqual(updatedApps.length, 1);
      assert.strictEqual(updatedApps[0].id, 'app-git-1');
      assert.strictEqual(updatedApps[0].data.installedVersion, '2.50.0');
      assert.strictEqual(updatedApps[0].data.isInstalled, true);

      // Verify VS Code was created
      assert.strictEqual(createdApps.length, 1);
      assert.strictEqual(createdApps[0].name, 'VS Code');
      assert.strictEqual(createdApps[0].packageId, 'Microsoft.VisualStudioCode');
      assert.strictEqual(createdApps[0].isInstalled, true);

      // Verify OldApp was marked not installed
      assert.strictEqual(markedMissingIds.length, 1);
      assert.strictEqual(markedMissingIds[0], 'app-old-2');

      // Verify ScanJob was updated to succeeded
      assert.ok(updatedJobData !== undefined);
      assert.strictEqual(updatedJobData.status, 'succeeded');
      assert.strictEqual(updatedJobData.appCount, 2);
      assert.strictEqual(updatedJobData.progressPercent, 100);

      // Verify device lastSeenAt was updated
      assert.ok(updatedDeviceData !== undefined);
      assert.ok(updatedDeviceData.lastSeenAt instanceof Date);

      // Verify AuditEvent was logged
      assert.ok(createdAuditEvent !== undefined);
      assert.strictEqual(createdAuditEvent.eventType, 'SCAN_SUCCEEDED');
      assert.strictEqual(createdAuditEvent.entityId, sampleRunningJob.id);
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
      prisma.$transaction = originalTransaction;
    }
  });

  it('malformed payloads return 400 with VALIDATION_ERROR', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async () => sampleRunningJob) as unknown as typeof prisma.scanJob.findFirst;

    try {
      // 1. Missing installed_version
      const badPayload1 = {
        discovered_packages: [
          {
            name: 'Bad App',
          },
        ],
      };

      const res1 = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/results`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify(badPayload1),
      });

      assert.strictEqual(res1.status, 400);
      const body1 = (await res1.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body1.error.code, 'VALIDATION_ERROR');

      // 2. Name exceeds 256 characters
      const badPayload2 = {
        discovered_packages: [
          {
            name: 'A'.repeat(257),
            installed_version: '1.0.0',
          },
        ],
      };

      const res2 = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/results`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify(badPayload2),
      });

      assert.strictEqual(res2.status, 400);
      const body2 = (await res2.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body2.error.code, 'VALIDATION_ERROR');

      // 3. More than 5000 apps
      const badPayload3 = {
        discovered_packages: Array.from({ length: 5001 }, (_, i) => ({
          name: `App ${i}`,
          installed_version: '1.0',
        })),
      };

      const res3 = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/results`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify(badPayload3),
      });

      assert.strictEqual(res3.status, 400);
      const body3 = (await res3.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body3.error.code, 'VALIDATION_ERROR');
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
    }
  });

  it('rejects oversize payloads (>2MB) with 413', async () => {
    // Generate a payload exceeding 2MB
    const bigString = 'X'.repeat(2.5 * 1024 * 1024);
    const oversizePayload = {
      exit_code: 0,
      discovered_packages: [],
      raw_stderr: bigString,
    };

    const res = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/results`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify(oversizePayload),
    });

    assert.strictEqual(res.status, 413);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.code, 'PAYLOAD_TOO_LARGE');
  });

  it('submitting results for job on another device returns 404', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    // ScanJob does not exist on deviceA
    prisma.scanJob.findFirst = (async () => null) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/agent/scans/foreign-job-id/results`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ discovered_packages: [] }),
      });

      assert.strictEqual(res.status, 404);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.error.code, 'JOB_NOT_FOUND');
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
    }
  });

  it('repeat submission on an already finished job returns 409', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async () => ({
      ...sampleRunningJob,
      status: 'succeeded',
    })) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/results`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ discovered_packages: [] }),
      });

      assert.strictEqual(res.status, 409);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.error.code, 'JOB_ALREADY_FINISHED');
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
    }
  });

  it('submitting results for a queued job returns 400', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async () => ({
      ...sampleRunningJob,
      status: 'queued',
    })) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/results`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ discovered_packages: [] }),
      });

      assert.strictEqual(res.status, 400);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.error.code, 'INVALID_JOB_STATE');
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
    }
  });

  it('rollback when transaction fails ensures 500 error and nothing committed', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;
    const originalTransaction = prisma.$transaction;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async () => sampleRunningJob) as unknown as typeof prisma.scanJob.findFirst;

    let transactionStarted = false;
    prisma.$transaction = (async () => {
      transactionStarted = true;
      throw new Error('Database constraint violation during batch write');
    }) as unknown as typeof prisma.$transaction;

    try {
      const res = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/results`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({
          discovered_packages: [
            {
              name: 'App',
              installed_version: '1.0',
            },
          ],
        }),
      });

      assert.strictEqual(res.status, 500);
      assert.strictEqual(transactionStarted, true);
      const body = (await res.json()) as { success: boolean; error: { code: string; message: string } };
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'INTERNAL_ERROR');
      assert.ok(body.error.message.includes('Database constraint violation'));
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
      prisma.$transaction = originalTransaction;
    }
  });

  it('reporting scan failure on running job marks job as failed and writes audit event', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;
    const originalTransaction = prisma.$transaction;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async () => sampleRunningJob) as unknown as typeof prisma.scanJob.findFirst;

    let transactionArgs: unknown[] = [];
    prisma.$transaction = (async (ops: unknown[]) => {
      transactionArgs = ops;
      return ops;
    }) as unknown as typeof prisma.$transaction;

    try {
      const res = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/failure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({
          error_code: 101,
          error_message: 'WinGet CLI crashed unexpectedly with exit code 0x8A150011',
        }),
      });

      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as { success: boolean; data: { jobId: string; status: string } };
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.status, 'failed');
      assert.strictEqual(transactionArgs.length, 3); // job update, device update, audit event
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
      prisma.$transaction = originalTransaction;
    }
  });

  it('reporting scan failure on finished job returns 409', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async () => ({
      ...sampleRunningJob,
      status: 'failed',
    })) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/failure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({
          error_message: 'Some error',
        }),
      });

      assert.strictEqual(res.status, 409);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.error.code, 'JOB_ALREADY_FINISHED');
    } finally {
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
    }
  });

  it('reporting scan failure on queued job returns 400', async () => {
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    prisma.agentCredential.findUnique = (async () => ({
      id: 'cred-valid',
      deviceId: deviceA.id,
      tokenHash: validTokenHash,
      revokedAt: null,
      device: deviceA,
    })) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async () => ({
      ...sampleRunningJob,
      status: 'queued',
    })) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/agent/scans/${sampleRunningJob.id}/failure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({
          error_message: 'Some error',
        }),
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
