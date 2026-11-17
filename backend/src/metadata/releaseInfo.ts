import type { PackageMetadata } from '@prisma/client';
import { sanitizeHttpsUrl } from '../security/sanitizer.js';
import { isMetadataStale } from './cache.js';

export type MetadataStatus = 'available' | 'partial' | 'missing' | 'stale';

export interface MissingMessages {
  version?: string;
  officialSourceLink?: string;
  releaseNotes?: string;
  general?: string;
}

export interface ReleaseInfo {
  version: string | null;
  officialSourceLink: string | null;
  releaseNotesLink: string | null;
  releaseNotesSummary: string | null;
  publisher: string | null;
  fetchedAt: string | null;
  expiresAt: string | null;
  status: MetadataStatus;
  metadataStatus: MetadataStatus;
  missingMessages: MissingMessages;
}

/**
 * Builds standard release information with status and human-readable missing item messages.
 *
 * Rules:
 * - Only accepts valid https:// links (via sanitizeHttpsUrl)
 * - Raw untrusted text only, never HTML
 * - No guessing: when fields are missing, state clearly
 *
 * Status definition:
 * - "missing": No cache entry exists or fetchStatus is 'failed'
 * - "stale": Cache entry exists but is past expiresAt / 24h TTL
 * - "available": Cache entry exists, is fresh, and has both official link and release notes
 * - "partial": Cache entry exists, is fresh, but lacks official link or release notes
 */
export function buildReleaseInfo(
  targetVersion: string | null | undefined,
  metadata: PackageMetadata | null | undefined,
  now: Date = new Date()
): ReleaseInfo {
  const version = targetVersion || metadata?.version || null;
  const missingMessages: MissingMessages = {};

  if (!version) {
    missingMessages.version = 'Target version not available';
  }

  // 1. Missing: no metadata record or recorded fetch failure
  if (!metadata || metadata.fetchStatus === 'failed') {
    missingMessages.officialSourceLink = 'Official source link not provided by the publisher';
    missingMessages.releaseNotes = 'Release notes not provided by the publisher';
    missingMessages.general = 'Metadata not available for this package version';

    return {
      version,
      officialSourceLink: null,
      releaseNotesLink: null,
      releaseNotesSummary: null,
      publisher: metadata?.publisher || null,
      fetchedAt: metadata?.fetchedAt ? metadata.fetchedAt.toISOString() : null,
      expiresAt: metadata?.expiresAt ? metadata.expiresAt.toISOString() : null,
      status: 'missing',
      metadataStatus: 'missing',
      missingMessages,
    };
  }

  // Sanitize URLs to ensure strictly valid https:// (drop any http:, javascript:, data:, etc.)
  const rawOfficialUrl = metadata.homepageUrl || null;
  const officialSanitized = rawOfficialUrl ? sanitizeHttpsUrl(rawOfficialUrl) : null;
  const officialSourceLink = officialSanitized?.valid ? officialSanitized.url : null;

  const rawNotesUrl = metadata.releaseNotesUrl || null;
  const notesSanitized = rawNotesUrl ? sanitizeHttpsUrl(rawNotesUrl) : null;
  const releaseNotesLink = notesSanitized?.valid ? notesSanitized.url : null;

  const releaseNotesSummary = metadata.releaseNotesSummary || null;
  const hasReleaseNotes = Boolean(releaseNotesLink || releaseNotesSummary);
  const hasOfficialLink = Boolean(officialSourceLink);

  if (!hasOfficialLink) {
    missingMessages.officialSourceLink = 'Official source link not provided by the publisher';
  }
  if (!hasReleaseNotes) {
    missingMessages.releaseNotes = 'Release notes not provided by the publisher';
  }

  const fetchedAtIso = metadata.fetchedAt.toISOString();
  const expiresAtIso = metadata.expiresAt.toISOString();

  // 2. Stale: metadata exists but is past expiry
  if (isMetadataStale(metadata, now)) {
    missingMessages.general = 'Package metadata is stale and awaiting refresh';
    return {
      version,
      officialSourceLink,
      releaseNotesLink,
      releaseNotesSummary,
      publisher: metadata.publisher || null,
      fetchedAt: fetchedAtIso,
      expiresAt: expiresAtIso,
      status: 'stale',
      metadataStatus: 'stale',
      missingMessages,
    };
  }

  // 3. Fresh: available or partial
  const isAvailable = hasOfficialLink && hasReleaseNotes;
  const status: MetadataStatus = isAvailable ? 'available' : 'partial';

  return {
    version,
    officialSourceLink,
    releaseNotesLink,
    releaseNotesSummary,
    publisher: metadata.publisher || null,
    fetchedAt: fetchedAtIso,
    expiresAt: expiresAtIso,
    status,
    metadataStatus: status,
    missingMessages,
  };
}
