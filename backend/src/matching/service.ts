import { prisma } from '../lib/prisma.js';
import { matchExactPackageId } from './exact.js';
import {
  matchNameAndPublisher,
  type NamePublisherCandidate,
} from './fuzzy.js';
import type { MatchStatus, MatchMethod, MatchReasonCode } from './reasons.js';
import type { Prisma } from '@prisma/client';

export interface ApplicationMatchInput {
  name: string;
  publisher?: string | null;
  packageId?: string | null;
  source?: string | null;
}

export interface ApplicationMatchResult {
  matchStatus: MatchStatus;
  matchReason: MatchReasonCode;
  matchMethod: MatchMethod;
  matchedPackageId: string | null;
  matchConfidence: number | null;
  candidates: NamePublisherCandidate[];
}

export interface DeviceMatchSummary {
  deviceId: string;
  totalProcessed: number;
  updatedRowsCount: number;
  matchedCount: number;
  ambiguousCount: number;
  unsupportedCount: number;
}

/**
 * Combines exact package ID matching with fallback name and publisher matching.
 * 
 * Precedence:
 * 1. Exact WinGet ID match reported from device scanner (highest confidence: 1.0).
 * 2. If known Microsoft Store or system prefix (MSIX, ARP), reject as unsupported (MSSTORE_OR_SYSTEM_APP).
 * 3. Fallback to name and publisher matching (medium confidence: 0.75 for unique match).
 */
export function matchApplication(
  app: ApplicationMatchInput,
  catalog?: NamePublisherCandidate[]
): ApplicationMatchResult {
  // Step 1: Attempt exact package ID match
  const exactResult = matchExactPackageId({
    packageId: app.packageId,
    source: app.source,
    name: app.name,
    publisher: app.publisher,
  });

  if (exactResult.matchStatus === 'matched') {
    return {
      matchStatus: exactResult.matchStatus,
      matchReason: exactResult.matchReason,
      matchMethod: exactResult.matchMethod,
      matchedPackageId: exactResult.matchedPackageId,
      matchConfidence: exactResult.matchConfidence,
      candidates: [],
    };
  }

  // If designated as Microsoft Store or system app, preserve that specific classification
  if (exactResult.matchReason === 'MSSTORE_OR_SYSTEM_APP') {
    return {
      matchStatus: 'unsupported',
      matchReason: 'MSSTORE_OR_SYSTEM_APP',
      matchMethod: 'none',
      matchedPackageId: null,
      matchConfidence: null,
      candidates: [],
    };
  }

  // Step 2: Fallback to conservative name and publisher matching
  const fuzzyResult = matchNameAndPublisher(
    {
      name: app.name,
      publisher: app.publisher,
      source: app.source,
    },
    catalog
  );

  return {
    matchStatus: fuzzyResult.matchStatus,
    matchReason: fuzzyResult.matchReason,
    matchMethod: fuzzyResult.matchMethod,
    matchedPackageId: fuzzyResult.matchedPackageId,
    matchConfidence: fuzzyResult.matchConfidence,
    candidates: fuzzyResult.candidates || [],
  };
}

type DatabaseClient = Prisma.TransactionClient | typeof prisma;

/**
 * Executes matching for all installed applications on a device within a database transaction.
 * Only rewrites rows whose result has changed to minimize database writes.
 */
export async function matchDeviceApplications(
  deviceId: string,
  tx?: DatabaseClient,
  catalog?: NamePublisherCandidate[]
): Promise<DeviceMatchSummary> {
  const db = tx || prisma;

  // Retrieve all installed applications for this device
  const applications = await db.application.findMany({
    where: {
      deviceId,
      isInstalled: true,
    },
    orderBy: { name: 'asc' },
  });

  let matchedCount = 0;
  let ambiguousCount = 0;
  let unsupportedCount = 0;
  let updatedRowsCount = 0;

  const now = new Date();

  for (const app of applications) {
    const result = matchApplication(
      {
        name: app.name,
        publisher: app.publisher,
        packageId: app.packageId,
        source: app.source,
      },
      catalog
    );

    // Track aggregate counts
    if (result.matchStatus === 'matched') matchedCount++;
    else if (result.matchStatus === 'ambiguous') ambiguousCount++;
    else unsupportedCount++;

    // Check if result changed compared to existing row
    const existingCandidatesJson = JSON.stringify(app.candidates || []);
    const newCandidatesJson = JSON.stringify(result.candidates || []);

    const hasChanged =
      app.matchStatus !== result.matchStatus ||
      app.matchReason !== result.matchReason ||
      app.matchMethod !== result.matchMethod ||
      app.matchedPackageId !== result.matchedPackageId ||
      app.matchConfidence !== result.matchConfidence ||
      existingCandidatesJson !== newCandidatesJson;

    if (hasChanged) {
      updatedRowsCount++;
      await db.application.update({
        where: { id: app.id },
        data: {
          matchStatus: result.matchStatus,
          matchReason: result.matchReason,
          matchMethod: result.matchMethod,
          matchedPackageId: result.matchedPackageId,
          matchConfidence: result.matchConfidence,
          candidates: result.candidates as unknown as Prisma.InputJsonValue,
          matchedAt: now,
        },
      });
    }
  }

  return {
    deviceId,
    totalProcessed: applications.length,
    updatedRowsCount,
    matchedCount,
    ambiguousCount,
    unsupportedCount,
  };
}
