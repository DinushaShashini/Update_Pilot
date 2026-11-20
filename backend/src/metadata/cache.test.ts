import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateExpiry,
  getCacheTTLHours,
  isMetadataFresh,
  isMetadataStale,
  upsertPackageMetadata,
  getPackageMetadata,
  determinePackagesNeedingFetch,
  type DatabaseClient,
} from './cache.js';
import type { PackageMetadata, Application } from '@prisma/client';

describe('Package Metadata Cache Utility', () => {
  it('uses default 24h TTL and supports environment override', () => {
    const orig = process.env.METADATA_CACHE_TTL_HOURS;
    try {
      delete process.env.METADATA_CACHE_TTL_HOURS;
      assert.strictEqual(getCacheTTLHours(), 24);

      process.env.METADATA_CACHE_TTL_HOURS = '48';
      assert.strictEqual(getCacheTTLHours(), 48);

      process.env.METADATA_CACHE_TTL_HOURS = 'invalid';
      assert.strictEqual(getCacheTTLHours(), 24);
    } finally {
      if (orig !== undefined) process.env.METADATA_CACHE_TTL_HOURS = orig;
      else delete process.env.METADATA_CACHE_TTL_HOURS;
    }
  });

  it('calculates expiry date matching specified TTL', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const expiry = calculateExpiry(now, 24);
    assert.strictEqual(expiry.toISOString(), '2026-11-18T12:00:00.000Z');

    const shortExpiry = calculateExpiry(now, 2);
    assert.strictEqual(shortExpiry.toISOString(), '2026-11-17T14:00:00.000Z');
  });

  it('correctly determines whether metadata is fresh', () => {
    const now = new Date('2026-11-17T12:00:00Z');

    // Fresh: expires in the future, fetchStatus is success
    const freshMeta = {
      packageId: 'Git.Git',
      version: '2.56.0',
      fetchStatus: 'success',
      expiresAt: new Date('2026-11-18T12:00:00Z'),
    } as PackageMetadata;
    assert.strictEqual(isMetadataFresh(freshMeta, now), true);

    // Expired: expires in the past
    const expiredMeta = {
      packageId: 'Git.Git',
      version: '2.56.0',
      fetchStatus: 'success',
      expiresAt: new Date('2026-11-17T11:59:59Z'),
    } as PackageMetadata;
    assert.strictEqual(isMetadataFresh(expiredMeta, now), false);

    // Failed status: even if expires in future, it is not fresh
    const failedMeta = {
      packageId: 'Git.Git',
      version: '2.56.0',
      fetchStatus: 'not_found',
      expiresAt: new Date('2026-11-18T12:00:00Z'),
    } as PackageMetadata;
    assert.strictEqual(isMetadataFresh(failedMeta, now), false);

    assert.strictEqual(isMetadataFresh(null, now), false);
    assert.strictEqual(isMetadataFresh(undefined, now), false);
  });

  it('correctly determines whether metadata is stale', () => {
    const now = new Date('2026-11-17T12:00:00Z');

    // Expired
    const staleMeta = {
      packageId: 'Git.Git',
      version: '2.56.0',
      expiresAt: new Date('2026-11-17T12:00:00Z'), // exactly now or past
    } as PackageMetadata;
    assert.strictEqual(isMetadataStale(staleMeta, now), true);

    // Fresh
    const freshMeta = {
      packageId: 'Git.Git',
      version: '2.56.0',
      expiresAt: new Date('2026-11-17T12:00:01Z'),
    } as PackageMetadata;
    assert.strictEqual(isMetadataStale(freshMeta, now), false);

    assert.strictEqual(isMetadataStale(null, now), false);
  });

  it('upserts and retrieves package metadata in database client', async () => {
    const mockStore: Record<string, PackageMetadata> = {};

    const mockDb = {
      packageMetadata: {
        findUnique: async ({ where }: { where: { packageId_version: { packageId: string; version: string } } }) => {
          const key = `${where.packageId_version.packageId}:${where.packageId_version.version}`;
          return mockStore[key] || null;
        },
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { packageId_version: { packageId: string; version: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const key = `${where.packageId_version.packageId}:${where.packageId_version.version}`;
          const existing = mockStore[key];
          if (existing) {
            const updated = { ...existing, ...update, updatedAt: new Date() } as PackageMetadata;
            mockStore[key] = updated;
            return updated;
          }
          const created = {
            id: 'meta-uuid-1',
            ...create,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as PackageMetadata;
          mockStore[key] = created;
          return created;
        },
      },
    } as unknown as DatabaseClient;

    const saved = await upsertPackageMetadata(
      {
        packageId: 'Git.Git',
        version: '2.56.0',
        publisher: 'The Git Development Community',
        homepageUrl: 'https://git-scm.com',
        releaseNotesUrl: 'https://git-scm.com/relnotes',
        releaseNotesSummary: 'Security fixes',
        fetchStatus: 'success',
      },
      mockDb
    );

    assert.strictEqual(saved.packageId, 'Git.Git');
    assert.strictEqual(saved.version, '2.56.0');
    assert.strictEqual(saved.publisher, 'The Git Development Community');
    assert.strictEqual(saved.releaseNotesSummary, 'Security fixes');

    const fetched = await getPackageMetadata('Git.Git', '2.56.0', mockDb);
    assert.ok(fetched);
    assert.strictEqual(fetched.packageId, 'Git.Git');
    assert.strictEqual(fetched.version, '2.56.0');
  });

  it('determines packages needing fetch only for apps with updateStatus update_available', async () => {
    const now = new Date('2026-11-17T12:00:00Z');

    const apps = [
      // 1. Update available, no cache -> missing -> needs fetch
      {
        id: 'app-1',
        name: 'Git for Windows',
        packageId: 'Git.Git',
        matchedPackageId: 'Git.Git',
        availableVersion: '2.56.0',
        updateStatus: 'update_available',
        isInstalled: true,
      },
      // 2. Update available, cached and fresh -> does NOT need fetch
      {
        id: 'app-2',
        name: '7-Zip',
        packageId: '7zip.7zip',
        matchedPackageId: '7zip.7zip',
        availableVersion: '24.08',
        updateStatus: 'update_available',
        isInstalled: true,
      },
      // 3. Update available, cached but STALE -> needs fetch with isStale = true
      {
        id: 'app-3',
        name: 'Node.js',
        packageId: 'OpenJS.NodeJS',
        matchedPackageId: 'OpenJS.NodeJS',
        availableVersion: '22.11.0',
        updateStatus: 'update_available',
        isInstalled: true,
      },
      // 4. Up to date -> ignored even if cache missing
      {
        id: 'app-4',
        name: 'VS Code',
        packageId: 'Microsoft.VisualStudioCode',
        matchedPackageId: 'Microsoft.VisualStudioCode',
        availableVersion: null,
        updateStatus: 'up_to_date',
        isInstalled: true,
      },
      // 5. Unknown update status -> ignored
      {
        id: 'app-5',
        name: 'Custom App',
        packageId: 'Custom.App',
        matchedPackageId: 'Custom.App',
        availableVersion: null,
        updateStatus: 'unknown',
        isInstalled: true,
      },
    ] as Application[];

    const cacheStore: Record<string, PackageMetadata> = {
      '7zip.7zip:24.08': {
        id: 'meta-2',
        packageId: '7zip.7zip',
        version: '24.08',
        fetchStatus: 'success',
        expiresAt: new Date('2026-11-18T12:00:00Z'), // fresh
      } as PackageMetadata,
      'openjs.nodejs:22.11.0': {
        id: 'meta-3',
        packageId: 'OpenJS.NodeJS',
        version: '22.11.0',
        fetchStatus: 'success',
        expiresAt: new Date('2026-11-17T11:00:00Z'), // expired 1h ago
      } as PackageMetadata,
    };

    const mockDb = {
      application: {
        findMany: async () => apps.filter((a) => a.updateStatus === 'update_available'),
      },
      packageMetadata: {
        findUnique: async ({ where }: { where: { packageId_version: { packageId: string; version: string } } }) => {
          const key = `${where.packageId_version.packageId.toLowerCase()}:${where.packageId_version.version.toLowerCase()}`;
          return cacheStore[key] || null;
        },
      },
    } as unknown as DatabaseClient;

    const res = await determinePackagesNeedingFetch('dev-1', mockDb, now);

    // Fresh metadata should have 7-Zip
    assert.strictEqual(res.freshMetadata.length, 1);
    assert.strictEqual(res.freshMetadata[0].packageId, '7zip.7zip');

    // Packages to fetch should have Git (missing) and Node.js (stale)
    assert.strictEqual(res.packagesToFetch.length, 2);

    const gitItem = res.packagesToFetch.find((p) => p.packageId === 'Git.Git');
    assert.ok(gitItem);
    assert.strictEqual(gitItem.version, '2.56.0');
    assert.strictEqual(gitItem.isStale, false); // missing

    const nodeItem = res.packagesToFetch.find((p) => p.packageId === 'OpenJS.NodeJS');
    assert.ok(nodeItem);
    assert.strictEqual(nodeItem.version, '22.11.0');
    assert.strictEqual(nodeItem.isStale, true); // stale
  });
});
