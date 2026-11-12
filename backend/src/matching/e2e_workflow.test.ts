import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';
import { DEFAULT_KNOWN_PACKAGES } from './fuzzy.js';

describe('Complete Scanning & Matching Workflow E2E Integration', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const userJwt = signToken({ sub: userId, email: 'e2e@example.com' });
  const deviceId = '22222222-2222-2222-2222-222222222222';
  const agentToken = 'agt_e2e_test_secret_token_0001';
  const agentTokenHash = crypto.createHash('sha256').update(agentToken).digest('hex');

  let server: Server;
  let baseUrl: string;

  // Stateful in-memory database backing the Prisma mock
  let dbDevices: Record<string, Record<string, unknown>> = {};
  let dbCredentials: Record<string, Record<string, unknown>> = {};
  let dbJobs: Record<string, Record<string, unknown>> = {};
  let dbApps: Record<string, Record<string, unknown>> = {};
  let dbAudits: Array<Record<string, unknown>> = [];
  let idSeq = 1;

  const nextId = (prefix: string) => `${prefix}-${idSeq++}`;

  // Originals for restoration
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
        name: 'Workstation-E2E',
        hostname: 'WORKSTATION-E2E',
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
        id: 'cred-e2e',
        deviceId,
        tokenHash: agentTokenHash,
        revokedAt: null,
        device: dbDevices[deviceId],
      },
    };
    dbJobs = {};
    dbApps = {};
    dbAudits = [];
  }

  function matchWhere(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (k === 'id' && typeof v === 'object' && v !== null && 'in' in v) {
        if (!(v as { in: string[] }).in.includes(row.id as string)) return false;
        continue;
      }
      if (k === 'status' && typeof v === 'object' && v !== null && 'in' in v) {
        if (!(v as { in: string[] }).in.includes(row.status as string)) return false;
        continue;
      }
      if (k === 'availableVersion' && typeof v === 'object' && v !== null && 'not' in v && (v as { not: null }).not === null) {
        if (row.availableVersion === null || row.availableVersion === undefined) return false;
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  }

  function buildMockClient() {
    return {
      device: {
        findUnique: async ({ where }: { where: { id: string } }) => dbDevices[where.id] || null,
        findFirst: async ({ where }: { where: { userId?: string } }) =>
          Object.values(dbDevices).find((d) => matchWhere(d, where)) || null,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (dbDevices[where.id]) {
            Object.assign(dbDevices[where.id], data);
          }
          return dbDevices[where.id];
        },
      },
      agentCredential: {
        findUnique: async ({ where }: { where: { tokenHash: string } }) => dbCredentials[where.tokenHash] || null,
      },
      scanJob: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const matches = Object.values(dbJobs).filter((j) => matchWhere(j, where));
          matches.sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
          return matches[0] || null;
        },
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          Object.values(dbJobs)
            .filter((j) => matchWhere(j, where))
            .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const id = nextId('job');
          const row = {
            id,
            progressPercent: 0,
            progressStep: 'queued',
            progressMessage: null,
            skippedSteps: [],
            startedAt: null,
            finishedAt: null,
            errorCode: null,
            errorMessage: null,
            appCount: 0,
            matchedCount: 0,
            ambiguousCount: 0,
            unsupportedCount: 0,
            createdAt: new Date(),
            ...data,
          };
          dbJobs[id] = row;
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          Object.assign(dbJobs[where.id], data);
          return dbJobs[where.id];
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const job of Object.values(dbJobs)) {
            if (matchWhere(job, where)) {
              Object.assign(job, data);
              count++;
            }
          }
          return { count };
        },
      },
      application: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          Object.values(dbApps)
            .filter((a) => matchWhere(a, where))
            .sort((a, b) => String(a.name).localeCompare(String(b.name))),
        count: async ({ where }: { where: Record<string, unknown> }) =>
          Object.values(dbApps).filter((a) => matchWhere(a, where)).length,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const id = nextId('app');
          const row = {
            id,
            matchStatus: 'pending',
            matchReason: null,
            matchMethod: 'none',
            matchedPackageId: null,
            matchConfidence: null,
            matchedAt: null,
            candidates: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          dbApps[id] = row;
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          Object.assign(dbApps[where.id], data, { updatedAt: new Date() });
          return dbApps[where.id];
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const a of Object.values(dbApps)) {
            if (matchWhere(a, where)) {
              Object.assign(a, data, { updatedAt: new Date() });
              count++;
            }
          }
          return { count };
        },
      },
      auditEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: nextId('audit'), createdAt: new Date(), ...data };
          dbAudits.push(row);
          return row;
        },
      },
    };
  }

  before(() => {
    const mock = buildMockClient();
    prisma.device.findUnique = mock.device.findUnique as unknown as typeof prisma.device.findUnique;
    prisma.device.findFirst = mock.device.findFirst as unknown as typeof prisma.device.findFirst;
    prisma.device.update = mock.device.update as unknown as typeof prisma.device.update;
    prisma.agentCredential.findUnique = mock.agentCredential.findUnique as unknown as typeof prisma.agentCredential.findUnique;
    prisma.scanJob.findFirst = mock.scanJob.findFirst as unknown as typeof prisma.scanJob.findFirst;
    prisma.scanJob.findMany = mock.scanJob.findMany as unknown as typeof prisma.scanJob.findMany;
    prisma.scanJob.create = mock.scanJob.create as unknown as typeof prisma.scanJob.create;
    prisma.scanJob.update = mock.scanJob.update as unknown as typeof prisma.scanJob.update;
    prisma.scanJob.updateMany = mock.scanJob.updateMany as unknown as typeof prisma.scanJob.updateMany;
    prisma.application.findMany = mock.application.findMany as unknown as typeof prisma.application.findMany;
    prisma.application.count = mock.application.count as unknown as typeof prisma.application.count;
    prisma.application.create = mock.application.create as unknown as typeof prisma.application.create;
    prisma.application.update = mock.application.update as unknown as typeof prisma.application.update;
    prisma.application.updateMany = mock.application.updateMany as unknown as typeof prisma.application.updateMany;
    prisma.auditEvent.create = mock.auditEvent.create as unknown as typeof prisma.auditEvent.create;
    prisma.$transaction = (async (arg: unknown) => {
      if (typeof arg === 'function') {
        return arg(mock);
      }
      return Promise.all(arg as Array<Promise<unknown>>);
    }) as unknown as typeof prisma.$transaction;

    server = app.listen(0);
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    Object.assign(prisma.device, {
      findUnique: orig.deviceFindUnique,
      findFirst: orig.deviceFindFirst,
      update: orig.deviceUpdate,
    });
    prisma.agentCredential.findUnique = orig.credFindUnique;
    Object.assign(prisma.scanJob, {
      findFirst: orig.scanJobFindFirst,
      findMany: orig.scanJobFindMany,
      create: orig.scanJobCreate,
      update: orig.scanJobUpdate,
      updateMany: orig.scanJobUpdateMany,
    });
    Object.assign(prisma.application, {
      findMany: orig.appFindMany,
      count: orig.appCount,
      create: orig.appCreate,
      update: orig.appUpdate,
      updateMany: orig.appUpdateMany,
    });
    prisma.auditEvent.create = orig.auditCreate;
    prisma.$transaction = orig.transaction;
    server.close();
  });

  it('executes full scan workflow with mixed match cases, progress, filters, and counts', async () => {
    resetDb();

    // 1. User requests a scan
    const createRes = await fetch(`${baseUrl}/api/devices/${deviceId}/scans`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    assert.equal(createRes.status, 201);
    const createdBody = (await createRes.json()) as { data: { job: { id: string; status: string } } };
    const jobId = createdBody.data.job.id;
    assert.equal(createdBody.data.job.status, 'queued');

    // 2. Agent polls & claims job
    const pollRes = await fetch(`${baseUrl}/api/agent/jobs`, {
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    const pollBody = (await pollRes.json()) as { data: { jobs: Array<{ id: string }> } };
    assert.equal(pollBody.data.jobs.length, 1);
    assert.equal(pollBody.data.jobs[0].id, jobId);

    const claimRes = await fetch(`${baseUrl}/api/agent/jobs/${jobId}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    assert.equal(claimRes.status, 200);

    // 3. Agent reports detailed progress including skipped enriching_publishers
    const p1 = await fetch(`${baseUrl}/api/agent/jobs/${jobId}/progress`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent: 66, step: 'enriching_publishers', message: 'Skipped (disabled)', skipped: true }),
    });
    assert.equal(p1.status, 200);

    const p2 = await fetch(`${baseUrl}/api/agent/jobs/${jobId}/progress`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent: 78, step: 'normalising_and_merging', message: 'Found 7 apps', skipped: false }),
    });
    assert.equal(p2.status, 200);

    // 4. Agent submits scan results covering all matching scenarios
    const payload = {
      exit_code: 0,
      discovered_packages: [
        // Exact WinGet ID
        {
          name: 'Git',
          package_id: 'Git.Git',
          installed_version: '2.50.0',
          available_version: '2.56.0',
          publisher: 'The Git Development Community',
          source: 'winget',
          is_managed: true,
        },
        // Name-only unique match (no package_id, registry source)
        {
          name: 'Google Chrome (x64)',
          package_id: null,
          installed_version: '156.0.8078.48',
          available_version: null,
          publisher: 'Google LLC',
          source: 'registry',
          is_managed: false,
        },
        // Ambiguous: multiple candidates in catalog (Oracle.JDK.23 & Oracle.JDK.25)
        {
          name: 'Java(TM) SE Development Kit 23.0.2 (64-bit)',
          package_id: null,
          installed_version: '23.0.2',
          available_version: null,
          publisher: 'Oracle Corporation',
          source: 'registry',
          is_managed: false,
        },
        // Same name, different publisher -> PUBLISHER_MISMATCH
        {
          name: 'Zoom',
          package_id: null,
          installed_version: '5.0.0',
          available_version: null,
          publisher: 'Suspicious Third Party LLC',
          source: 'registry',
          is_managed: false,
        },
        // Registry-only app -> REGISTRY_ONLY
        {
          name: 'Internal Accounting Suite',
          package_id: null,
          installed_version: '1.0.0',
          available_version: null,
          publisher: 'Acme Finance',
          source: 'registry',
          is_managed: false,
        },
        // Microsoft Store / MSIX app -> MSSTORE_OR_SYSTEM_APP
        {
          name: 'Feedback Hub',
          package_id: 'MSIX\\Microsoft.WindowsFeedbackHub_2.2608.303.0_x64__8wekyb3d8bbwe',
          installed_version: '2.2608.303.0',
          available_version: null,
          publisher: 'Microsoft Corporation',
          source: 'msstore',
          is_managed: false,
        },
        // Malformed / injection-style ID -> INSUFFICIENT_DATA (or NOT_IN_WINGET fallback)
        {
          name: 'Malicious Entry',
          package_id: 'Vendor.App; calc.exe',
          installed_version: '1.0.0',
          available_version: null,
          publisher: 'Unknown',
          source: 'winget',
          is_managed: false,
        },
      ],
    };

    const resPost = await fetch(`${baseUrl}/api/agent/scans/${jobId}/results`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(resPost.status, 200);

    // 5. Verify ScanJob counts & progress
    const jobRes = await fetch(`${baseUrl}/api/devices/${deviceId}/scans/${jobId}`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const jobData = (await jobRes.json()) as { data: { job: Record<string, unknown> } };
    assert.equal(jobData.data.job.status, 'succeeded');
    assert.equal(jobData.data.job.progressPercent, 100);
    assert.equal(jobData.data.job.progressStep, 'matching_packages');
    assert.equal(jobData.data.job.matchedCount, 2); // Git + Chrome
    assert.equal(jobData.data.job.ambiguousCount, 1); // Java SE Development Kit
    assert.equal(jobData.data.job.unsupportedCount, 4); // Zoom mismatch + Internal + Feedback Hub + Malicious

    // 6. Verify Applications API & matchStatus filter
    const allAppsRes = await fetch(`${baseUrl}/api/devices/${deviceId}/applications`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const allAppsBody = (await allAppsRes.json()) as { data: { total: number; applications: Array<Record<string, unknown>> } };
    assert.equal(allAppsBody.data.total, 7);

    const byName = new Map(allAppsBody.data.applications.map((a) => [a.name as string, a]));
    assert.equal(byName.get('Git')?.matchStatus, 'matched');
    assert.equal(byName.get('Git')?.matchReason, 'WINGET_ID_PRESENT');
    assert.equal(byName.get('Google Chrome (x64)')?.matchStatus, 'matched');
    assert.equal(byName.get('Google Chrome (x64)')?.matchReason, 'NAME_PUBLISHER_UNIQUE');
    assert.equal(byName.get('Java(TM) SE Development Kit 23.0.2 (64-bit)')?.matchStatus, 'ambiguous');
    assert.equal(byName.get('Java(TM) SE Development Kit 23.0.2 (64-bit)')?.matchReason, 'MULTIPLE_CANDIDATES');
    assert.equal(byName.get('Zoom')?.matchStatus, 'unsupported');
    assert.equal(byName.get('Zoom')?.matchReason, 'PUBLISHER_MISMATCH');
    assert.equal(byName.get('Internal Accounting Suite')?.matchStatus, 'unsupported');
    assert.equal(byName.get('Internal Accounting Suite')?.matchReason, 'REGISTRY_ONLY');
    assert.equal(byName.get('Feedback Hub')?.matchStatus, 'unsupported');
    assert.equal(byName.get('Feedback Hub')?.matchReason, 'MSSTORE_OR_SYSTEM_APP');
    assert.equal(byName.get('Malicious Entry')?.matchStatus, 'unsupported');

    // Filtered Applications API
    const matchedOnlyRes = await fetch(`${baseUrl}/api/devices/${deviceId}/applications?matchStatus=matched`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const matchedOnly = (await matchedOnlyRes.json()) as { data: { total: number } };
    assert.equal(matchedOnly.data.total, 2);

    const unsupportedOnlyRes = await fetch(`${baseUrl}/api/devices/${deviceId}/applications?matchStatus=unsupported`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const unsupportedOnly = (await unsupportedOnlyRes.json()) as { data: { total: number } };
    assert.equal(unsupportedOnly.data.total, 4);

    // 7. Verify Dashboard Overview counts & History
    const overviewRes = await fetch(`${baseUrl}/api/devices/${deviceId}/overview`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const overview = (await overviewRes.json()) as { data: Record<string, unknown> };
    assert.equal(overview.data.totalApps, 7);
    assert.equal(overview.data.matchedCount, 2);
    assert.equal(overview.data.ambiguousCount, 1);
    assert.equal(overview.data.unsupportedCount, 4);

    const histRes = await fetch(`${baseUrl}/api/devices/${deviceId}/history`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const histBody = (await histRes.json()) as { data: Array<Record<string, unknown>> };
    assert.equal(histBody.data.length, 1);
    assert.equal(histBody.data[0].status, 'succeeded');
    assert.equal(histBody.data[0].appCount, 7);
  });

  it('handles WinGet-missing registry-only scan, version change + removal on second scan, failed scan, and rematch after catalog update', async () => {
    resetDb();

    // Scan 1: Registry-only scan (WinGet missing)
    const s1 = await fetch(`${baseUrl}/api/devices/${deviceId}/scans`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const j1 = ((await s1.json()) as { data: { job: { id: string } } }).data.job.id;
    await fetch(`${baseUrl}/api/agent/jobs/${j1}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
    });

    await fetch(`${baseUrl}/api/agent/scans/${j1}/results`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exit_code: 0,
        discovered_packages: [
          {
            name: '7-Zip 24.09 (x64)',
            package_id: null,
            installed_version: '24.09',
            publisher: 'Igor Pavlov',
            source: 'registry',
            is_managed: false,
          },
          {
            name: 'BrandNewTool',
            package_id: null,
            installed_version: '1.0.0',
            publisher: 'NewVendor Inc',
            source: 'registry',
            is_managed: false,
          },
        ],
      }),
    });

    // Verify BrandNewTool is initially unsupported (REGISTRY_ONLY)
    const appsAfterS1 = await fetch(`${baseUrl}/api/devices/${deviceId}/applications`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const list1 = ((await appsAfterS1.json()) as { data: { applications: Array<Record<string, unknown>> } }).data.applications;
    assert.equal(list1.find((a) => a.name === 'BrandNewTool')?.matchReason, 'REGISTRY_ONLY');

    // Rematch after known packages table changes
    DEFAULT_KNOWN_PACKAGES.push({
      packageId: 'NewVendor.BrandNewTool',
      name: 'BrandNewTool',
      publisher: 'NewVendor Inc',
    });

    try {
      const rematchRes = await fetch(`${baseUrl}/api/devices/${deviceId}/rematch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userJwt}` },
      });
      assert.equal(rematchRes.status, 200);
      const rematchBody = (await rematchRes.json()) as { data: { updatedRowsCount: number; matchedCount: number } };
      assert.equal(rematchBody.data.updatedRowsCount, 1);
      assert.equal(rematchBody.data.matchedCount, 2); // 7-Zip + BrandNewTool
    } finally {
      DEFAULT_KNOWN_PACKAGES.pop();
    }

    // Scan 2: removes BrandNewTool and updates 7-Zip version
    const s2 = await fetch(`${baseUrl}/api/devices/${deviceId}/scans`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const j2 = ((await s2.json()) as { data: { job: { id: string } } }).data.job.id;
    await fetch(`${baseUrl}/api/agent/jobs/${j2}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    await fetch(`${baseUrl}/api/agent/scans/${j2}/results`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exit_code: 0,
        discovered_packages: [
          {
            name: '7-Zip 24.09 (x64)',
            package_id: null,
            installed_version: '26.05',
            publisher: 'Igor Pavlov',
            source: 'registry',
            is_managed: false,
          },
        ],
      }),
    });

    const installedOnly = await fetch(`${baseUrl}/api/devices/${deviceId}/applications`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const installedList = ((await installedOnly.json()) as { data: { applications: Array<Record<string, unknown>> } }).data.applications;
    assert.equal(installedList.length, 1);
    assert.equal(installedList[0].installedVersion, '26.05');

    const withRemoved = await fetch(`${baseUrl}/api/devices/${deviceId}/applications?includeRemoved=true`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const allList = ((await withRemoved.json()) as { data: { applications: Array<Record<string, unknown>> } }).data.applications;
    assert.equal(allList.length, 2);

    // Scan 3: Failed scan
    const s3 = await fetch(`${baseUrl}/api/devices/${deviceId}/scans`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const j3 = ((await s3.json()) as { data: { job: { id: string } } }).data.job.id;
    await fetch(`${baseUrl}/api/agent/jobs/${j3}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    const failRes = await fetch(`${baseUrl}/api/agent/scans/${j3}/failure`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error_code: 1, error_message: 'Both WinGet and Registry scans failed.' }),
    });
    assert.equal(failRes.status, 200);

    const histRes = await fetch(`${baseUrl}/api/devices/${deviceId}/history`, {
      headers: { Authorization: `Bearer ${userJwt}` },
    });
    const hist = ((await histRes.json()) as { data: Array<Record<string, unknown>> }).data;
    assert.equal(hist[0].status, 'failed');
    assert.equal(hist[0].errorMessage, 'Both WinGet and Registry scans failed.');
  });
});
