import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';

describe('Update Preview API (POST /api/updates/preview)', () => {
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

  const appWithUpdate = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    deviceId: deviceA.id,
    packageId: 'Git.Git',
    matchedPackageId: 'Git.Git',
    name: 'Git for Windows',
    installedVersion: '2.44.0',
    availableVersion: '2.56.0',
    updateStatus: 'update_available',
    updateCheckedAt: new Date(),
    publisher: 'The Git Community',
    source: 'winget',
    isManaged: true,
    isInstalled: true,
    matchStatus: 'matched',
    matchReason: null,
    matchMethod: 'exact_id',
    matchConfidence: 1.0,
    matchedAt: new Date(),
    candidates: [],
    lastScannedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const sampleMetadata = {
    id: 'mmmmmmmm-mmmm-mmmm-mmmm-mmmmmmmmmmmm',
    packageId: 'Git.Git',
    version: '2.56.0',
    publisher: 'The Git Community',
    homepageUrl: 'https://git-scm.com/',
    releaseNotesUrl: 'https://github.com/git-for-windows/git/releases/tag/v2.56.0',
    releaseNotesSummary: 'Performance improvements and security fixes',
    fetchedAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    fetchStatus: 'success',
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
    const res = await fetch(`${baseUrl}/api/updates/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId: appWithUpdate.id, deviceId: deviceA.id }),
    });

    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.code, 'UNAUTHORIZED');
  });

  it('missing applicationId or deviceId returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/updates/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenUserA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceId: deviceA.id }),
    });

    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.strictEqual(body.error.code, 'INVALID_INPUT');
  });

  it('request for device owned by another user returns 404', async () => {
    const origDevice = prisma.device.findUnique;
    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;

    try {
      const res = await fetch(`${baseUrl}/api/updates/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserB}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ applicationId: appWithUpdate.id, deviceId: deviceA.id }),
      });

      assert.strictEqual(res.status, 404);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.error.code, 'DEVICE_NOT_FOUND');
    } finally {
      prisma.device.findUnique = origDevice;
    }
  });

  it('request for application on another device returns 404', async () => {
    const origDevice = prisma.device.findUnique;
    const origApp = prisma.application.findUnique;
    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;
    prisma.application.findUnique = (async () => ({
      ...appWithUpdate,
      deviceId: 'different-device-id',
    })) as unknown as typeof prisma.application.findUnique;

    try {
      const res = await fetch(`${baseUrl}/api/updates/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ applicationId: appWithUpdate.id, deviceId: deviceA.id }),
      });

      assert.strictEqual(res.status, 404);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.error.code, 'APPLICATION_NOT_FOUND');
    } finally {
      prisma.device.findUnique = origDevice;
      prisma.application.findUnique = origApp;
    }
  });

  it('generates update preview with warnings, source link, target version and token', async () => {
    const origDevice = prisma.device.findUnique;
    const origApp = prisma.application.findUnique;
    const origMeta = prisma.packageMetadata?.findFirst;
    const origPreviewCreate = prisma.updatePreview?.create;

    let savedData: any = null;

    prisma.device.findUnique = (async () => deviceA) as unknown as typeof prisma.device.findUnique;
    prisma.application.findUnique = (async () => appWithUpdate) as unknown as typeof prisma.application.findUnique;
    if (prisma.packageMetadata) {
      prisma.packageMetadata.findFirst = (async () => sampleMetadata) as unknown as typeof prisma.packageMetadata.findFirst;
    }
    if (prisma.updatePreview) {
      prisma.updatePreview.create = (async (args: any) => {
        savedData = args.data;
        return {
          id: 'prev-123',
          ...args.data,
          createdAt: new Date(),
        };
      }) as unknown as typeof prisma.updatePreview.create;
    }

    try {
      const res = await fetch(`${baseUrl}/api/updates/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ applicationId: appWithUpdate.id, deviceId: deviceA.id }),
      });

      assert.strictEqual(res.status, 201);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          id: string;
          package: string;
          installedVersion: string;
          targetVersion: string;
          publisher: string;
          sourceLink: string;
          deviceName: string;
          warnings: string[];
          expiresAt: string;
          confirmationToken: string;
        };
      };

      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.package, 'Git.Git');
      assert.strictEqual(body.data.installedVersion, '2.44.0');
      assert.strictEqual(body.data.targetVersion, '2.56.0');
      assert.strictEqual(body.data.publisher, 'The Git Community');
      assert.strictEqual(body.data.sourceLink, 'https://git-scm.com/');
      assert.strictEqual(body.data.deviceName, 'Work PC');
      assert.ok(Array.isArray(body.data.warnings));
      assert.ok(body.data.warnings.includes('app may need to close'));
      // Device is online and metadata has release notes, so offline and notes missing shouldn't be present
      assert.strictEqual(body.data.warnings.includes('device is offline'), false);
      assert.strictEqual(body.data.warnings.includes('release notes missing'), false);
      assert.ok(body.data.expiresAt);
      assert.ok(body.data.confirmationToken);

      // Verify token hashing and storage
      assert.ok(savedData);
      const expectedHash = crypto.createHash('sha256').update(body.data.confirmationToken).digest('hex');
      assert.strictEqual(savedData.tokenHash, expectedHash);
      assert.strictEqual(savedData.userId, userA.id);
      assert.strictEqual(savedData.deviceId, deviceA.id);
      assert.strictEqual(savedData.targetVersion, '2.56.0');
    } finally {
      prisma.device.findUnique = origDevice;
      prisma.application.findUnique = origApp;
      if (prisma.packageMetadata && origMeta) {
        prisma.packageMetadata.findFirst = origMeta;
      }
      if (prisma.updatePreview && origPreviewCreate) {
        prisma.updatePreview.create = origPreviewCreate;
      }
    }
  });

  it('adds offline and release notes missing warnings when applicable', async () => {
    const origDevice = prisma.device.findUnique;
    const origApp = prisma.application.findUnique;
    const origMeta = prisma.packageMetadata?.findFirst;
    const origPreviewCreate = prisma.updatePreview?.create;

    prisma.device.findUnique = (async () => ({
      ...deviceA,
      status: 'OFFLINE',
    })) as unknown as typeof prisma.device.findUnique;

    prisma.application.findUnique = (async () => appWithUpdate) as unknown as typeof prisma.application.findUnique;

    if (prisma.packageMetadata) {
      // Return metadata without release notes
      prisma.packageMetadata.findFirst = (async () => ({
        ...sampleMetadata,
        releaseNotesUrl: null,
        releaseNotesSummary: null,
      })) as unknown as typeof prisma.packageMetadata.findFirst;
    }

    if (prisma.updatePreview) {
      prisma.updatePreview.create = (async (args: any) => ({
        id: 'prev-offline',
        ...args.data,
        createdAt: new Date(),
      })) as unknown as typeof prisma.updatePreview.create;
    }

    try {
      const res = await fetch(`${baseUrl}/api/updates/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenUserA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ applicationId: appWithUpdate.id, deviceId: deviceA.id }),
      });

      assert.strictEqual(res.status, 201);
      const body = (await res.json()) as {
        success: boolean;
        data: { warnings: string[] };
      };

      assert.ok(body.data.warnings.includes('device is offline'));
      assert.ok(body.data.warnings.includes('release notes missing'));
      assert.ok(body.data.warnings.includes('app may need to close'));
    } finally {
      prisma.device.findUnique = origDevice;
      prisma.application.findUnique = origApp;
      if (prisma.packageMetadata && origMeta) {
        prisma.packageMetadata.findFirst = origMeta;
      }
      if (prisma.updatePreview && origPreviewCreate) {
        prisma.updatePreview.create = origPreviewCreate;
      }
    }
  });
});
