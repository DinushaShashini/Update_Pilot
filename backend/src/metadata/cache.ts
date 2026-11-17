import { prisma } from '../lib/prisma.js';
import type { PackageMetadata, Prisma } from '@prisma/client';
import {
  sanitizeHttpsUrl,
  sanitizePlainText,
  MAX_RELEASE_NOTES_LENGTH,
  MAX_SHORT_TEXT_LENGTH,
} from '../security/sanitizer.js';

export type DatabaseClient = Prisma.TransactionClient | typeof prisma;

export interface PackageMetadataInput {
  packageId: string;
  version: string;
  publisher?: string | null;
  homepageUrl?: string | null;
  releaseNotesUrl?: string | null;
  releaseNotesSummary?: string | null;
  fetchStatus?: string;
  fetchedAt?: Date;
  expiresAt?: Date;
}

/**
 * Returns configurable metadata cache TTL in hours (default: 24h).
 */
export function getCacheTTLHours(): number {
  const envVal = process.env.METADATA_CACHE_TTL_HOURS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 24;
}

/**
 * Calculate expiry date based on configurable TTL.
 */
export function calculateExpiry(now = new Date(), ttlHours = getCacheTTLHours()): Date {
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
}

/**
 * Checks whether cached metadata is fresh (not expired and was successfully fetched).
 */
export function isMetadataFresh(meta: PackageMetadata | null | undefined, now = new Date()): boolean {
  if (!meta) return false;
  return meta.fetchStatus === 'success' && meta.expiresAt > now;
}

/**
 * Checks whether cached metadata exists but has expired.
 */
export function isMetadataStale(meta: PackageMetadata | null | undefined, now = new Date()): boolean {
  if (!meta) return false;
  return meta.expiresAt <= now;
}

/**
 * Retrieve cached metadata for a specific package ID and version.
 */
export async function getPackageMetadata(
  packageId: string,
  version: string,
  db: DatabaseClient = prisma
): Promise<PackageMetadata | null> {
  const normalizedId = packageId.trim();
  const normalizedVer = version.trim();

  return db.packageMetadata.findUnique({
    where: {
      packageId_version: {
        packageId: normalizedId,
        version: normalizedVer,
      },
    },
  });
}

/**
 * Save or update package metadata in the cache with expiry.
 */
export async function upsertPackageMetadata(
  data: PackageMetadataInput,
  db: DatabaseClient = prisma
): Promise<PackageMetadata> {
  const now = data.fetchedAt || new Date();
  const expiresAt = data.expiresAt || calculateExpiry(now);
  const normalizedId = data.packageId.trim();
  const normalizedVer = data.version.trim();

  // Validate and sanitize URLs (strictly https) and text fields
  const cleanHomepage = data.homepageUrl ? sanitizeHttpsUrl(data.homepageUrl).url : null;
  const cleanReleaseNotesUrl = data.releaseNotesUrl ? sanitizeHttpsUrl(data.releaseNotesUrl).url : null;
  const cleanNotesSummary = data.releaseNotesSummary
    ? sanitizePlainText(data.releaseNotesSummary, MAX_RELEASE_NOTES_LENGTH).text
    : null;
  const cleanPublisher = data.publisher
    ? sanitizePlainText(data.publisher, MAX_SHORT_TEXT_LENGTH).text
    : null;

  return db.packageMetadata.upsert({
    where: {
      packageId_version: {
        packageId: normalizedId,
        version: normalizedVer,
      },
    },
    update: {
      publisher: cleanPublisher,
      homepageUrl: cleanHomepage,
      releaseNotesUrl: cleanReleaseNotesUrl,
      releaseNotesSummary: cleanNotesSummary,
      fetchStatus: data.fetchStatus || 'success',
      fetchedAt: now,
      expiresAt,
    },
    create: {
      packageId: normalizedId,
      version: normalizedVer,
      publisher: cleanPublisher,
      homepageUrl: cleanHomepage,
      releaseNotesUrl: cleanReleaseNotesUrl,
      releaseNotesSummary: cleanNotesSummary,
      fetchStatus: data.fetchStatus || 'success',
      fetchedAt: now,
      expiresAt,
    },
  });
}

export interface PackagesNeedingMetadataResult {
  packagesToFetch: Array<{
    packageId: string;
    version: string;
    appId: string;
    appName: string;
    isStale: boolean;
  }>;
  freshMetadata: PackageMetadata[];
}

/**
 * Determines which applications on a device require metadata retrieval.
 * Rule: Request metadata only for apps with updateStatus "update_available"
 * and only when missing or stale. Caps to 20 packages per job.
 */
export async function determinePackagesNeedingFetch(
  deviceId: string,
  db: DatabaseClient = prisma,
  now = new Date()
): Promise<PackagesNeedingMetadataResult> {
  // Query installed apps with update_available status on this device
  const appsWithUpdates = await db.application.findMany({
    where: {
      deviceId,
      isInstalled: true,
      updateStatus: 'update_available',
    },
    orderBy: { name: 'asc' },
  });

  const packagesToFetch: PackagesNeedingMetadataResult['packagesToFetch'] = [];
  const freshMetadata: PackageMetadata[] = [];
  const seenKeys = new Set<string>();

  for (const app of appsWithUpdates) {
    const pkgId = (app.matchedPackageId || app.packageId || '').trim();
    const ver = (app.availableVersion || '').trim();

    if (!pkgId || !ver) {
      continue;
    }

    const key = `${pkgId.toLowerCase()}@${ver.toLowerCase()}`;
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    const cached = await getPackageMetadata(pkgId, ver, db);

    if (cached && isMetadataFresh(cached, now)) {
      freshMetadata.push(cached);
    } else {
      if (packagesToFetch.length < 20) {
        packagesToFetch.push({
          packageId: pkgId,
          version: ver,
          appId: app.id,
          appName: app.name,
          isStale: Boolean(cached && isMetadataStale(cached, now)),
        });
      }
    }
  }

  return {
    packagesToFetch,
    freshMetadata,
  };
}
