import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma.js';
import {
  generateConfirmationToken,
  hashToken,
  verifyConfirmationToken,
  TOKEN_LIFETIME_MS,
} from './token.js';

describe('Confirmation Token Service (backend/src/updates/token.ts)', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const otherUserId = '22222222-2222-2222-2222-222222222222';
  const deviceId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const otherDeviceId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const applicationId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const packageId = 'Git.Git';
  const installedVersion = '2.44.0';
  const targetVersion = '2.56.0';

  it('generates a 32-byte (64 hex char) random token with correct hash and 5m expiry', () => {
    const before = Date.now();
    const { token, tokenHash, expiresAt } = generateConfirmationToken();
    const after = Date.now();

    assert.strictEqual(typeof token, 'string');
    assert.strictEqual(token.length, 64);
    assert.strictEqual(tokenHash, hashToken(token));
    assert.ok(expiresAt.getTime() >= before + TOKEN_LIFETIME_MS);
    assert.ok(expiresAt.getTime() <= after + TOKEN_LIFETIME_MS);
  });

  it('verifies a valid confirmation token without marking it used', async () => {
    const { token, tokenHash, expiresAt } = generateConfirmationToken();
    const mockPreview = {
      id: 'prev-1',
      userId,
      deviceId,
      applicationId,
      packageId,
      installedVersion,
      targetVersion,
      source: 'winget',
      tokenHash,
      expiresAt,
      usedAt: null,
      createdAt: new Date(),
    };

    const origFindFirst = prisma.updatePreview.findFirst;
    prisma.updatePreview.findFirst = (async (args: any) => {
      if (args?.where?.tokenHash === tokenHash) return mockPreview;
      return null;
    }) as unknown as typeof prisma.updatePreview.findFirst;

    try {
      const result = await verifyConfirmationToken({
        token,
        userId,
        deviceId,
        packageId,
        targetVersion,
      });

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.preview?.id, 'prev-1');
      assert.strictEqual(result.preview?.usedAt, null); // Crucial: not marked used!
    } finally {
      prisma.updatePreview.findFirst = origFindFirst;
    }
  });

  it('rejects tampered or non-existent token with TOKEN_NOT_FOUND', async () => {
    const origFindFirst = prisma.updatePreview.findFirst;
    prisma.updatePreview.findFirst = (async () => null) as unknown as typeof prisma.updatePreview.findFirst;

    try {
      const result = await verifyConfirmationToken({
        token: 'tampered-or-unknown-token-string-1234567890',
        userId,
        deviceId,
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.code, 'TOKEN_NOT_FOUND');
    } finally {
      prisma.updatePreview.findFirst = origFindFirst;
    }
  });

  it('rejects expired confirmation token with TOKEN_EXPIRED', async () => {
    const { token, tokenHash } = generateConfirmationToken();
    const expiredAt = new Date(Date.now() - 1000); // 1 second ago
    const mockPreview = {
      id: 'prev-expired',
      userId,
      deviceId,
      applicationId,
      packageId,
      installedVersion,
      targetVersion,
      source: 'winget',
      tokenHash,
      expiresAt: expiredAt,
      usedAt: null,
      createdAt: new Date(Date.now() - 6 * 60 * 1000),
    };

    const origFindFirst = prisma.updatePreview.findFirst;
    prisma.updatePreview.findFirst = (async () => mockPreview) as unknown as typeof prisma.updatePreview.findFirst;

    try {
      const result = await verifyConfirmationToken({
        token,
        userId,
        deviceId,
        packageId,
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.code, 'TOKEN_EXPIRED');
    } finally {
      prisma.updatePreview.findFirst = origFindFirst;
    }
  });

  it('rejects already-used confirmation token with TOKEN_ALREADY_USED', async () => {
    const { token, tokenHash, expiresAt } = generateConfirmationToken();
    const mockPreview = {
      id: 'prev-used',
      userId,
      deviceId,
      applicationId,
      packageId,
      installedVersion,
      targetVersion,
      source: 'winget',
      tokenHash,
      expiresAt,
      usedAt: new Date(Date.now() - 60 * 1000), // Used 1 minute ago
      createdAt: new Date(),
    };

    const origFindFirst = prisma.updatePreview.findFirst;
    prisma.updatePreview.findFirst = (async () => mockPreview) as unknown as typeof prisma.updatePreview.findFirst;

    try {
      const result = await verifyConfirmationToken({
        token,
        userId,
        deviceId,
        packageId,
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.code, 'TOKEN_ALREADY_USED');
    } finally {
      prisma.updatePreview.findFirst = origFindFirst;
    }
  });

  it('rejects token when user does not match with USER_MISMATCH', async () => {
    const { token, tokenHash, expiresAt } = generateConfirmationToken();
    const mockPreview = {
      id: 'prev-user-mismatch',
      userId,
      deviceId,
      applicationId,
      packageId,
      installedVersion,
      targetVersion,
      source: 'winget',
      tokenHash,
      expiresAt,
      usedAt: null,
      createdAt: new Date(),
    };

    const origFindFirst = prisma.updatePreview.findFirst;
    prisma.updatePreview.findFirst = (async () => mockPreview) as unknown as typeof prisma.updatePreview.findFirst;

    try {
      const result = await verifyConfirmationToken({
        token,
        userId: otherUserId, // Wrong user
        deviceId,
        packageId,
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.code, 'USER_MISMATCH');
    } finally {
      prisma.updatePreview.findFirst = origFindFirst;
    }
  });

  it('rejects token when device does not match with DEVICE_MISMATCH', async () => {
    const { token, tokenHash, expiresAt } = generateConfirmationToken();
    const mockPreview = {
      id: 'prev-device-mismatch',
      userId,
      deviceId,
      applicationId,
      packageId,
      installedVersion,
      targetVersion,
      source: 'winget',
      tokenHash,
      expiresAt,
      usedAt: null,
      createdAt: new Date(),
    };

    const origFindFirst = prisma.updatePreview.findFirst;
    prisma.updatePreview.findFirst = (async () => mockPreview) as unknown as typeof prisma.updatePreview.findFirst;

    try {
      const result = await verifyConfirmationToken({
        token,
        userId,
        deviceId: otherDeviceId, // Wrong device
        packageId,
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.code, 'DEVICE_MISMATCH');
    } finally {
      prisma.updatePreview.findFirst = origFindFirst;
    }
  });

  it('rejects token when package does not match with PACKAGE_MISMATCH', async () => {
    const { token, tokenHash, expiresAt } = generateConfirmationToken();
    const mockPreview = {
      id: 'prev-pkg-mismatch',
      userId,
      deviceId,
      applicationId,
      packageId: 'Git.Git',
      installedVersion,
      targetVersion,
      source: 'winget',
      tokenHash,
      expiresAt,
      usedAt: null,
      createdAt: new Date(),
    };

    const origFindFirst = prisma.updatePreview.findFirst;
    prisma.updatePreview.findFirst = (async () => mockPreview) as unknown as typeof prisma.updatePreview.findFirst;

    try {
      const result = await verifyConfirmationToken({
        token,
        userId,
        deviceId,
        packageId: 'Different.Package', // Wrong package
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.code, 'PACKAGE_MISMATCH');
    } finally {
      prisma.updatePreview.findFirst = origFindFirst;
    }
  });

  it('rejects token when targetVersion does not match with VERSION_MISMATCH', async () => {
    const { token, tokenHash, expiresAt } = generateConfirmationToken();
    const mockPreview = {
      id: 'prev-ver-mismatch',
      userId,
      deviceId,
      applicationId,
      packageId: 'Git.Git',
      installedVersion,
      targetVersion: '2.56.0',
      source: 'winget',
      tokenHash,
      expiresAt,
      usedAt: null,
      createdAt: new Date(),
    };

    const origFindFirst = prisma.updatePreview.findFirst;
    prisma.updatePreview.findFirst = (async () => mockPreview) as unknown as typeof prisma.updatePreview.findFirst;

    try {
      const result = await verifyConfirmationToken({
        token,
        userId,
        deviceId,
        packageId: 'Git.Git',
        targetVersion: '3.0.0', // Wrong version
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.code, 'VERSION_MISMATCH');
    } finally {
      prisma.updatePreview.findFirst = origFindFirst;
    }
  });
});
