import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';
import { resetMetadataRefreshRateLimits } from './scans.js';

describe('E2E Integration: Complete Package Release Metadata & Refresh Lifecycle', () => {
  let server: Server;
  let baseUrl: string;

  const testUser = { id: 'usr-e2e-meta', email: 'meta-user@updatepilot.test' };
  const userToken = signToken({ sub: testUser.id, email: testUser.email });

  const testDevice = {
    id: 'dev-e2e-meta',
    userId: testUser.id,
    name: 'Workstation-E2E',
    hostname: 'DESKTOP-META',
    status: 'ONLINE',
  };

  const agentRawToken = 'agent-token-secret-e2e-999';
  const agentTokenHash = crypto.createHash('sha256').update(agentRawToken).digest('hex');

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('runs complete lifecycle: update detected -> metadata fetched -> cached -> served -> stale refresh', async () => {
    resetMetadataRefreshRateLimits();

    // 1. In-memory database simulation
    const db = {
      devices: [testDevice],
      credentials: [
        {
          id: 'cred-1',
          tokenHash: agentTokenHash,
          deviceId: testDevice.id,
          device: testDevice,
          revokedAt: null,
        },
      ],
      applications: [
        {
          id: 'app-git-e2e',
          deviceId: testDevice.id,
          name: 'Git for Windows',
          packageId: 'Git.Git',
          matchedPackageId: 'Git.Git',
          installedVersion: '2.44.0',
          availableVersion: '2.56.0',
          updateStatus: 'update_available',
          updateCheckedAt: new Date(),
          publisher: 'Git Community',
          source: 'winget',
          isInstalled: true,
          isManaged: true,
          matchStatus: 'matched',
          matchReason: 'WINGET_ID_PRESENT',
          matchConfidence: 1.0,
          matchMethod: 'winget_id',
          candidates: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      scanJobs: [] as Array<Record<string, unknown>>,
      packageMetadata: [] as Array<Record<string, unknown>>,
      auditEvents: [] as Array<Record<string, unknown>>,
    };

    // Save originals
    const origDeviceFindUnique = prisma.device.findUnique;
    const origDeviceUpdate = prisma.device.update;
    const origAgentCredFindUnique = prisma.agentCredential.findUnique;
    const origAppFindMany = prisma.application.findMany;
    const origAppFindFirst = prisma.application.findFirst;
    const origScanJobFindMany = prisma.scanJob.findMany;
    const origScanJobFindFirst = prisma.scanJob.findFirst;
    const origScanJobCreate = prisma.scanJob.create;
    const origScanJobUpdate = prisma.scanJob.update;
    const origScanJobUpdateMany = prisma.scanJob.updateMany;
    const origMetaFindMany = prisma.packageMetadata.findMany;
    const origMetaFindUnique = prisma.packageMetadata.findUnique;
    const origMetaFindFirst = prisma.packageMetadata.findFirst;
    const origMetaUpsert = prisma.packageMetadata.upsert;
    const origAuditCreate = prisma.auditEvent.create;
    const origTransaction = prisma.$transaction;

    try {
      (prisma.device.findUnique as unknown) = async (args: { where: { id: string } }) => {
        return db.devices.find((d) => d.id === args.where.id) || null;
      };

      (prisma.device.update as unknown) = async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const d = db.devices.find((dev) => dev.id === args.where.id);
        if (d) Object.assign(d, args.data);
        return d;
      };

      (prisma.agentCredential.findUnique as unknown) = async (args: { where: { tokenHash: string } }) => {
        return db.credentials.find((c) => c.tokenHash === args.where.tokenHash) || null;
      };

      (prisma.application.findMany as unknown) = async (args?: { where?: Record<string, unknown> }) => {
        if (!args?.where) return db.applications;
        return db.applications.filter((a) => {
          if (args.where?.deviceId && a.deviceId !== args.where.deviceId) return false;
          if (args.where?.updateStatus && a.updateStatus !== args.where.updateStatus) return false;
          if (args.where?.isInstalled !== undefined && a.isInstalled !== args.where.isInstalled) return false;
          return true;
        });
      };

      (prisma.application.findFirst as unknown) = async (args: { where: { deviceId: string; OR?: Array<{ id?: string; packageId?: string; matchedPackageId?: string }> } }) => {
        const idMatches = args.where.OR?.map((o) => o.id || o.packageId || o.matchedPackageId);
        return db.applications.find((a) => a.deviceId === args.where.deviceId && (!idMatches || idMatches.includes(a.id) || idMatches.includes(a.packageId))) || null;
      };

      (prisma.scanJob.findFirst as unknown) = async (args: { where: Record<string, unknown> }) => {
        return (
          db.scanJobs.find((j) => {
            if (args.where.id && j.id !== args.where.id) return false;
            if (args.where.deviceId && j.deviceId !== args.where.deviceId) return false;
            if (args.where.type && j.type !== args.where.type) return false;
            if (args.where.status) {
              const statusArg = args.where.status as { in?: string[] } | string;
              if (typeof statusArg === 'object' && statusArg.in && !statusArg.in.includes(j.status as string)) return false;
              if (typeof statusArg === 'string' && j.status !== statusArg) return false;
            }
            return true;
          }) || null
        );
      };

      (prisma.scanJob.create as unknown) = async (args: { data: Record<string, unknown> }) => {
        const job = { id: `job-${Date.now()}`, ...args.data, createdAt: new Date() };
        db.scanJobs.push(job);
        return job;
      };

      (prisma.scanJob.update as unknown) = async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const job = db.scanJobs.find((j) => j.id === args.where.id);
        if (job) Object.assign(job, args.data);
        return job;
      };

      (prisma.scanJob.updateMany as unknown) = async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const job = db.scanJobs.find((j) => j.id === args.where.id);
        if (job) {
          Object.assign(job, args.data);
          return { count: 1 };
        }
        return { count: 0 };
      };

      (prisma.packageMetadata.findMany as unknown) = async (args?: { where?: { packageId?: { in?: string[] } } }) => {
        if (!args?.where?.packageId?.in) return db.packageMetadata;
        return db.packageMetadata.filter((m) => args.where!.packageId!.in!.includes(m.packageId as string));
      };

      (prisma.packageMetadata.findUnique as unknown) = async (args: { where: { packageId_version: { packageId: string; version: string } } }) => {
        return (
          db.packageMetadata.find(
            (m) =>
              (m.packageId as string).toLowerCase() === args.where.packageId_version.packageId.toLowerCase() &&
              (m.version as string).toLowerCase() === args.where.packageId_version.version.toLowerCase()
          ) || null
        );
      };

      (prisma.packageMetadata.findFirst as unknown) = async (args: { where: { packageId: string } }) => {
        return db.packageMetadata.find((m) => (m.packageId as string).toLowerCase() === args.where.packageId.toLowerCase()) || null;
      };

      (prisma.packageMetadata.upsert as unknown) = async (args: {
        where: { packageId_version: { packageId: string; version: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = db.packageMetadata.find(
          (m) =>
            (m.packageId as string).toLowerCase() === args.where.packageId_version.packageId.toLowerCase() &&
            (m.version as string).toLowerCase() === args.where.packageId_version.version.toLowerCase()
        );
        if (existing) {
          Object.assign(existing, args.update, { updatedAt: new Date() });
          return existing;
        }
        const created = { id: `meta-${Date.now()}`, ...args.create, createdAt: new Date(), updatedAt: new Date() };
        db.packageMetadata.push(created);
        return created;
      };

      (prisma.auditEvent.create as unknown) = async (args: { data: Record<string, unknown> }) => {
        db.auditEvents.push(args.data);
        return args.data;
      };

      (prisma.$transaction as unknown) = async (operations: unknown) => {
        if (typeof operations === 'function') {
          return await operations(prisma);
        }
        if (Array.isArray(operations)) {
          const results = [];
          for (const op of operations) {
            if (typeof op === 'function') results.push(await op(prisma));
            else results.push(await op);
          }
          return results;
        }
        return [];
      };

      // STEP 1: Check initial update details before metadata fetch -> Status: "missing"
      const initialRes = await fetch(`${baseUrl}/api/devices/${testDevice.id}/updates/app-git-e2e`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(initialRes.status, 200);
      const initialJson = (await initialRes.json()) as { success: boolean; data: { metadataStatus: string; missingMessages: Record<string, string> } };
      assert.strictEqual(initialJson.data.metadataStatus, 'missing');
      assert.strictEqual(initialJson.data.missingMessages.officialSourceLink, 'Official source link not provided by the publisher');
      assert.strictEqual(initialJson.data.missingMessages.releaseNotes, 'Release notes not provided by the publisher');

      // STEP 2: Trigger metadata job creation from server for missing metadata
      const queueJobRes = await fetch(`${baseUrl}/api/devices/${testDevice.id}/metadata-jobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(queueJobRes.status, 201);
      const queueJobJson = (await queueJobRes.json()) as { success: boolean; data: { queued: boolean; job: { id: string; type: string } } };
      assert.strictEqual(queueJobJson.data.queued, true);
      assert.strictEqual(queueJobJson.data.job.type, 'get_package_metadata');
      const jobId = queueJobJson.data.job.id;

      // STEP 3: Agent claims the get_package_metadata job
      const claimRes = await fetch(`${baseUrl}/api/agent/jobs/${jobId}/claim`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agentRawToken}` },
      });
      assert.strictEqual(claimRes.status, 200);

      // STEP 4: Agent executes `winget show` and submits valid metadata results
      const submitRes = await fetch(`${baseUrl}/api/agent/metadata/${jobId}/results`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${agentRawToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          packages: [
            {
              package_id: 'Git.Git',
              version: '2.56.0',
              publisher: 'The Git Community',
              homepage_url: 'https://git-scm.com/',
              release_notes_url: 'https://github.com/git-for-windows/git/releases/tag/v2.56.0',
              release_notes_text: '* Fixed CVE-2026-0001\n* Performance improvements',
              fetch_status: 'success',
            },
          ],
        }),
      });
      assert.strictEqual(submitRes.status, 200);
      const submitJson = (await submitRes.json()) as { success: boolean; data: { status: string; packageCount: number } };
      assert.strictEqual(submitJson.data.packageCount, 1);
      assert.strictEqual(submitJson.data.status, 'succeeded');

      // STEP 5: Verify metadata is now cached and served via Update Details API -> Status: "available"
      const servedRes = await fetch(`${baseUrl}/api/devices/${testDevice.id}/updates/app-git-e2e`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(servedRes.status, 200);
      const servedJson = (await servedRes.json()) as {
        success: boolean;
        data: {
          targetVersion: string;
          officialSourceLink: string;
          releaseNotesLink: string;
          releaseNotesSummary: string;
          metadataStatus: string;
          publisher: string;
        };
      };
      assert.strictEqual(servedJson.data.metadataStatus, 'available');
      assert.strictEqual(servedJson.data.targetVersion, '2.56.0');
      assert.strictEqual(servedJson.data.publisher, 'The Git Community');
      assert.strictEqual(servedJson.data.officialSourceLink, 'https://git-scm.com/');
      assert.strictEqual(servedJson.data.releaseNotesLink, 'https://github.com/git-for-windows/git/releases/tag/v2.56.0');
      assert.ok(servedJson.data.releaseNotesSummary.includes('CVE-2026-0001'));

      // STEP 6: Simulate time passing past 24-hour cache TTL -> Status: "stale"
      const cachedRecord = db.packageMetadata[0];
      assert.ok(cachedRecord);
      cachedRecord.expiresAt = new Date(Date.now() - 60000); // 1 minute in the past

      const staleRes = await fetch(`${baseUrl}/api/devices/${testDevice.id}/updates/app-git-e2e`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(staleRes.status, 200);
      const staleJson = (await staleRes.json()) as { success: boolean; data: { metadataStatus: string; missingMessages: Record<string, string> } };
      assert.strictEqual(staleJson.data.metadataStatus, 'stale');
      assert.ok(staleJson.data.missingMessages.general?.includes('stale'));

      // STEP 7: User clicks "Refresh" -> POST /api/devices/:id/metadata-refresh
      const refreshRes = await fetch(`${baseUrl}/api/devices/${testDevice.id}/metadata-refresh`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ packageId: 'Git.Git' }),
      });
      assert.strictEqual(refreshRes.status, 201);
      const refreshJson = (await refreshRes.json()) as { success: boolean; data: { queued: boolean; packageIds: string[] } };
      assert.strictEqual(refreshJson.data.queued, true);
      assert.deepStrictEqual(refreshJson.data.packageIds, ['Git.Git']);

      // Verify METADATA_REFRESH_REQUESTED audit event was logged
      const refreshAuditEvent = db.auditEvents.find((evt) => evt.eventType === 'METADATA_REFRESH_REQUESTED');
      assert.ok(refreshAuditEvent, 'METADATA_REFRESH_REQUESTED audit event must be recorded');
    } finally {
      prisma.device.findUnique = origDeviceFindUnique;
      prisma.device.update = origDeviceUpdate;
      prisma.agentCredential.findUnique = origAgentCredFindUnique;
      prisma.application.findMany = origAppFindMany;
      prisma.application.findFirst = origAppFindFirst;
      prisma.scanJob.findMany = origScanJobFindMany;
      prisma.scanJob.findFirst = origScanJobFindFirst;
      prisma.scanJob.create = origScanJobCreate;
      prisma.scanJob.update = origScanJobUpdate;
      prisma.scanJob.updateMany = origScanJobUpdateMany;
      prisma.packageMetadata.findMany = origMetaFindMany;
      prisma.packageMetadata.findUnique = origMetaFindUnique;
      prisma.packageMetadata.findFirst = origMetaFindFirst;
      prisma.packageMetadata.upsert = origMetaUpsert;
      prisma.auditEvent.create = origAuditCreate;
      prisma.$transaction = origTransaction;
    }
  });
});
