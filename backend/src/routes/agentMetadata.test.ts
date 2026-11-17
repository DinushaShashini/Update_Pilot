import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';

describe('Package Metadata Job & Result Storage API', () => {
  let server: Server;
  let baseUrl: string;

  const userId = '11111111-1111-1111-1111-111111111111';
  const otherUserId = '99999999-9999-9999-9999-999999999999';
  const deviceId = '22222222-2222-2222-2222-222222222222';
  const agentToken = 'agent-token-test-xyz';
  const agentTokenHash = crypto.createHash('sha256').update(agentToken).digest('hex');

  const userJwt = signToken({ sub: userId, email: 'dinusha@example.com' });
  const otherJwt = signToken({ sub: otherUserId, email: 'attacker@example.com' });

  let dbDevices: Record<string, Record<string, unknown>> = {};
  let dbCredentials: Record<string, Record<string, unknown>> = {};
  let dbJobs: Record<string, Record<string, unknown>> = {};
  let dbApps: Record<string, Record<string, unknown>> = {};
  let dbMeta: Record<string, Record<string, unknown>> = {};
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
    packageMetadataFindUnique: prisma.packageMetadata.findUnique,
    packageMetadataUpsert: prisma.packageMetadata.upsert,
    auditCreate: prisma.auditEvent.create,
    transaction: prisma.$transaction,
  };

  function resetDb() {
    idSeq = 1;
    dbDevices = {
      [deviceId]: {
        id: deviceId,
        userId,
        name: 'Metadata-Host',
        hostname: 'META-HOST',
        osVersion: 'Windows 11',
        agentVersion: '1.0.0',
        status: 'ONLINE',
        lastSeenAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
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
    dbApps = {
      'app-1': {
        id: 'app-1',
        deviceId,
        packageId: 'Git.Git',
        matchedPackageId: 'Git.Git',
        name: 'Git for Windows',
        installedVersion: '2.50.0',
        availableVersion: '2.56.0',
        updateStatus: 'update_available',
        isInstalled: true,
      },
      'app-2': {
        id: 'app-2',
        deviceId,
        packageId: '7zip.7zip',
        matchedPackageId: '7zip.7zip',
        name: '7-Zip',
        installedVersion: '23.01',
        availableVersion: '24.08',
        updateStatus: 'update_available',
        isInstalled: true,
      },
      'app-3': {
        id: 'app-3',
        deviceId,
        packageId: 'Notepad++.Notepad++',
        matchedPackageId: 'Notepad++.Notepad++',
        name: 'Notepad++',
        installedVersion: '8.6.2',
        availableVersion: null,
        updateStatus: 'up_to_date',
        isInstalled: true,
      },
    };
    dbMeta = {};
    dbAudits = [];
  }

  before(() => {
    server = app.listen(0);
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    resetDb();

    prisma.device.findUnique = (async ({ where }: { where: { id: string } }) => {
      return dbDevices[where.id] || null;
    }) as unknown as typeof prisma.device.findUnique;

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

    prisma.application.findMany = (async ({ where }: { where?: Record<string, unknown> }) => {
      let apps = Object.values(dbApps);
      if (where) {
        apps = apps.filter((a) => {
          for (const [k, v] of Object.entries(where)) {
            if (a[k] !== v) return false;
          }
          return true;
        });
      }
      return apps;
    }) as unknown as typeof prisma.application.findMany;

    prisma.packageMetadata.findUnique = (async ({
      where,
    }: {
      where: { packageId_version: { packageId: string; version: string } };
    }) => {
      const key = `${where.packageId_version.packageId.toLowerCase()}@${where.packageId_version.version.toLowerCase()}`;
      return dbMeta[key] || null;
    }) as unknown as typeof prisma.packageMetadata.findUnique;

    prisma.packageMetadata.upsert = (async ({
      where,
      create,
      update,
    }: {
      where: { packageId_version: { packageId: string; version: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const key = `${where.packageId_version.packageId.toLowerCase()}@${where.packageId_version.version.toLowerCase()}`;
      const existing = dbMeta[key];
      if (existing) {
        const updated = { ...existing, ...update, updatedAt: new Date() };
        dbMeta[key] = updated;
        return updated;
      }
      const created = { id: nextId('meta'), ...create, createdAt: new Date(), updatedAt: new Date() };
      dbMeta[key] = created;
      return created;
    }) as unknown as typeof prisma.packageMetadata.upsert;

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
    prisma.device.update = orig.deviceUpdate;
    prisma.agentCredential.findUnique = orig.credFindUnique;
    prisma.scanJob.findFirst = orig.scanJobFindFirst;
    prisma.scanJob.findMany = orig.scanJobFindMany;
    prisma.scanJob.create = orig.scanJobCreate;
    prisma.scanJob.update = orig.scanJobUpdate;
    prisma.scanJob.updateMany = orig.scanJobUpdateMany;
    prisma.application.findMany = orig.appFindMany;
    prisma.packageMetadata.findUnique = orig.packageMetadataFindUnique;
    prisma.packageMetadata.upsert = orig.packageMetadataUpsert;
    prisma.auditEvent.create = orig.auditCreate;
    prisma.$transaction = orig.transaction;

    server.close();
  });

  it('queues a get_package_metadata job when metadata is missing or stale', async () => {
    resetDb();

    // 1. Both Git and 7zip have updateStatus = update_available and NO cache -> queues job
    const res = await fetch(`${baseUrl}/api/devices/${deviceId}/metadata-jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userJwt}` },
    });

    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        queued: boolean;
        job: { id: string; type: string; appCount: number };
        packagesToFetch: Array<{ packageId: string; version: string }>;
      };
    };

    assert.strictEqual(body.success, true);
    assert.strictEqual(body.data.queued, true);
    assert.strictEqual(body.data.job.type, 'get_package_metadata');
    assert.strictEqual(body.data.job.appCount, 2);
    assert.strictEqual(body.data.packagesToFetch.length, 2);

    // 2. Concurrency: trying to queue while job is queued returns 409
    const dupRes = await fetch(`${baseUrl}/api/devices/${deviceId}/metadata-jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    assert.strictEqual(dupRes.status, 409);
  });

  it('serves from cache and does NOT queue job when all metadata is fresh', async () => {
    resetDb();

    // Pre-populate fresh cache for both Git and 7zip
    const futureDate = new Date(Date.now() + 20 * 60 * 60 * 1000);
    dbMeta['git.git@2.56.0'] = {
      packageId: 'Git.Git',
      version: '2.56.0',
      publisher: 'The Git Development Community',
      fetchStatus: 'success',
      expiresAt: futureDate,
    };
    dbMeta['7zip.7zip@24.08'] = {
      packageId: '7zip.7zip',
      version: '24.08',
      publisher: 'Igor Pavlov',
      fetchStatus: 'success',
      expiresAt: futureDate,
    };

    const res = await fetch(`${baseUrl}/api/devices/${deviceId}/metadata-jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userJwt}` },
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      data: { queued: boolean; freshCount: number; packagesToFetch: unknown[] };
    };
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.data.queued, false);
    assert.strictEqual(body.data.freshCount, 2);
    assert.strictEqual(body.data.packagesToFetch.length, 0);
  });

  it('agent submits metadata results, stores them in cache, and marks job succeeded', async () => {
    resetDb();

    // Create a running metadata job
    const jobId = nextId('job');
    dbJobs[jobId] = {
      id: jobId,
      deviceId,
      type: 'get_package_metadata',
      status: 'running',
    };

    const metadataPayload = {
      packages: [
        {
          package_id: 'Git.Git',
          version: '2.56.0',
          publisher: 'The Git Development Community',
          homepage_url: 'https://git-scm.com',
          publisher_url: 'https://git-scm.com',
          release_notes_url: 'https://git-scm.com/relnotes',
          release_notes_text: '* Security updates in 2.56.0\n* Bug fixes',
          installer_type: 'inno',
          fetch_status: 'success',
        },
        {
          package_id: '7zip.7zip',
          version: '24.08',
          publisher: 'Igor Pavlov',
          homepage_url: 'https://www.7-zip.org',
          publisher_url: 'https://www.7-zip.org',
          release_notes_url: null,
          release_notes_text: null,
          installer_type: 'nullsoft',
          fetch_status: 'success',
        },
      ],
      warnings: [],
      errors: [],
    };

    const submitRes = await fetch(`${baseUrl}/api/agent/metadata/${jobId}/results`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(metadataPayload),
    });

    assert.strictEqual(submitRes.status, 200);
    const submitBody = (await submitRes.json()) as { success: boolean; data: { status: string; packageCount: number } };
    assert.strictEqual(submitBody.success, true);
    assert.strictEqual(submitBody.data.status, 'succeeded');
    assert.strictEqual(submitBody.data.packageCount, 2);

    // Verify cache has both records
    const gitCached = dbMeta['git.git@2.56.0'];
    assert.ok(gitCached);
    assert.strictEqual(gitCached.publisher, 'The Git Development Community');
    assert.strictEqual(gitCached.releaseNotesUrl, 'https://git-scm.com/relnotes');
    assert.strictEqual(gitCached.fetchStatus, 'success');

    const zipCached = dbMeta['7zip.7zip@24.08'];
    assert.ok(zipCached);
    assert.strictEqual(zipCached.publisher, 'Igor Pavlov');
    assert.strictEqual(zipCached.releaseNotesUrl, null);
    assert.strictEqual(zipCached.fetchStatus, 'success');

    // Verify job updated to succeeded
    assert.strictEqual(dbJobs[jobId].status, 'succeeded');
  });

  it('agent submits metadata failure and marks job failed', async () => {
    resetDb();

    const jobId = nextId('job');
    dbJobs[jobId] = {
      id: jobId,
      deviceId,
      type: 'get_package_metadata',
      status: 'running',
    };

    const failRes = await fetch(`${baseUrl}/api/agent/metadata/${jobId}/failure`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        error_code: 1,
        error_message: 'WinGet CLI unavailable',
      }),
    });

    assert.strictEqual(failRes.status, 200);
    assert.strictEqual(dbJobs[jobId].status, 'failed');
    assert.strictEqual(dbJobs[jobId].errorMessage, 'WinGet CLI unavailable');
  });

  it('enforces authentication and authorization on metadata job endpoints', async () => {
    resetDb();

    // Unauthenticated
    const unauthRes = await fetch(`${baseUrl}/api/devices/${deviceId}/metadata-jobs`, {
      method: 'POST',
    });
    assert.strictEqual(unauthRes.status, 401);

    // Other user
    const otherRes = await fetch(`${baseUrl}/api/devices/${deviceId}/metadata-jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${otherJwt}` },
    });
    assert.strictEqual(otherRes.status, 404);
  });
});
