import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';

describe('Update Detection Complete Workflow E2E Integration', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const userJwt = signToken({ sub: userId, email: 'update-e2e@example.com' });
  const deviceId = '22222222-2222-2222-2222-222222222222';
  const agentToken = 'agt_update_detection_e2e_token_001';
  const agentTokenHash = crypto.createHash('sha256').update(agentToken).digest('hex');

  let server: Server;
  let baseUrl: string;

  // Stateful in-memory database backing Prisma mock
  let dbDevices: Record<string, Record<string, unknown>> = {};
  let dbCredentials: Record<string, Record<string, unknown>> = {};
  let dbJobs: Record<string, Record<string, unknown>> = {};
  let dbApps: Record<string, Record<string, unknown>> = {};
  let dbAudits: Array<Record<string, unknown>> = [];
  let idSeq = 1;

  const nextId = (prefix: string) => `${prefix}-${idSeq++}`;

  const orig = {
    deviceFindUnique: prisma.device.findUnique,
    deviceFindFirst: prisma.device.findFirst,
    deviceUpdate: prisma.device.update,
    credFindUnique: prisma.agentCredential.findUnique,
    scanJobFindFirst: prisma.scanJob.findFirst,
    scanJobFindMany: prisma.scanJob.findMany,
    scanJobCreate: prisma.scanJob.create,
    scanJobUpdate: prisma.scanJob.update,
    scanJobUpdateMany: prisma.scanJob.updateMany,
    appFindMany: prisma.application.findMany,
    appCount: prisma.application.count,
    appCreate: prisma.application.create,
    appUpdate: prisma.application.update,
    appUpdateMany: prisma.application.updateMany,
    auditCreate: prisma.auditEvent.create,
    transaction: prisma.$transaction,
  };

  function resetDb() {
    idSeq = 1;
    dbDevices = {
      [deviceId]: {
        id: deviceId,
        userId,
        name: 'Update-Host-01',
        hostname: 'UPDATE-HOST-01',
        osVersion: 'Windows 11',
        agentVersion: '1.0.0',
        status: 'ONLINE',
        lastSeenAt: new Date('2026-11-12T10:00:00Z'),
        createdAt: new Date('2026-11-01T10:00:00Z'),
        updatedAt: new Date('2026-11-12T10:00:00Z'),
      },
    };

    dbCredentials = {
      [agentTokenHash]: {
        id: 'cred-1',
        deviceId,
        tokenHash: agentTokenHash,
        revokedAt: null,
        createdAt: new Date(),
        device: dbDevices[deviceId],
      },
    };

    dbJobs = {};
    dbApps = {};
    dbAudits = [];
  }

  before(() => {
    server = app.listen(0);
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    resetDb();

    // Wire in-memory mock handlers
    prisma.device.findUnique = (async ({ where }: { where: { id: string } }) => {
      return dbDevices[where.id] || null;
    }) as unknown as typeof prisma.device.findUnique;

    prisma.device.findFirst = (async ({ where }: { where: { userId?: string } }) => {
      return Object.values(dbDevices).find((d) => !where.userId || d.userId === where.userId) || null;
    }) as unknown as typeof prisma.device.findFirst;

    prisma.device.update = (async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const dev = dbDevices[where.id];
      if (dev) Object.assign(dev, data);
      return dev;
    }) as unknown as typeof prisma.device.update;

    prisma.agentCredential.findUnique = (async ({ where }: { where: { tokenHash: string } }) => {
      return dbCredentials[where.tokenHash] || null;
    }) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async ({ where }: { where: Record<string, unknown> }) => {
      const jobs = Object.values(dbJobs);
      return (
        jobs.find((j) => {
          for (const [k, v] of Object.entries(where)) {
            if (k === 'status' && typeof v === 'object' && v !== null && 'in' in v) {
              if (!(v as { in: string[] }).in.includes(j.status as string)) return false;
            } else if (j[k] !== v) {
              return false;
            }
          }
          return true;
        }) || null
      );
    }) as unknown as typeof prisma.scanJob.findFirst;

    prisma.scanJob.findMany = (async ({ where }: { where?: Record<string, unknown> }) => {
      let jobs = Object.values(dbJobs);
      if (where) {
        jobs = jobs.filter((j) => {
          for (const [k, v] of Object.entries(where)) {
            if (j[k] !== v) return false;
          }
          return true;
        });
      }
      return jobs;
    }) as unknown as typeof prisma.scanJob.findMany;

    prisma.scanJob.create = (async ({ data }: { data: Record<string, unknown> }) => {
      const id = nextId('job');
      const job = { id, ...data, createdAt: new Date() };
      dbJobs[id] = job;
      return job;
    }) as unknown as typeof prisma.scanJob.create;

    prisma.scanJob.update = (async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const job = dbJobs[where.id];
      if (job) Object.assign(job, data);
      return job;
    }) as unknown as typeof prisma.scanJob.update;

    prisma.scanJob.updateMany = (async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const job of Object.values(dbJobs)) {
        let match = true;
        for (const [k, v] of Object.entries(where)) {
          if (job[k] !== v) {
            match = false;
            break;
          }
        }
        if (match) {
          Object.assign(job, data);
          count++;
        }
      }
      return { count };
    }) as unknown as typeof prisma.scanJob.updateMany;

    prisma.application.findMany = (async ({ where }: { where?: Record<string, unknown> }) => {
      let apps = Object.values(dbApps);
      if (where) {
        apps = apps.filter((a) => {
          for (const [k, v] of Object.entries(where)) {
            if (k === 'id' && typeof v === 'object' && v !== null && 'in' in v) {
              if (!(v as { in: string[] }).in.includes(a.id as string)) return false;
            } else if (k === 'availableVersion' && typeof v === 'object' && v !== null && 'not' in v) {
              if (a.availableVersion === null || a.availableVersion === undefined) return false;
            } else if (a[k] !== v) {
              return false;
            }
          }
          return true;
        });
      }
      return apps;
    }) as unknown as typeof prisma.application.findMany;

    prisma.application.count = (async ({ where }: { where?: Record<string, unknown> }) => {
      const apps = (await (prisma.application.findMany as unknown as (arg: { where?: Record<string, unknown> }) => Promise<unknown[]>)({ where }));
      return apps.length;
    }) as unknown as typeof prisma.application.count;

    prisma.application.create = (async ({ data }: { data: Record<string, unknown> }) => {
      const id = nextId('app');
      const appRow = {
        id,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      dbApps[id] = appRow;
      return appRow;
    }) as unknown as typeof prisma.application.create;

    prisma.application.update = (async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const appRow = dbApps[where.id];
      if (appRow) Object.assign(appRow, data, { updatedAt: new Date() });
      return appRow;
    }) as unknown as typeof prisma.application.update;

    prisma.application.updateMany = (async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const appRow of Object.values(dbApps)) {
        let match = true;
        for (const [k, v] of Object.entries(where)) {
          if (k === 'id' && typeof v === 'object' && v !== null && 'in' in v) {
            if (!(v as { in: string[] }).in.includes(appRow.id as string)) match = false;
          } else if (appRow[k] !== v) {
            match = false;
          }
        }
        if (match) {
          Object.assign(appRow, data, { updatedAt: new Date() });
          count++;
        }
      }
      return { count };
    }) as unknown as typeof prisma.application.updateMany;

    prisma.auditEvent.create = (async ({ data }: { data: Record<string, unknown> }) => {
      const audit = { id: nextId('audit'), ...data, createdAt: new Date() };
      dbAudits.push(audit);
      return audit;
    }) as unknown as typeof prisma.auditEvent.create;

    prisma.$transaction = (async (input: unknown) => {
      if (typeof input === 'function') {
        return (input as (tx: typeof prisma) => Promise<unknown>)(prisma);
      }
      if (Array.isArray(input)) {
        return Promise.all(input);
      }
      return input;
    }) as unknown as typeof prisma.$transaction;
  });

  after(() => {
    prisma.device.findUnique = orig.deviceFindUnique;
    prisma.device.findFirst = orig.deviceFindFirst;
    prisma.device.update = orig.deviceUpdate;
    prisma.agentCredential.findUnique = orig.credFindUnique;
    prisma.scanJob.findFirst = orig.scanJobFindFirst;
    prisma.scanJob.findMany = orig.scanJobFindMany;
    prisma.scanJob.create = orig.scanJobCreate;
    prisma.scanJob.update = orig.scanJobUpdate;
    prisma.scanJob.updateMany = orig.scanJobUpdateMany;
    prisma.application.findMany = orig.appFindMany;
    prisma.application.count = orig.appCount;
    prisma.application.create = orig.appCreate;
    prisma.application.update = orig.appUpdate;
    prisma.application.updateMany = orig.appUpdateMany;
    prisma.auditEvent.create = orig.auditCreate;
    prisma.$transaction = orig.transaction;

    server.close();
  });

  it('runs complete scanning -> update check -> applications & overview verification workflow', async () => {
    resetDb();

    // 1. User queues an inventory scan
    const scanRes = await fetch(`${baseUrl}/api/devices/${deviceId}/scans`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    assert.strictEqual(scanRes.status, 201);
    const scanBody = (await scanRes.json()) as { data: { job: { id: string } } };
    const scanJobId = scanBody.data.job.id;

    // 2. Agent claims the scan job
    const claimRes = await fetch(`${baseUrl}/api/agent/jobs/${scanJobId}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    assert.strictEqual(claimRes.status, 200);

    // 3. Agent submits scan results with mixed applications
    const scanPayload = {
      exit_code: 0,
      discovered_packages: [
        {
          name: 'Git for Windows',
          package_id: 'Git.Git',
          installed_version: '2.50.0',
          publisher: 'Git Authors',
          source: 'winget',
          is_managed: true,
        },
        {
          name: '7-Zip',
          package_id: '7zip.7zip',
          installed_version: '23.01',
          publisher: 'Igor Pavlov',
          source: 'winget',
          is_managed: true,
        },
        {
          name: 'GitHub Desktop',
          package_id: 'GitHub.GitHubDesktop',
          installed_version: '3.6.7',
          publisher: 'GitHub',
          source: 'winget',
          is_managed: true,
        },
        {
          name: 'Custom Internal Tool',
          package_id: 'Custom.UnknownVer',
          installed_version: 'unknown',
          publisher: 'Internal Org',
          source: 'winget',
          is_managed: true,
        },
        {
          name: 'Legacy Accounting Registry App',
          package_id: null,
          installed_version: '1.0.0',
          publisher: 'Old Corp',
          source: 'registry',
          is_managed: false,
        },
      ],
    };

    const submitScanRes = await fetch(`${baseUrl}/api/agent/scans/${scanJobId}/results`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(scanPayload),
    });
    assert.strictEqual(submitScanRes.status, 200);

    // 4. Verify scan completion automatically queued a check_updates job
    const autoCheckJob = Object.values(dbJobs).find(
      (j) => j.type === 'check_updates' && j.status === 'queued'
    );
    assert.ok(autoCheckJob, 'check_updates job should be auto-queued after scan');
    const updateJobId = autoCheckJob.id as string;

    // 5. Agent claims the check_updates job
    const claimUpdRes = await fetch(`${baseUrl}/api/agent/jobs/${updateJobId}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    assert.strictEqual(claimUpdRes.status, 200);

    // 6. Agent submits check_updates results:
    // - Git.Git: older than 2.56.0 -> update_available
    // - 7zip.7zip: same version (23.01) -> up_to_date with warning
    // - Custom.UnknownVer: installed is unknown -> unknown (never guessed)
    // - Unmatched.Ghost: not in matched apps -> ignored
    // - GitHub.GitHubDesktop: omitted from updates -> marked up_to_date
    const updateCheckPayload = {
      winget_available: true,
      updates: [
        {
          name: 'Git',
          package_id: 'Git.Git',
          installed_version: '2.50.0',
          available_version: '2.56.0',
          source: 'winget',
        },
        {
          name: '7-Zip',
          package_id: '7zip.7zip',
          installed_version: '23.01',
          available_version: '23.01',
          source: 'winget',
        },
        {
          name: 'Custom Tool',
          package_id: 'Custom.UnknownVer',
          installed_version: 'unknown',
          available_version: '2.0.0',
          source: 'winget',
        },
        {
          name: 'Ghost App',
          package_id: 'Unmatched.Ghost.Package',
          installed_version: '1.0.0',
          available_version: '5.0.0',
          source: 'winget',
        },
      ],
      warnings: [],
      errors: [],
    };

    const submitUpdRes = await fetch(`${baseUrl}/api/agent/update-checks/${updateJobId}/results`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updateCheckPayload),
    });
    assert.strictEqual(submitUpdRes.status, 200);
    const submitUpdBody = (await submitUpdRes.json()) as {
      success: boolean;
      data: { checkedCount: number; updatesAvailableCount: number; unknownCount: number };
    };
    assert.strictEqual(submitUpdBody.success, true);
    assert.strictEqual(submitUpdBody.data.checkedCount, 4); // 4 matched apps
    assert.strictEqual(submitUpdBody.data.updatesAvailableCount, 1); // Git
    assert.strictEqual(submitUpdBody.data.unknownCount, 1); // Custom.UnknownVer

    // 7. Verify Applications API returns proper updateStatus, availableVersion, and updateCheckedAt
    const appsRes = await fetch(`${baseUrl}/api/devices/${deviceId}/applications`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    assert.strictEqual(appsRes.status, 200);
    const appsBody = (await appsRes.json()) as {
      data: {
        applications: Array<{
          name: string;
          packageId: string | null;
          updateStatus: string;
          availableVersion: string | null;
          updateCheckedAt: string | null;
          matchStatus: string;
        }>;
      };
    };

    const apps = appsBody.data.applications;

    // Git.Git -> update_available
    const git = apps.find((a) => a.packageId === 'Git.Git')!;
    assert.strictEqual(git.updateStatus, 'update_available');
    assert.strictEqual(git.availableVersion, '2.56.0');
    assert.ok(git.updateCheckedAt);

    // 7zip.7zip -> up_to_date (comparison evaluated same)
    const zip = apps.find((a) => a.packageId === '7zip.7zip')!;
    assert.strictEqual(zip.updateStatus, 'up_to_date');
    assert.strictEqual(zip.availableVersion, null);
    assert.ok(zip.updateCheckedAt);

    // GitHub.GitHubDesktop -> up_to_date (not listed in upgrades)
    const gh = apps.find((a) => a.packageId === 'GitHub.GitHubDesktop')!;
    assert.strictEqual(gh.updateStatus, 'up_to_date');
    assert.strictEqual(gh.availableVersion, null);
    assert.ok(gh.updateCheckedAt);

    // Custom.UnknownVer -> unknown (installed was unknown, never guessed)
    const unk = apps.find((a) => a.packageId === 'Custom.UnknownVer')!;
    assert.strictEqual(unk.updateStatus, 'unknown');
    assert.strictEqual(unk.availableVersion, null);
    assert.ok(unk.updateCheckedAt);

    // Legacy.RegistryApp -> not_checked (unmatched registry app was untouched)
    const reg = apps.find((a) => a.name === 'Legacy Accounting Registry App')!;
    assert.strictEqual(reg.matchStatus, 'unsupported');
    assert.strictEqual(reg.updateStatus, 'not_checked');

    // 8. Test Applications API filtering by updateStatus
    const filterAvailRes = await fetch(
      `${baseUrl}/api/devices/${deviceId}/applications?updateStatus=update_available`,
      { headers: { Authorization: `Bearer ${userJwt}` } }
    );
    const filterAvailBody = (await filterAvailRes.json()) as { data: { applications: Array<{ packageId: string }> } };
    assert.strictEqual(filterAvailBody.data.applications.length, 1);
    assert.strictEqual(filterAvailBody.data.applications[0].packageId, 'Git.Git');

    const filterUpToDateRes = await fetch(
      `${baseUrl}/api/devices/${deviceId}/applications?updateStatus=up_to_date`,
      { headers: { Authorization: `Bearer ${userJwt}` } }
    );
    const filterUpToDateBody = (await filterUpToDateRes.json()) as { data: { applications: Array<{ packageId: string }> } };
    assert.strictEqual(filterUpToDateBody.data.applications.length, 2);

    const filterUnkRes = await fetch(
      `${baseUrl}/api/devices/${deviceId}/applications?updateStatus=unknown`,
      { headers: { Authorization: `Bearer ${userJwt}` } }
    );
    const filterUnkBody = (await filterUnkRes.json()) as { data: { applications: Array<{ packageId: string }> } };
    assert.strictEqual(filterUnkBody.data.applications.length, 1);
    assert.strictEqual(filterUnkBody.data.applications[0].packageId, 'Custom.UnknownVer');

    // 9. Verify Dashboard Overview metrics
    const overviewRes = await fetch(`${baseUrl}/api/devices/${deviceId}/overview`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    assert.strictEqual(overviewRes.status, 200);
    const overviewBody = (await overviewRes.json()) as {
      data: {
        updatesAvailableCount: number;
        upToDateCount: number;
        unknownUpdateCount: number;
        metrics: {
          updates_available_count: number;
          up_to_date_count: number;
          unknown_update_count: number;
        };
      };
    };

    assert.strictEqual(overviewBody.data.updatesAvailableCount, 1);
    assert.strictEqual(overviewBody.data.upToDateCount, 2);
    assert.strictEqual(overviewBody.data.unknownUpdateCount, 1);
    assert.strictEqual(overviewBody.data.metrics.updates_available_count, 1);
    assert.strictEqual(overviewBody.data.metrics.up_to_date_count, 2);
    assert.strictEqual(overviewBody.data.metrics.unknown_update_count, 1);

    // 10. WinGet Missing Edge Case:
    // Queue an update check and report winget_available: false
    const manualCheckRes = await fetch(`${baseUrl}/api/devices/${deviceId}/update-checks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    assert.strictEqual(manualCheckRes.status, 201);
    const manualCheckBody = (await manualCheckRes.json()) as { data: { job: { id: string } } };
    const missingWingetJobId = manualCheckBody.data.job.id;

    // Claim
    await fetch(`${baseUrl}/api/agent/jobs/${missingWingetJobId}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
    });

    // Submit with winget_available: false
    const missingWingetRes = await fetch(
      `${baseUrl}/api/agent/update-checks/${missingWingetJobId}/results`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${agentToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          winget_available: false,
          updates: [],
          warnings: ['WinGet executable not found on Windows host'],
        }),
      }
    );
    assert.strictEqual(missingWingetRes.status, 200);

    // Verify remaining matched apps were marked unknown (never falsely assumed up_to_date)
    const appsAfterMissing = await prisma.application.findMany({
      where: { deviceId, matchStatus: 'matched' },
    });
    for (const appRow of appsAfterMissing) {
      assert.strictEqual(
        appRow.updateStatus,
        'unknown',
        `App ${appRow.name} must be marked unknown when WinGet is missing`
      );
    }

    // 11. Confirm NO install commands were ever executed or queued
    for (const audit of dbAudits) {
      assert.notEqual(
        audit.eventType,
        'INSTALL_EXECUTED',
        'No install command must exist'
      );
      assert.notEqual(
        audit.eventType,
        'PACKAGE_INSTALL',
        'No package install must be initiated during update checks'
      );
    }
  });
});
