import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';
import { resetMetadataRefreshRateLimits } from './scans.js';

describe('Update Details & Metadata Refresh API', () => {
  let server: Server;
  let baseUrl: string;

  const userA = { id: 'user-a-1111', email: 'usera@example.com' };
  const userB = { id: 'user-b-2222', email: 'userb@example.com' };

  const tokenA = signToken({ sub: userA.id, email: userA.email });
  const tokenB = signToken({ sub: userB.id, email: userB.email });

  const deviceA = {
    id: 'device-a-1111',
    userId: userA.id,
    name: 'Workstation-A',
    hostname: 'DESKTOP-A',
    status: 'ONLINE',
  };

  const deviceB = {
    id: 'device-b-2222',
    userId: userB.id,
    name: 'Workstation-B',
    hostname: 'DESKTOP-B',
    status: 'ONLINE',
  };

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

  beforeEach(() => {
    resetMetadataRefreshRateLimits();
  });

  it('GET /api/devices/:id/updates/:updateId returns status "available" with release info when metadata is fresh and complete', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;
    const originalAppFindFirst = prisma.application.findFirst;
    const originalMetaFindUnique = prisma.packageMetadata.findUnique;
    const originalMetaFindFirst = prisma.packageMetadata.findFirst;

    try {
      (prisma.device.findUnique as unknown) = async (args: { where: { id: string } }) => {
        if (args.where.id === deviceA.id) return deviceA;
        return null;
      };

      (prisma.application.findFirst as unknown) = async (args: { where: { deviceId: string } }) => {
        if (args.where.deviceId === deviceA.id) {
          return {
            id: 'app-git-1',
            deviceId: deviceA.id,
            name: 'Git for Windows',
            packageId: 'Git.Git',
            matchedPackageId: 'Git.Git',
            installedVersion: '2.44.0',
            availableVersion: '2.56.0',
            updateStatus: 'update_available',
            updateCheckedAt: new Date('2026-11-17T10:00:00Z'),
            publisher: 'Git Community',
            source: 'winget',
            isInstalled: true,
            isManaged: true,
            matchStatus: 'matched',
            matchReason: 'WINGET_ID_PRESENT',
          };
        }
        return null;
      };

      (prisma.packageMetadata.findUnique as unknown) = async () => {
        return {
          id: 'meta-git',
          packageId: 'Git.Git',
          version: '2.56.0',
          publisher: 'The Git Community',
          homepageUrl: 'https://git-scm.com/',
          releaseNotesUrl: 'https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.1',
          releaseNotesSummary: '* Full release notes for Git 2.56.0',
          fetchStatus: 'success',
          fetchedAt: new Date(Date.now() - 3600000), // 1 hour ago
          expiresAt: new Date(Date.now() + 82800000), // in 23 hours
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      };

      (prisma.packageMetadata.findFirst as unknown) = async () => null;

      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/updates/app-git-1`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      assert.strictEqual(res.status, 200);
      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.packageId, 'Git.Git');
      assert.strictEqual(json.data.targetVersion, '2.56.0');
      assert.strictEqual(json.data.version, '2.56.0');
      assert.strictEqual(json.data.officialSourceLink, 'https://git-scm.com/');
      assert.strictEqual(json.data.releaseNotesLink, 'https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.1');
      assert.strictEqual(json.data.releaseNotesSummary, '* Full release notes for Git 2.56.0');
      assert.strictEqual(json.data.metadataStatus, 'available');
      assert.strictEqual(json.data.status, 'available');

      const releaseInfo = json.data.releaseInfo as Record<string, unknown>;
      assert.strictEqual(releaseInfo.status, 'available');
      assert.deepStrictEqual(releaseInfo.missingMessages, {});
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
      prisma.application.findFirst = originalAppFindFirst;
      prisma.packageMetadata.findUnique = originalMetaFindUnique;
      prisma.packageMetadata.findFirst = originalMetaFindFirst;
    }
  });

  it('GET /api/devices/:id/updates/:updateId returns status "partial" with human message when release notes are missing', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;
    const originalAppFindFirst = prisma.application.findFirst;
    const originalMetaFindUnique = prisma.packageMetadata.findUnique;
    const originalMetaFindFirst = prisma.packageMetadata.findFirst;

    try {
      (prisma.device.findUnique as unknown) = async () => deviceA;

      (prisma.application.findFirst as unknown) = async () => ({
        id: 'app-vim-1',
        deviceId: deviceA.id,
        name: 'Vim Text Editor',
        packageId: 'Vim.Vim',
        matchedPackageId: 'Vim.Vim',
        installedVersion: '9.0.0',
        availableVersion: '9.1.0',
        updateStatus: 'update_available',
        updateCheckedAt: new Date(),
        publisher: 'Vim Devs',
        source: 'winget',
        isInstalled: true,
        isManaged: true,
        matchStatus: 'matched',
      });

      (prisma.packageMetadata.findUnique as unknown) = async () => ({
        id: 'meta-vim',
        packageId: 'Vim.Vim',
        version: '9.1.0',
        publisher: 'Vim Developers',
        homepageUrl: 'https://vim.org/',
        releaseNotesUrl: null,
        releaseNotesSummary: null,
        fetchStatus: 'success',
        fetchedAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      (prisma.packageMetadata.findFirst as unknown) = async () => null;

      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/updates/Vim.Vim`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      assert.strictEqual(res.status, 200);
      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      assert.strictEqual(json.data.metadataStatus, 'partial');
      assert.strictEqual(json.data.officialSourceLink, 'https://vim.org/');
      assert.strictEqual(json.data.releaseNotesLink, null);

      const missingMessages = json.data.missingMessages as Record<string, string>;
      assert.strictEqual(missingMessages.releaseNotes, 'Release notes not provided by the publisher');
      assert.strictEqual(missingMessages.officialSourceLink, undefined);
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
      prisma.application.findFirst = originalAppFindFirst;
      prisma.packageMetadata.findUnique = originalMetaFindUnique;
      prisma.packageMetadata.findFirst = originalMetaFindFirst;
    }
  });

  it('GET /api/devices/:id/updates/:updateId returns status "missing" when no metadata exists in cache', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;
    const originalAppFindFirst = prisma.application.findFirst;
    const originalMetaFindUnique = prisma.packageMetadata.findUnique;
    const originalMetaFindFirst = prisma.packageMetadata.findFirst;

    try {
      (prisma.device.findUnique as unknown) = async () => deviceA;

      (prisma.application.findFirst as unknown) = async () => ({
        id: 'app-unk-1',
        deviceId: deviceA.id,
        name: 'Custom Utility',
        packageId: 'Custom.Utility',
        matchedPackageId: 'Custom.Utility',
        installedVersion: '1.0.0',
        availableVersion: '1.1.0',
        updateStatus: 'update_available',
        updateCheckedAt: new Date(),
        publisher: 'Unknown',
        source: 'winget',
        isInstalled: true,
        isManaged: true,
        matchStatus: 'matched',
      });

      (prisma.packageMetadata.findUnique as unknown) = async () => null;
      (prisma.packageMetadata.findFirst as unknown) = async () => null;

      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/updates/app-unk-1`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      assert.strictEqual(res.status, 200);
      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      assert.strictEqual(json.data.metadataStatus, 'missing');
      assert.strictEqual(json.data.officialSourceLink, null);
      assert.strictEqual(json.data.releaseNotesLink, null);

      const missing = json.data.missingMessages as Record<string, string>;
      assert.strictEqual(missing.officialSourceLink, 'Official source link not provided by the publisher');
      assert.strictEqual(missing.releaseNotes, 'Release notes not provided by the publisher');
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
      prisma.application.findFirst = originalAppFindFirst;
      prisma.packageMetadata.findUnique = originalMetaFindUnique;
      prisma.packageMetadata.findFirst = originalMetaFindFirst;
    }
  });

  it('GET /api/devices/:id/updates/:updateId returns status "stale" when cache entry has expired', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;
    const originalAppFindFirst = prisma.application.findFirst;
    const originalMetaFindUnique = prisma.packageMetadata.findUnique;
    const originalMetaFindFirst = prisma.packageMetadata.findFirst;

    try {
      (prisma.device.findUnique as unknown) = async () => deviceA;

      (prisma.application.findFirst as unknown) = async () => ({
        id: 'app-7zip-1',
        deviceId: deviceA.id,
        name: '7-Zip',
        packageId: '7zip.7zip',
        matchedPackageId: '7zip.7zip',
        installedVersion: '23.01',
        availableVersion: '24.08',
        updateStatus: 'update_available',
        updateCheckedAt: new Date(),
        publisher: 'Igor Pavlov',
        source: 'winget',
        isInstalled: true,
        isManaged: true,
        matchStatus: 'matched',
      });

      (prisma.packageMetadata.findUnique as unknown) = async () => ({
        id: 'meta-7zip',
        packageId: '7zip.7zip',
        version: '24.08',
        publisher: 'Igor Pavlov',
        homepageUrl: 'https://7-zip.org/',
        releaseNotesUrl: 'https://7-zip.org/history.txt',
        releaseNotesSummary: 'Security fix',
        fetchStatus: 'success',
        fetchedAt: new Date(Date.now() - 100000000), // ~28 hours ago
        expiresAt: new Date(Date.now() - 1000000),   // Expired
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      (prisma.packageMetadata.findFirst as unknown) = async () => null;

      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/updates/app-7zip-1`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      assert.strictEqual(res.status, 200);
      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      assert.strictEqual(json.data.metadataStatus, 'stale');
      assert.strictEqual(json.data.officialSourceLink, 'https://7-zip.org/');
      assert.strictEqual(json.data.releaseNotesLink, 'https://7-zip.org/history.txt');

      const missing = json.data.missingMessages as Record<string, string>;
      assert.strictEqual(missing.general, 'Package metadata is stale and awaiting refresh');
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
      prisma.application.findFirst = originalAppFindFirst;
      prisma.packageMetadata.findUnique = originalMetaFindUnique;
      prisma.packageMetadata.findFirst = originalMetaFindFirst;
    }
  });

  it('enforces ownership: returns 404 when User B requests User A device updates', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;

    try {
      (prisma.device.findUnique as unknown) = async (args: { where: { id: string } }) => {
        if (args.where.id === deviceA.id) return deviceA;
        return null;
      };

      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/updates/app-git-1`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenB}` }, // User B tries accessing User A's device
      });

      assert.strictEqual(res.status, 404);
      const json = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(json.error.code, 'DEVICE_NOT_FOUND');
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
    }
  });

  it('POST /api/devices/:id/metadata-refresh queues job, creates audit event, and returns 201', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;
    const originalScanJobFindFirst = prisma.scanJob.findFirst;
    const originalAppFindMany = prisma.application.findMany;
    const originalTransaction = prisma.$transaction;

    let auditCreated: Record<string, unknown> | null = null;
    let jobCreated: Record<string, unknown> | null = null;

    try {
      (prisma.device.findUnique as unknown) = async () => deviceA;
      (prisma.scanJob.findFirst as unknown) = async () => null; // No active job

      (prisma.application.findMany as unknown) = async () => [
        {
          id: 'app-1',
          deviceId: deviceA.id,
          matchedPackageId: 'Git.Git',
          packageId: 'Git.Git',
          updateStatus: 'update_available',
          isInstalled: true,
        },
        {
          id: 'app-2',
          deviceId: deviceA.id,
          matchedPackageId: '7zip.7zip',
          packageId: '7zip.7zip',
          updateStatus: 'update_available',
          isInstalled: true,
        },
      ];

      (prisma.$transaction as unknown) = async (operations: unknown[]) => {
        jobCreated = {
          id: 'job-refresh-1',
          deviceId: deviceA.id,
          type: 'get_package_metadata',
          status: 'queued',
          appCount: 2,
        };
        auditCreated = {
          eventType: 'METADATA_REFRESH_REQUESTED',
          entityType: 'devices',
        };
        return [jobCreated, auditCreated];
      };

      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/metadata-refresh`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      assert.strictEqual(res.status, 201);
      const json = (await res.json()) as { success: boolean; data: { queued: boolean; packageIds: string[] } };
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.queued, true);
      assert.deepStrictEqual(json.data.packageIds, ['Git.Git', '7zip.7zip']);
      assert.ok(jobCreated);
      assert.ok(auditCreated);
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
      prisma.scanJob.findFirst = originalScanJobFindFirst;
      prisma.application.findMany = originalAppFindMany;
      prisma.$transaction = originalTransaction;
    }
  });

  it('POST /api/devices/:id/metadata-refresh enforces rate limiting (returns 429 on rapid repeat)', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;
    const originalScanJobFindFirst = prisma.scanJob.findFirst;
    const originalAppFindMany = prisma.application.findMany;
    const originalTransaction = prisma.$transaction;

    try {
      (prisma.device.findUnique as unknown) = async () => deviceA;
      (prisma.scanJob.findFirst as unknown) = async () => null;
      (prisma.application.findMany as unknown) = async () => [
        {
          id: 'app-1',
          deviceId: deviceA.id,
          matchedPackageId: 'Git.Git',
          updateStatus: 'update_available',
          isInstalled: true,
        },
      ];
      (prisma.$transaction as unknown) = async () => [
        { id: 'job-1', type: 'get_package_metadata' },
        { id: 'audit-1' },
      ];

      // First call succeeds (sets rate limit timestamp)
      const res1 = await fetch(`${baseUrl}/api/devices/${deviceA.id}/metadata-refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(res1.status, 201);

      // Immediate second call should be rate limited
      const res2 = await fetch(`${baseUrl}/api/devices/${deviceA.id}/metadata-refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(res2.status, 429);
      const json2 = (await res2.json()) as { success: boolean; error: { code: string; message: string } };
      assert.strictEqual(json2.error.code, 'RATE_LIMITED');
      assert.ok(res2.headers.get('Retry-After'));
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
      prisma.scanJob.findFirst = originalScanJobFindFirst;
      prisma.application.findMany = originalAppFindMany;
      prisma.$transaction = originalTransaction;
    }
  });

  it('POST /api/devices/:id/metadata-refresh rejects non-owner with 404', async () => {
    const originalDeviceFindUnique = prisma.device.findUnique;

    try {
      (prisma.device.findUnique as unknown) = async (args: { where: { id: string } }) => {
        if (args.where.id === deviceA.id) return deviceA;
        return null;
      };

      const res = await fetch(`${baseUrl}/api/devices/${deviceA.id}/metadata-refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenB}` }, // User B
      });

      assert.strictEqual(res.status, 404);
      const json = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(json.error.code, 'DEVICE_NOT_FOUND');
    } finally {
      prisma.device.findUnique = originalDeviceFindUnique;
    }
  });
});
