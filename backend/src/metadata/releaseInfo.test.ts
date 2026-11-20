import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PackageMetadata } from '@prisma/client';
import { buildReleaseInfo } from './releaseInfo.js';

describe('buildReleaseInfo helper', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  const futureExpiry = new Date('2026-11-18T12:00:00Z');
  const pastExpiry = new Date('2026-11-16T12:00:00Z');

  it('returns status "missing" when metadata is null or undefined', () => {
    const res = buildReleaseInfo('2.56.0', null, now);
    assert.strictEqual(res.status, 'missing');
    assert.strictEqual(res.metadataStatus, 'missing');
    assert.strictEqual(res.version, '2.56.0');
    assert.strictEqual(res.officialSourceLink, null);
    assert.strictEqual(res.releaseNotesLink, null);
    assert.strictEqual(res.releaseNotesSummary, null);
    assert.strictEqual(res.fetchedAt, null);
    assert.strictEqual(res.missingMessages.officialSourceLink, 'Official source link not provided by the publisher');
    assert.strictEqual(res.missingMessages.releaseNotes, 'Release notes not provided by the publisher');
  });

  it('returns status "missing" when fetchStatus is "failed"', () => {
    const failedMeta: PackageMetadata = {
      id: 'meta-fail',
      packageId: 'Unknown.App',
      version: '1.0.0',
      publisher: null,
      homepageUrl: null,
      releaseNotesUrl: null,
      releaseNotesSummary: null,
      fetchStatus: 'failed',
      fetchedAt: new Date('2026-11-17T10:00:00Z'),
      expiresAt: futureExpiry,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const res = buildReleaseInfo('1.0.0', failedMeta, now);
    assert.strictEqual(res.status, 'missing');
    assert.strictEqual(res.metadataStatus, 'missing');
    assert.strictEqual(res.missingMessages.general, 'Metadata not available for this package version');
  });

  it('returns status "available" when fresh and both official link and release notes are present', () => {
    const fullMeta: PackageMetadata = {
      id: 'meta-full',
      packageId: 'Git.Git',
      version: '2.56.0',
      publisher: 'The Git Community',
      homepageUrl: 'https://git-scm.com/',
      releaseNotesUrl: 'https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.1',
      releaseNotesSummary: '* Fast and reliable version control updates',
      fetchStatus: 'success',
      fetchedAt: new Date('2026-11-17T11:00:00Z'),
      expiresAt: futureExpiry,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const res = buildReleaseInfo('2.56.0', fullMeta, now);
    assert.strictEqual(res.status, 'available');
    assert.strictEqual(res.metadataStatus, 'available');
    assert.strictEqual(res.officialSourceLink, 'https://git-scm.com/');
    assert.strictEqual(res.releaseNotesLink, 'https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.1');
    assert.strictEqual(res.releaseNotesSummary, '* Fast and reliable version control updates');
    assert.strictEqual(res.publisher, 'The Git Community');
    assert.strictEqual(res.missingMessages.officialSourceLink, undefined);
    assert.strictEqual(res.missingMessages.releaseNotes, undefined);
  });

  it('returns status "partial" when fresh but missing official source link', () => {
    const partialMeta: PackageMetadata = {
      id: 'meta-part1',
      packageId: 'Tools.Utility',
      version: '3.0.0',
      publisher: 'Developer',
      homepageUrl: null,
      releaseNotesUrl: 'https://example.com/notes',
      releaseNotesSummary: 'Updated tools',
      fetchStatus: 'success',
      fetchedAt: new Date('2026-11-17T11:00:00Z'),
      expiresAt: futureExpiry,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const res = buildReleaseInfo('3.0.0', partialMeta, now);
    assert.strictEqual(res.status, 'partial');
    assert.strictEqual(res.metadataStatus, 'partial');
    assert.strictEqual(res.officialSourceLink, null);
    assert.strictEqual(res.missingMessages.officialSourceLink, 'Official source link not provided by the publisher');
    assert.strictEqual(res.missingMessages.releaseNotes, undefined);
  });

  it('returns status "partial" when fresh but missing release notes', () => {
    const partialMeta: PackageMetadata = {
      id: 'meta-part2',
      packageId: 'Vim.Vim',
      version: '9.1.0',
      publisher: 'Vim Developers',
      homepageUrl: 'https://vim.org/',
      releaseNotesUrl: null,
      releaseNotesSummary: null,
      fetchStatus: 'success',
      fetchedAt: new Date('2026-11-17T11:00:00Z'),
      expiresAt: futureExpiry,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const res = buildReleaseInfo('9.1.0', partialMeta, now);
    assert.strictEqual(res.status, 'partial');
    assert.strictEqual(res.metadataStatus, 'partial');
    assert.strictEqual(res.releaseNotesLink, null);
    assert.strictEqual(res.releaseNotesSummary, null);
    assert.strictEqual(res.missingMessages.officialSourceLink, undefined);
    assert.strictEqual(res.missingMessages.releaseNotes, 'Release notes not provided by the publisher');
  });

  it('returns status "stale" when metadata expiresAt is past now', () => {
    const staleMeta: PackageMetadata = {
      id: 'meta-stale',
      packageId: '7zip.7zip',
      version: '24.08',
      publisher: 'Igor Pavlov',
      homepageUrl: 'https://7-zip.org/',
      releaseNotesUrl: 'https://7-zip.org/history.txt',
      releaseNotesSummary: 'Security fix',
      fetchStatus: 'success',
      fetchedAt: new Date('2026-11-15T10:00:00Z'),
      expiresAt: pastExpiry,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const res = buildReleaseInfo('24.08', staleMeta, now);
    assert.strictEqual(res.status, 'stale');
    assert.strictEqual(res.metadataStatus, 'stale');
    assert.strictEqual(res.officialSourceLink, 'https://7-zip.org/');
    assert.strictEqual(res.releaseNotesLink, 'https://7-zip.org/history.txt');
    assert.strictEqual(res.missingMessages.general, 'Package metadata is stale and awaiting refresh');
  });

  it('rejects unsafe non-HTTPS URLs in metadata (e.g. javascript:, http:)', () => {
    const unsafeMeta: PackageMetadata = {
      id: 'meta-unsafe',
      packageId: 'Risky.App',
      version: '1.2.0',
      publisher: 'Risky Corp',
      homepageUrl: 'javascript:alert(1)',
      releaseNotesUrl: 'data:text/html,<script>',
      releaseNotesSummary: 'Safe plain text release notes',
      fetchStatus: 'success',
      fetchedAt: new Date('2026-11-17T11:00:00Z'),
      expiresAt: futureExpiry,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const res = buildReleaseInfo('1.2.0', unsafeMeta, now);
    // Unsafe URLs stripped by sanitizeHttpsUrl -> officialSourceLink is null, releaseNotesLink is null
    assert.strictEqual(res.officialSourceLink, null);
    assert.strictEqual(res.releaseNotesLink, null);
    // But releaseNotesSummary is present, so releaseNotes is not completely empty
    assert.strictEqual(res.releaseNotesSummary, 'Safe plain text release notes');
    assert.strictEqual(res.status, 'partial');
    assert.strictEqual(res.missingMessages.officialSourceLink, 'Official source link not provided by the publisher');
  });
});
