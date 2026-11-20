import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchApplication, matchDeviceApplications } from './service.js';
import { prisma } from '../lib/prisma.js';
import { app } from '../app.js';
import { signToken } from '../middleware/auth.js';

describe('Matching Service & Workflow (backend/src/matching/service.ts)', () => {
  describe('matchApplication Cascading Pipeline', () => {
    it('prioritizes exact WinGet ID match when present and valid', () => {
      const res = matchApplication({
        name: 'Git for Windows',
        packageId: 'Git.Git',
        source: 'winget',
        publisher: 'Git',
      });

      assert.equal(res.matchStatus, 'matched');
      assert.equal(res.matchMethod, 'winget_id');
      assert.equal(res.matchReason, 'WINGET_ID_PRESENT');
      assert.equal(res.matchedPackageId, 'Git.Git');
      assert.equal(res.matchConfidence, 1.0);
    });

    it('identifies Microsoft Store or MSIX package as unsupported MSSTORE_OR_SYSTEM_APP', () => {
      const res = matchApplication({
        name: 'AV1 Video Extension',
        packageId: 'MSIX\\Microsoft.AV1VideoExtension_2.0.35.0_x64__8wekyb3d8bbwe',
        source: null,
      });

      assert.equal(res.matchStatus, 'unsupported');
      assert.equal(res.matchReason, 'MSSTORE_OR_SYSTEM_APP');
      assert.equal(res.matchMethod, 'none');
      assert.equal(res.matchedPackageId, null);
    });

    it('falls back to name and publisher matching when package ID is absent', () => {
      const res = matchApplication({
        name: 'Google Chrome (x64)',
        packageId: null,
        publisher: 'Google LLC',
        source: 'registry',
      });

      assert.equal(res.matchStatus, 'matched');
      assert.equal(res.matchMethod, 'name_publisher');
      assert.equal(res.matchReason, 'NAME_PUBLISHER_UNIQUE');
      assert.equal(res.matchedPackageId, 'Google.Chrome');
      assert.equal(res.matchConfidence, 0.75);
    });
  });

  describe('matchDeviceApplications - Only Changed Rows Updated', () => {
    it('only updates database rows whose matching results changed', async () => {
      const deviceId = 'dev-test-changed-rows';
      let updateCallCount = 0;

      // Mock database apps
      const apps = [
        {
          id: 'app-1',
          deviceId,
          name: 'Git',
          packageId: 'Git.Git',
          publisher: 'Git',
          source: 'winget',
          isInstalled: true,
          matchStatus: 'pending',
          matchReason: null,
          matchMethod: 'none',
          matchedPackageId: null,
          matchConfidence: null,
          candidates: [],
        },
        {
          id: 'app-2',
          deviceId,
          name: 'Unknown Custom Internal Tool',
          packageId: null,
          publisher: 'Local Corp',
          source: 'registry',
          isInstalled: true,
          matchStatus: 'pending',
          matchReason: null,
          matchMethod: 'none',
          matchedPackageId: null,
          matchConfidence: null,
          candidates: [],
        },
      ];

      const mockDb = {
        application: {
          findMany: async () => apps,
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            updateCallCount++;
            const target = apps.find((a) => a.id === where.id);
            if (target) {
              Object.assign(target, data);
            }
            return target;
          },
        },
      };

      // 1. First run: both rows are pending, so both must be updated
      const firstRun = await matchDeviceApplications(deviceId, mockDb as unknown as typeof prisma);
      assert.equal(firstRun.totalProcessed, 2);
      assert.equal(firstRun.updatedRowsCount, 2);
      assert.equal(firstRun.matchedCount, 1);
      assert.equal(firstRun.unsupportedCount, 1);
      assert.equal(updateCallCount, 2);

      // 2. Second run: identical inputs, no results changed -> 0 rows updated
      const secondRun = await matchDeviceApplications(deviceId, mockDb as unknown as typeof prisma);
      assert.equal(secondRun.totalProcessed, 2);
      assert.equal(secondRun.updatedRowsCount, 0, 'Second run must not rewrite unchanged rows');
      assert.equal(updateCallCount, 2); // Still 2, no new update calls

      // 3. Mutate one app's packageId -> exactly 1 row should be updated
      apps[1].name = 'Google Chrome';
      apps[1].publisher = 'Google LLC';

      const thirdRun = await matchDeviceApplications(deviceId, mockDb as unknown as typeof prisma);
      assert.equal(thirdRun.updatedRowsCount, 1, 'Only the modified app row should be updated');
      assert.equal(thirdRun.matchedCount, 2);
      assert.equal(updateCallCount, 3);
    });
  });

  describe('Rematch Endpoint & API Filters (/api/devices/:id)', () => {
    const ownerId = '11111111-1111-1111-1111-111111111111';
    const strangerId = '22222222-2222-2222-2222-222222222222';
    const ownerToken = signToken({ sub: ownerId, email: 'owner@example.com' });
    const strangerToken = signToken({ sub: strangerId, email: 'stranger@example.com' });

    const testDevice = {
      id: 'dev-rematch-test',
      userId: ownerId,
      name: 'Owner PC',
      hostname: 'OWNER-PC',
      status: 'ONLINE',
      createdAt: new Date(),
    };

    let server: import('node:http').Server;
    let baseUrl: string;

    it('setup HTTP server for matching tests', async () => {
      server = app.listen(0);
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    it('POST /api/devices/:id/rematch enforces authentication and device ownership', async () => {
      const origFindUnique = prisma.device.findUnique;
      prisma.device.findUnique = (async ({ where }: { where: { id: string } }) => {
        if (where.id === testDevice.id) return testDevice;
        return null;
      }) as unknown as typeof prisma.device.findUnique;

      try {
        // 1. Unauthenticated request -> 401
        const resUnauth = await fetch(`${baseUrl}/api/devices/${testDevice.id}/rematch`, {
          method: 'POST',
        });
        assert.equal(resUnauth.status, 401);

        // 2. Stranger request -> 404
        const resStranger = await fetch(`${baseUrl}/api/devices/${testDevice.id}/rematch`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${strangerToken}` },
        });
        assert.equal(resStranger.status, 404);
      } finally {
        prisma.device.findUnique = origFindUnique;
      }
    });

    it('POST /api/devices/:id/rematch succeeds for owner, rematches apps, and records audit event', async () => {
      const origDeviceFindUnique = prisma.device.findUnique;
      const origAppFindMany = prisma.application.findMany;
      const origAppUpdate = prisma.application.update;
      const origAuditEventCreate = prisma.auditEvent.create;

      prisma.device.findUnique = (async () => testDevice) as unknown as typeof prisma.device.findUnique;

      const deviceApps = [
        {
          id: 'app-git',
          deviceId: testDevice.id,
          name: 'Git',
          packageId: 'Git.Git',
          publisher: 'Git',
          source: 'winget',
          isInstalled: true,
          matchStatus: 'pending',
          candidates: [],
        },
      ];

      prisma.application.findMany = (async () => deviceApps) as unknown as typeof prisma.application.findMany;
      prisma.application.update = (async ({ data }: { data: Record<string, unknown> }) => {
        return { id: 'app-git', ...data };
      }) as unknown as typeof prisma.application.update;

      let auditCreated: Record<string, unknown> | null = null;
      prisma.auditEvent.create = (async ({ data }: { data: Record<string, unknown> }) => {
        auditCreated = data;
        return { id: 'audit-1', ...data };
      }) as unknown as typeof prisma.auditEvent.create;

      try {
        const res = await fetch(`${baseUrl}/api/devices/${testDevice.id}/rematch`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ownerToken}` },
        });

        assert.equal(res.status, 200);
        const body = (await res.json()) as { success: boolean; data: { matchedCount: number; updatedRowsCount: number } };
        assert.equal(body.success, true);
        assert.equal(body.data.matchedCount, 1);
        assert.equal(body.data.updatedRowsCount, 1);

        assert.ok(auditCreated !== null);
        const record = auditCreated as Record<string, unknown>;
        assert.equal(record.eventType, 'APPLICATIONS_REMATCHED');
        assert.equal(record.deviceId, testDevice.id);
      } finally {
        prisma.device.findUnique = origDeviceFindUnique;
        prisma.application.findMany = origAppFindMany;
        prisma.application.update = origAppUpdate;
        prisma.auditEvent.create = origAuditEventCreate;
      }
    });

    it('GET /api/devices/:id/applications filters by matchStatus and exposes reason message and metadata', async () => {
      const origDeviceFindUnique = prisma.device.findUnique;
      const origAppFindMany = prisma.application.findMany;

      prisma.device.findUnique = (async () => testDevice) as unknown as typeof prisma.device.findUnique;

      const storedApps = [
        {
          id: 'app-matched',
          deviceId: testDevice.id,
          name: 'Git for Windows',
          packageId: 'Git.Git',
          installedVersion: '2.50.0',
          availableVersion: null,
          publisher: 'Git',
          source: 'winget',
          isManaged: true,
          isInstalled: true,
          matchStatus: 'matched',
          matchReason: 'WINGET_ID_PRESENT',
          matchMethod: 'winget_id',
          matchedPackageId: 'Git.Git',
          matchConfidence: 1.0,
          candidates: [],
          lastScannedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'app-ambiguous',
          deviceId: testDevice.id,
          name: 'Ambiguous App',
          packageId: null,
          installedVersion: '1.0.0',
          availableVersion: null,
          publisher: 'Acme',
          source: 'registry',
          isManaged: false,
          isInstalled: true,
          matchStatus: 'ambiguous',
          matchReason: 'MULTIPLE_CANDIDATES',
          matchMethod: 'none',
          matchedPackageId: null,
          matchConfidence: null,
          candidates: [
            { packageId: 'Vendor.App.Community', name: 'Ambiguous App', publisher: 'Acme' },
            { packageId: 'Vendor.App.Pro', name: 'Ambiguous App', publisher: 'Acme' },
          ],
          lastScannedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      prisma.application.findMany = (async (args: { where: { matchStatus?: string } }) => {
        if (args.where.matchStatus) {
          return storedApps.filter((a) => a.matchStatus === args.where.matchStatus);
        }
        return storedApps;
      }) as unknown as typeof prisma.application.findMany;

      try {
        // Query only matched apps
        const resMatched = await fetch(`${baseUrl}/api/devices/${testDevice.id}/applications?matchStatus=matched`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });

        assert.equal(resMatched.status, 200);
        const dataMatched = (await resMatched.json()) as { success: boolean; data: { total: number; applications: Array<Record<string, unknown>> } };
        assert.equal(dataMatched.data.total, 1);
        const app0 = dataMatched.data.applications[0];
        assert.equal(app0.matchStatus, 'matched');
        assert.equal(app0.matchReason, 'WINGET_ID_PRESENT');
        assert.ok(typeof app0.matchMessage === 'string' && (app0.matchMessage as string).length > 10);
        assert.ok(typeof app0.matchNextStep === 'string' && (app0.matchNextStep as string).length > 10);
        assert.equal(app0.matchedPackageId, 'Git.Git');

        // Query ambiguous apps to check candidate list exposure
        const resAmbiguous = await fetch(`${baseUrl}/api/devices/${testDevice.id}/applications?matchStatus=ambiguous`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });

        assert.equal(resAmbiguous.status, 200);
        const dataAmbiguous = (await resAmbiguous.json()) as { success: boolean; data: { total: number; applications: Array<Record<string, unknown>> } };
        assert.equal(dataAmbiguous.data.total, 1);
        const appAmb = dataAmbiguous.data.applications[0];
        assert.equal(appAmb.matchStatus, 'ambiguous');
        assert.equal(appAmb.matchReason, 'MULTIPLE_CANDIDATES');
        assert.equal((appAmb.candidates as unknown[]).length, 2);
      } finally {
        prisma.device.findUnique = origDeviceFindUnique;
        prisma.application.findMany = origAppFindMany;
      }
    });

    it('GET /api/devices/:id/overview exposes match status breakdown counts', async () => {
      const origDeviceFindUnique = prisma.device.findUnique;
      const origAppCount = prisma.application.count;
      const origScanFindFirst = prisma.scanJob.findFirst;

      prisma.device.findUnique = (async () => testDevice) as unknown as typeof prisma.device.findUnique;

      prisma.application.count = (async (args: { where: { matchStatus?: string; isManaged?: boolean } }) => {
        if (args.where.matchStatus === 'matched') return 7;
        if (args.where.matchStatus === 'ambiguous') return 2;
        if (args.where.matchStatus === 'unsupported') return 1;
        if (args.where.isManaged === true) return 7;
        return 8; // Total 8 -> unsupportedApps = 8 - 7 = 1
      }) as unknown as typeof prisma.application.count;

      prisma.scanJob.findFirst = (async () => ({
        id: 'job-latest',
        deviceId: testDevice.id,
        status: 'succeeded',
        finishedAt: new Date(),
        appCount: 10,
      })) as unknown as typeof prisma.scanJob.findFirst;

      try {
        const res = await fetch(`${baseUrl}/api/devices/${testDevice.id}/overview`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });

        assert.equal(res.status, 200);
        const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
        assert.equal(body.data.matchedApps, 7);
        assert.equal(body.data.ambiguousApps, 2);
        assert.equal(body.data.unsupportedApps, 1);
        assert.equal(body.data.matchedCount, 7);
        assert.equal(body.data.ambiguousCount, 2);
        assert.equal(body.data.unsupportedCount, 1);
      } finally {
        prisma.device.findUnique = origDeviceFindUnique;
        prisma.application.count = origAppCount;
        prisma.scanJob.findFirst = origScanFindFirst;
      }
    });

    it('teardown server', () => {
      server.close();
    });
  });
});
