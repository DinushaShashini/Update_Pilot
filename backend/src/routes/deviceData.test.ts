import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';

describe('Applications, Dashboard Overview & History API (/api/devices/:id)', () => {
  let server: Server;
  let baseUrl: string;

  const ownerUser = {
    id: 'user-owner-111',
    email: 'owner@example.com',
    role: 'USER',
  };

  const otherUser = {
    id: 'user-stranger-222',
    email: 'stranger@example.com',
    role: 'USER',
  };

  const deviceA = {
    id: 'device-aaa-111',
    userId: ownerUser.id,
    name: 'Office PC',
    hostname: 'DESKTOP-OFFICE',
    osVersion: 'Windows 11',
    agentVersion: '1.0.0',
    status: 'ONLINE',
    lastSeenAt: new Date('2026-11-11T12:00:00Z'),
  };

  const agentToken = 'agent-secret-token-e2e';
  const agentTokenHash = crypto.createHash('sha256').update(agentToken).digest('hex');

  const ownerJwt = signToken({ sub: ownerUser.id, email: ownerUser.email });
  const strangerJwt = signToken({ sub: otherUser.id, email: otherUser.email });

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

  it('unauthenticated requests return 401', async () => {
    const res1 = await fetch(`${baseUrl}/api/devices/${deviceA.id}/applications`);
    assert.strictEqual(res1.status, 401);

    const res2 = await fetch(`${baseUrl}/api/devices/${deviceA.id}/overview`);
    assert.strictEqual(res2.status, 401);

    const res3 = await fetch(`${baseUrl}/api/devices/${deviceA.id}/history`);
    assert.strictEqual(res3.status, 401);
  });

  it('accessing another users device returns 404', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;
    prisma.device.findUnique = (async ({ where }: { where: { id: string } }) => {
      if (where.id === deviceA.id) {
        return deviceA;
      }
      return null;
    }) as unknown as typeof prisma.device.findUnique;

    try {
      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/applications`, {
        headers: { Authorization: `Bearer ${strangerJwt}` },
      });
      assert.strictEqual(res.status, 404);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.error.code, 'DEVICE_NOT_FOUND');
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
    }
  });

  it('GET /api/devices/:id/applications returns installed apps by default and all with includeRemoved', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;
    const originalAppFindMany = prisma.application.findMany;

    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;

    const mockApps = [
      {
        id: 'app-1',
        deviceId: deviceA.id,
        name: 'Git for Windows',
        installedVersion: '2.50.0',
        availableVersion: '2.56.0',
        publisher: 'Git Authors',
        packageId: 'Git.Git',
        source: 'winget',
        isManaged: true,
        isInstalled: true,
        lastScannedAt: new Date('2026-11-11T12:00:00Z'),
        createdAt: new Date('2026-11-01T10:00:00Z'),
        updatedAt: new Date('2026-11-11T12:00:00Z'),
      },
      {
        id: 'app-2',
        deviceId: deviceA.id,
        name: 'Old App',
        installedVersion: '1.0.0',
        availableVersion: null,
        publisher: 'Legacy Inc',
        packageId: 'Old.App',
        source: 'winget',
        isManaged: true,
        isInstalled: false, // Uninstalled / removed!
        lastScannedAt: new Date('2026-11-01T10:00:00Z'),
        createdAt: new Date('2026-11-01T10:00:00Z'),
        updatedAt: new Date('2026-11-11T12:00:00Z'),
      },
    ];

    prisma.application.findMany = (async (args: { where: { deviceId: string; isInstalled?: boolean } }) => {
      assert.strictEqual(args.where.deviceId, deviceA.id);
      if (args.where.isInstalled === true) {
        return mockApps.filter((a) => a.isInstalled);
      }
      return mockApps;
    }) as unknown as typeof prisma.application.findMany;

    try {
      // 1. Default call: only installed apps
      const resDefault = await fetch(`${baseUrl}/api/devices/${deviceA.id}/applications`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      });
      assert.strictEqual(resDefault.status, 200);
      const bodyDefault = (await resDefault.json()) as {
        success: boolean;
        data: {
          total: number;
          applications: Array<{
            name: string;
            version: string;
            publisher: string;
            packageId: string;
            source: string;
            lastSeenAt: string;
            firstSeenAt: string;
            isInstalled: boolean;
          }>;
        };
      };
      assert.strictEqual(bodyDefault.success, true);
      assert.strictEqual(bodyDefault.data.total, 1);
      assert.strictEqual(bodyDefault.data.applications.length, 1);

      // Verify fields required by spec
      const app1 = bodyDefault.data.applications[0];
      assert.strictEqual(app1.name, 'Git for Windows');
      assert.strictEqual(app1.version, '2.50.0');
      assert.strictEqual(app1.publisher, 'Git Authors');
      assert.strictEqual(app1.packageId, 'Git.Git');
      assert.strictEqual(app1.source, 'winget');
      assert.strictEqual(app1.lastSeenAt, '2026-11-11T12:00:00.000Z');
      assert.strictEqual(app1.firstSeenAt, '2026-11-01T10:00:00.000Z');
      assert.strictEqual(app1.isInstalled, true);

      // 2. Call with includeRemoved=true
      const resAll = await fetch(`${baseUrl}/api/devices/${deviceA.id}/applications?includeRemoved=true`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      });
      assert.strictEqual(resAll.status, 200);
      const bodyAll = (await resAll.json()) as {
        success: boolean;
        data: { total: number; applications: Array<{ name: string; isInstalled: boolean }> };
      };
      assert.strictEqual(bodyAll.data.total, 2);
      assert.strictEqual(bodyAll.data.applications.length, 2);
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
      prisma.application.findMany = originalAppFindMany;
    }
  });

  it('GET /api/devices/:id/overview returns real scan metrics and status', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;
    const originalAppCount = prisma.application.count;
    const originalScanFindFirst = prisma.scanJob.findFirst;

    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;

    prisma.application.count = (async (args: { where: { isManaged?: boolean; availableVersion?: unknown } }) => {
      if (args.where.isManaged === true) return 8;
      if (args.where.availableVersion) return 2;
      return 10; // Total installed apps
    }) as unknown as typeof prisma.application.count;

    prisma.scanJob.findFirst = (async () => ({
      id: 'job-latest-scan',
      deviceId: deviceA.id,
      status: 'succeeded',
      finishedAt: new Date('2026-11-11T12:05:00Z'),
      appCount: 10,
    })) as unknown as typeof prisma.scanJob.findFirst;

    try {
      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/overview`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      });
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          totalApps: number;
          managedApps: number;
          unsupportedApps: number;
          lastScanStatus: string;
          lastScanAt: string;
        };
      };

      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.totalApps, 10);
      assert.strictEqual(body.data.managedApps, 8);
      assert.strictEqual(body.data.unsupportedApps, 2);
      assert.strictEqual(body.data.lastScanStatus, 'succeeded');
      assert.strictEqual(body.data.lastScanAt, '2026-11-11T12:05:00.000Z');
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
      prisma.application.count = originalAppCount;
      prisma.scanJob.findFirst = originalScanFindFirst;
    }
  });

  it('GET /api/devices/:id/history returns scan jobs with status, duration, appCount and errorMessage', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;
    const originalScanFindMany = prisma.scanJob.findMany;

    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;

    const mockScanJobs = [
      {
        id: 'job-scan-1',
        type: 'scan_inventory',
        status: 'succeeded',
        startedAt: new Date('2026-11-11T12:00:00Z'),
        finishedAt: new Date('2026-11-11T12:00:45Z'), // 45 seconds duration
        appCount: 150,
        errorCode: 0,
        errorMessage: null,
        createdAt: new Date('2026-11-11T12:00:00Z'),
      },
      {
        id: 'job-scan-2',
        type: 'scan_inventory',
        status: 'failed',
        startedAt: new Date('2026-11-10T10:00:00Z'),
        finishedAt: new Date('2026-11-10T10:00:10Z'), // 10 seconds duration
        appCount: 0,
        errorCode: 1,
        errorMessage: 'WinGet subprocess crashed',
        createdAt: new Date('2026-11-10T10:00:00Z'),
      },
    ];

    prisma.scanJob.findMany = (async () => mockScanJobs) as unknown as typeof prisma.scanJob.findMany;

    try {
      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/history`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      });
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as {
        success: boolean;
        data: Array<{
          id: string;
          status: string;
          duration: number;
          appCount: number;
          errorMessage: string | null;
        }>;
      };

      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.length, 2);

      // Verify job 1: succeeded, duration 45s, appCount 150
      assert.strictEqual(body.data[0].id, 'job-scan-1');
      assert.strictEqual(body.data[0].status, 'succeeded');
      assert.strictEqual(body.data[0].duration, 45);
      assert.strictEqual(body.data[0].appCount, 150);
      assert.strictEqual(body.data[0].errorMessage, null);

      // Verify job 2: failed, duration 10s, appCount 0, errorMessage populated
      assert.strictEqual(body.data[1].id, 'job-scan-2');
      assert.strictEqual(body.data[1].status, 'failed');
      assert.strictEqual(body.data[1].duration, 10);
      assert.strictEqual(body.data[1].appCount, 0);
      assert.strictEqual(body.data[1].errorMessage, 'WinGet subprocess crashed');
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
      prisma.scanJob.findMany = originalScanFindMany;
    }
  });

  it('runs a full create -> claim -> results flow and then reads applications, dashboard, and history', async () => {
    // In-memory mock database state for this device
    let inMemoryJob: Record<string, unknown> | null = null;
    const inMemoryApps: Array<Record<string, unknown>> = [];

    const originalDeviceFindUnique = prisma.device.findUnique;
    const originalDeviceUpdate = prisma.device.update;
    const originalCredFindUnique = prisma.agentCredential.findUnique;
    const originalScanFindFirst = prisma.scanJob.findFirst;
    const originalScanFindMany = prisma.scanJob.findMany;
    const originalScanCreate = prisma.scanJob.create;
    const originalScanUpdate = prisma.scanJob.update;
    const originalScanUpdateMany = prisma.scanJob.updateMany;
    const originalAuditEventCreate = prisma.auditEvent.create;
    const originalAppFindMany = prisma.application.findMany;
    const originalAppCount = prisma.application.count;
    const originalTransaction = prisma.$transaction;

    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;
    prisma.device.update = (async () => deviceA) as unknown as typeof prisma.device.update;

    prisma.agentCredential.findUnique = (async ({ where }: { where: { tokenHash: string } }) => {
      if (where.tokenHash === agentTokenHash) {
        return {
          id: 'cred-e2e',
          deviceId: deviceA.id,
          tokenHash: agentTokenHash,
          revokedAt: null,
          device: deviceA,
        };
      }
      return null;
    }) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.create = (async ({ data }: { data: Record<string, unknown> }) => {
      inMemoryJob = {
        id: 'job-e2e-flow-1',
        deviceId: deviceA.id,
        createdAt: new Date(),
        startedAt: null,
        finishedAt: null,
        status: 'queued',
        appCount: 0,
        errorCode: null,
        errorMessage: null,
        ...data,
      };
      return inMemoryJob;
    }) as unknown as typeof prisma.scanJob.create;

    prisma.auditEvent.create = (async ({ data }: { data: Record<string, unknown> }) => {
      return { id: 'audit-e2e', ...data };
    }) as unknown as typeof prisma.auditEvent.create;

    prisma.scanJob.findFirst = (async (args: { where: { deviceId: string; status?: unknown } }) => {
      if (!inMemoryJob) return null;
      if (args.where.status) {
        const statusCond = args.where.status;
        if (typeof statusCond === 'string' && inMemoryJob.status !== statusCond) return null;
        if (typeof statusCond === 'object' && 'in' in (statusCond as Record<string, unknown>)) {
          const list = (statusCond as { in: string[] }).in;
          if (!list.includes(inMemoryJob.status as string)) return null;
        }
      }
      return inMemoryJob;
    }) as unknown as typeof prisma.scanJob.findFirst;

    prisma.scanJob.findMany = (async () => {
      return inMemoryJob ? [inMemoryJob] : [];
    }) as unknown as typeof prisma.scanJob.findMany;

    prisma.scanJob.update = (async ({ data }: { data: Record<string, unknown> }) => {
      inMemoryJob = { ...inMemoryJob!, ...data };
      return inMemoryJob;
    }) as unknown as typeof prisma.scanJob.update;

    prisma.scanJob.updateMany = (async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
      if (inMemoryJob && inMemoryJob.id === where.id && inMemoryJob.status === where.status) {
        inMemoryJob = { ...inMemoryJob, ...data };
        return { count: 1 };
      }
      return { count: 0 };
    }) as unknown as typeof prisma.scanJob.updateMany;

    const mockTx = {
      application: {
        findMany: async () => inMemoryApps,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const idx = inMemoryApps.findIndex((a) => a.id === where.id);
          inMemoryApps[idx] = { ...inMemoryApps[idx], ...data };
          return inMemoryApps[idx];
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const appRecord = {
            id: `app-${inMemoryApps.length + 1}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          inMemoryApps.push(appRecord);
          return appRecord;
        },
        updateMany: async () => ({ count: 0 }),
      },
      scanJob: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          inMemoryJob = { ...inMemoryJob!, ...data };
          return inMemoryJob;
        },
      },
      device: {
        update: async () => deviceA,
      },
      auditEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'audit-tx', ...data }),
      },
    };

    prisma.$transaction = (async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: typeof mockTx) => Promise<unknown>)(mockTx);
      } else if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return arg;
    }) as unknown as typeof prisma.$transaction;

    prisma.application.findMany = (async (args: { where: { isInstalled?: boolean } }) => {
      if (args.where.isInstalled === true) {
        return inMemoryApps.filter((a) => a.isInstalled);
      }
      return inMemoryApps;
    }) as unknown as typeof prisma.application.findMany;

    prisma.application.count = (async (args: { where: { isManaged?: boolean } }) => {
      if (args.where.isManaged === true) {
        return inMemoryApps.filter((a) => a.isInstalled && a.isManaged).length;
      }
      return inMemoryApps.filter((a) => a.isInstalled).length;
    }) as unknown as typeof prisma.application.count;

    try {
      // Step 1: User creates scan job (POST /api/devices/:id/scans)
      const resCreate = await fetch(`${baseUrl}/api/devices/${deviceA.id}/scans`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerJwt}` },
      });
      assert.strictEqual(resCreate.status, 201);
      const bodyCreate = (await resCreate.json()) as { success: boolean; data: { job: { id: string; status: string } } };
      assert.strictEqual(bodyCreate.success, true);
      const jobId = bodyCreate.data.job.id;
      assert.strictEqual(bodyCreate.data.job.status, 'queued');

      // Step 2: Agent claims job (POST /api/agent/jobs/:id/claim)
      const resClaim = await fetch(`${baseUrl}/api/agent/jobs/${jobId}/claim`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agentToken}` },
      });
      assert.strictEqual(resClaim.status, 200);
      const bodyClaim = (await resClaim.json()) as { success: boolean; data: { job: { status: string } } };
      assert.strictEqual(bodyClaim.data.job.status, 'running');

      // Step 3: Agent submits results (POST /api/agent/scans/:id/results)
      const scanPayload = {
        exit_code: 0,
        discovered_packages: [
          {
            name: 'VS Code',
            package_id: 'Microsoft.VisualStudioCode',
            installed_version: '1.95.0',
            available_version: '1.96.0',
            publisher: 'Microsoft',
            source: 'winget',
            is_managed: true,
          },
          {
            name: 'Python',
            package_id: 'Python.Python.3.14',
            installed_version: '3.14.0',
            available_version: null,
            publisher: 'Python Software Foundation',
            source: 'winget',
            is_managed: true,
          },
        ],
      };

      const resResults = await fetch(`${baseUrl}/api/agent/scans/${jobId}/results`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${agentToken}`,
        },
        body: JSON.stringify(scanPayload),
      });
      assert.strictEqual(resResults.status, 200);

      // Step 4: User reads applications (GET /api/devices/:id/applications)
      const resApps = await fetch(`${baseUrl}/api/devices/${deviceA.id}/applications`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      });
      assert.strictEqual(resApps.status, 200);
      const bodyApps = (await resApps.json()) as {
        success: boolean;
        data: { total: number; applications: Array<{ name: string; version: string; publisher: string; packageId: string }> };
      };
      assert.strictEqual(bodyApps.data.total, 2);
      assert.strictEqual(bodyApps.data.applications[0].name, 'VS Code');
      assert.strictEqual(bodyApps.data.applications[0].version, '1.95.0');
      assert.strictEqual(bodyApps.data.applications[0].publisher, 'Microsoft');
      assert.strictEqual(bodyApps.data.applications[0].packageId, 'Microsoft.VisualStudioCode');

      // Step 5: User reads overview/dashboard (GET /api/devices/:id/overview)
      const resOverview = await fetch(`${baseUrl}/api/devices/${deviceA.id}/overview`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      });
      assert.strictEqual(resOverview.status, 200);
      const bodyOverview = (await resOverview.json()) as {
        success: boolean;
        data: { totalApps: number; managedApps: number; lastScanStatus: string };
      };
      assert.strictEqual(bodyOverview.data.totalApps, 2);
      assert.strictEqual(bodyOverview.data.managedApps, 2);
      assert.strictEqual(bodyOverview.data.lastScanStatus, 'succeeded');

      // Step 6: User reads history (GET /api/devices/:id/history)
      const resHistory = await fetch(`${baseUrl}/api/devices/${deviceA.id}/history`, {
        headers: { Authorization: `Bearer ${ownerJwt}` },
      });
      assert.strictEqual(resHistory.status, 200);
      const bodyHistory = (await resHistory.json()) as {
        success: boolean;
        data: Array<{ id: string; status: string; appCount: number }>;
      };
      assert.strictEqual(bodyHistory.data.length, 1);
      assert.strictEqual(bodyHistory.data[0].id, jobId);
      assert.strictEqual(bodyHistory.data[0].status, 'succeeded');
      assert.strictEqual(bodyHistory.data[0].appCount, 2);
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
      prisma.device.update = originalDeviceUpdate;
      prisma.agentCredential.findUnique = originalCredFindUnique;
      prisma.scanJob.findFirst = originalScanFindFirst;
      prisma.scanJob.findMany = originalScanFindMany;
      prisma.scanJob.create = originalScanCreate;
      prisma.scanJob.update = originalScanUpdate;
      prisma.scanJob.updateMany = originalScanUpdateMany;
      prisma.auditEvent.create = originalAuditEventCreate;
      prisma.application.findMany = originalAppFindMany;
      prisma.application.count = originalAppCount;
      prisma.$transaction = originalTransaction;
    }
  });
});
