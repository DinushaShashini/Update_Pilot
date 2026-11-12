import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';

describe('Update-Check Jobs & Results Storage API', () => {
  const ownerId = '11111111-1111-1111-1111-111111111111';
  const strangerId = '22222222-2222-2222-2222-222222222222';
  const ownerJwt = signToken({ sub: ownerId, email: 'owner@example.com' });
  const strangerJwt = signToken({ sub: strangerId, email: 'stranger@example.com' });

  const deviceA = {
    id: 'dev-upd-a',
    userId: ownerId,
    name: 'Device A',
    hostname: 'DEV-A',
    status: 'ONLINE',
  };
  const deviceB = {
    id: 'dev-upd-b',
    userId: strangerId,
    name: 'Device B',
    hostname: 'DEV-B',
    status: 'ONLINE',
  };

  const tokenA = 'agt_update_check_token_a';
  const tokenAHash = crypto.createHash('sha256').update(tokenA).digest('hex');

  let server: Server;
  let baseUrl: string;

  const orig = {
    deviceFindUnique: prisma.device.findUnique,
    credFindUnique: prisma.agentCredential.findUnique,
    scanJobFindFirst: prisma.scanJob.findFirst,
    scanJobCreate: prisma.scanJob.create,
    auditCreate: prisma.auditEvent.create,
    transaction: prisma.$transaction,
  };

  before(() => {
    server = app.listen(0);
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    prisma.device.findUnique = orig.deviceFindUnique;
    prisma.agentCredential.findUnique = orig.credFindUnique;
    prisma.scanJob.findFirst = orig.scanJobFindFirst;
    prisma.scanJob.create = orig.scanJobCreate;
    prisma.auditEvent.create = orig.auditCreate;
    prisma.$transaction = orig.transaction;
    server.close();
  });

  it('POST /api/devices/:id/update-checks creates queued job for owner, rejects stranger (404) and duplicate active job (409)', async () => {
    let activeJob: Record<string, unknown> | null = null;

    prisma.device.findUnique = (async ({ where }: { where: { id: string } }) => {
      if (where.id === deviceA.id) return deviceA;
      if (where.id === deviceB.id) return deviceB;
      return null;
    }) as unknown as typeof prisma.device.findUnique;

    prisma.scanJob.findFirst = (async () => activeJob) as unknown as typeof prisma.scanJob.findFirst;
    prisma.scanJob.create = (async ({ data }: { data: Record<string, unknown> }) => {
      activeJob = { id: 'job-upd-1', ...data, createdAt: new Date() };
      return activeJob;
    }) as unknown as typeof prisma.scanJob.create;
    prisma.auditEvent.create = (async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'audit-1',
      ...data,
    })) as unknown as typeof prisma.auditEvent.create;
    prisma.$transaction = (async (ops: Array<Promise<unknown>>) => Promise.all(ops)) as unknown as typeof prisma.$transaction;

    // 1. Stranger gets 404
    const resStranger = await fetch(`${baseUrl}/api/devices/${deviceA.id}/update-checks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${strangerJwt}` },
    });
    assert.equal(resStranger.status, 404);

    // 2. Owner creates update-check job -> 201
    const resCreate = await fetch(`${baseUrl}/api/devices/${deviceA.id}/update-checks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    assert.equal(resCreate.status, 201);
    const createdBody = (await resCreate.json()) as { data: { job: { id: string; type: string; status: string } } };
    assert.equal(createdBody.data.job.type, 'check_updates');
    assert.equal(createdBody.data.job.status, 'queued');

    // 3. Duplicate active job -> 409 with existingJobId
    const resDup = await fetch(`${baseUrl}/api/devices/${deviceA.id}/update-checks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    assert.equal(resDup.status, 409);
    const dupBody = (await resDup.json()) as { error: { existingJobId: string } };
    assert.equal(dupBody.error.existingJobId, 'job-upd-1');
  });

  it('POST /api/agent/update-checks/:id/results updates matched apps, marks others up_to_date, handles unknown versions, and ignores unknown IDs', async () => {
    prisma.agentCredential.findUnique = (async ({ where }: { where: { tokenHash: string } }) => {
      if (where.tokenHash === tokenAHash) {
        return { id: 'cred-a', deviceId: deviceA.id, revokedAt: null, device: deviceA };
      }
      return null;
    }) as unknown as typeof prisma.agentCredential.findUnique;

    prisma.scanJob.findFirst = (async ({ where }: { where: { id: string; deviceId: string } }) => {
      if (where.id === 'job-upd-run' && where.deviceId === deviceA.id) {
        return {
          id: 'job-upd-run',
          deviceId: deviceA.id,
          type: 'check_updates',
          status: 'running',
        };
      }
      return null;
    }) as unknown as typeof prisma.scanJob.findFirst;

    const dbApps = [
      {
        id: 'app-git',
        deviceId: deviceA.id,
        packageId: 'Git.Git',
        matchedPackageId: 'Git.Git',
        isInstalled: true,
        matchStatus: 'matched',
        updateStatus: 'not_checked',
        availableVersion: null,
      },
      {
        id: 'app-7zip',
        deviceId: deviceA.id,
        packageId: '7zip.7zip',
        matchedPackageId: '7zip.7zip',
        isInstalled: true,
        matchStatus: 'matched',
        updateStatus: 'not_checked',
        availableVersion: null,
      },
      {
        id: 'app-unknown-ver',
        deviceId: deviceA.id,
        packageId: 'Vendor.UnknownVer',
        matchedPackageId: 'Vendor.UnknownVer',
        isInstalled: true,
        matchStatus: 'matched',
        updateStatus: 'not_checked',
        availableVersion: null,
      },
    ];

    const updatedAppRows: Array<{ id: string; data: Record<string, unknown> }> = [];
    let upToDateIds: string[] = [];
    let updatedJob: Record<string, unknown> | null = null;
    let auditMetadata: Record<string, unknown> | null = null;

    const mockTx = {
      application: {
        findMany: async () => dbApps,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updatedAppRows.push({ id: where.id, data });
          return { id: where.id, ...data };
        },
        updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          upToDateIds = where.id.in;
          return { count: upToDateIds.length };
        },
      },
      scanJob: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updatedJob = data;
          return { id: 'job-upd-run', ...data };
        },
      },
      device: {
        update: async ({ data }: { data: Record<string, unknown> }) => ({ id: deviceA.id, ...data }),
      },
      auditEvent: {
        create: async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
          auditMetadata = data.metadata;
          return { id: 'audit-upd', ...data };
        },
      },
    };

    prisma.$transaction = (async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)) as unknown as typeof prisma.$transaction;

    const res = await fetch(`${baseUrl}/api/agent/update-checks/job-upd-run/results`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
            name: 'Unknown Ver Tool',
            package_id: 'Vendor.UnknownVer',
            installed_version: 'unknown',
            available_version: '2.0.0',
            source: 'winget',
          },
          {
            name: 'Unmatched or Unknown Package',
            package_id: 'NonExistent.OrUnmatched',
            installed_version: '1.0.0',
            available_version: '2.0.0',
            source: 'winget',
          },
        ],
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      data: { checkedCount: number; updatesAvailableCount: number; unknownCount: number };
    };
    assert.equal(body.success, true);
    assert.equal(body.data.checkedCount, 3);
    assert.equal(body.data.updatesAvailableCount, 1);
    assert.equal(body.data.unknownCount, 1);

    // Git.Git marked update_available
    const gitUpd = updatedAppRows.find((r) => r.id === 'app-git');
    assert.ok(gitUpd);
    assert.equal(gitUpd.data.updateStatus, 'update_available');
    assert.equal(gitUpd.data.availableVersion, '2.56.0');

    // Vendor.UnknownVer marked unknown (never guessed)
    const unkUpd = updatedAppRows.find((r) => r.id === 'app-unknown-ver');
    assert.ok(unkUpd);
    assert.equal(unkUpd.data.updateStatus, 'unknown');
    assert.equal(unkUpd.data.availableVersion, null);

    // 7zip.7zip marked up_to_date
    assert.deepEqual(upToDateIds, ['app-7zip']);

    // Unknown ID ignored
    assert.ok(auditMetadata);
    assert.equal((auditMetadata as Record<string, unknown>).ignoredCount, 1);
    assert.ok(updatedJob);
    assert.equal((updatedJob as Record<string, unknown>).status, 'succeeded');
  });

  it('rejects wrong-device agent submission with 404 and rolls back on transaction error', async () => {
    prisma.agentCredential.findUnique = (async ({ where }: { where: { tokenHash: string } }) => {
      if (where.tokenHash === tokenAHash) {
        return { id: 'cred-a', deviceId: deviceA.id, revokedAt: null, device: deviceA };
      }
      return null;
    }) as unknown as typeof prisma.agentCredential.findUnique;

    // 1. Job belongs to deviceB -> deviceA gets 404
    prisma.scanJob.findFirst = (async ({ where }: { where: { deviceId: string } }) => {
      if (where.deviceId === deviceB.id) {
        return { id: 'job-b', deviceId: deviceB.id, type: 'check_updates', status: 'running' };
      }
      return null;
    }) as unknown as typeof prisma.scanJob.findFirst;

    const wrongDevRes = await fetch(`${baseUrl}/api/agent/update-checks/job-b/results`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ winget_available: true, updates: [] }),
    });
    assert.equal(wrongDevRes.status, 404);

    // 2. Rollback on transaction error -> 500
    prisma.scanJob.findFirst = (async () => ({
      id: 'job-a-err',
      deviceId: deviceA.id,
      type: 'check_updates',
      status: 'running',
    })) as unknown as typeof prisma.scanJob.findFirst;

    prisma.$transaction = (async () => {
      throw new Error('Simulated DB write failure');
    }) as unknown as typeof prisma.$transaction;

    const errRes = await fetch(`${baseUrl}/api/agent/update-checks/job-a-err/results`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ winget_available: true, updates: [] }),
    });
    assert.equal(errRes.status, 500);
  });
});
