import type { MatchStatus, MatchMethod, MatchReasonCode } from './reasons.js';

export interface ExactMatchCandidate {
  packageId?: string | null;
  source?: string | null;
  name?: string | null;
  publisher?: string | null;
}

export interface ExactMatchResult {
  matchStatus: MatchStatus;
  matchReason: MatchReasonCode;
  matchMethod: MatchMethod;
  matchedPackageId: string | null;
  matchConfidence: number | null;
}

/**
 * Standard WinGet Package Identifier Regex:
 * - Must consist of 2 or more dot-separated segments (e.g. Publisher.Product or Publisher.Product.Variant)
 * - Allowed characters within segments: ASCII letters, numbers, hyphens (-), and underscores (_)
 * - Strict length boundaries: 3 to 256 characters
 */
const WINGET_PACKAGE_ID_REGEX = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

/**
 * Dangerous shell characters or command injection vectors to reject immediately.
 */
const SHELL_OR_MALFORMED_CHARS = /[;&|><$`"'\s\\]|[\x00-\x1F\x7F]/;

/**
 * Known non-WinGet package ID prefixes and formats.
 */
const NON_WINGET_PREFIXES = [
  'arp\\',
  'arp/',
  'msix\\',
  'msix/',
];

const GUID_REGEX = /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}/;

/**
 * Validates whether a candidate string conforms to a legitimate WinGet package identifier.
 */
export function isValidWinGetPackageId(id: unknown): id is string {
  if (typeof id !== 'string') {
    return false;
  }

  const trimmed = id.trim();
  if (trimmed.length < 3 || trimmed.length > 256) {
    return false;
  }

  if (SHELL_OR_MALFORMED_CHARS.test(trimmed)) {
    return false;
  }

  return WINGET_PACKAGE_ID_REGEX.test(trimmed);
}

/**
 * Determines exact package ID match based strictly on facts reported from the device scanner.
 * 
 * Rules:
 * 1. An exact WinGet package ID reported by WinGet on the device (source 'winget' or 'both')
 *    is the strongest evidence.
 * 2. Malformed IDs, oversized values, or IDs containing spaces or shell injection characters
 *    are rejected as unsupported with reason INSUFFICIENT_DATA.
 * 3. Microsoft Store sources ('msstore') or IDs with known system/registry prefixes (e.g. MSIX, ARP\)
 *    receive MSSTORE_OR_SYSTEM_APP and are unsupported for automated updates in this MVP.
 */
export function matchExactPackageId(app: ExactMatchCandidate): ExactMatchResult {
  const rawId = app.packageId ? app.packageId.trim() : '';
  const rawSource = app.source ? app.source.trim().toLowerCase() : '';

  // 1. Missing or empty package ID
  if (!rawId) {
    return {
      matchStatus: 'unsupported',
      matchReason: 'NO_PACKAGE_ID',
      matchMethod: 'none',
      matchedPackageId: null,
      matchConfidence: null,
    };
  }

  // 2. Microsoft Store source or known non-WinGet prefixes (MSIX, ARP, Registry GUIDs)
  const lowerId = rawId.toLowerCase();
  const isMsStoreSource = rawSource === 'msstore';
  const hasNonWinGetPrefix = NON_WINGET_PREFIXES.some((prefix) => lowerId.startsWith(prefix));
  const isGuid = GUID_REGEX.test(rawId);

  if (isMsStoreSource || hasNonWinGetPrefix || isGuid) {
    return {
      matchStatus: 'unsupported',
      matchReason: 'MSSTORE_OR_SYSTEM_APP',
      matchMethod: 'none',
      matchedPackageId: null,
      matchConfidence: null,
    };
  }

  // 3. Reject malformed, shell injection, or oversized identifiers
  if (SHELL_OR_MALFORMED_CHARS.test(rawId) || rawId.length > 256 || rawId.length < 3) {
    return {
      matchStatus: 'unsupported',
      matchReason: 'INSUFFICIENT_DATA',
      matchMethod: 'none',
      matchedPackageId: null,
      matchConfidence: null,
    };
  }

  // 4. Source verification: Must originate from WinGet on the device ('winget' or 'both')
  if (rawSource !== 'winget' && rawSource !== 'both') {
    if (rawSource === 'registry') {
      return {
        matchStatus: 'unsupported',
        matchReason: 'REGISTRY_ONLY',
        matchMethod: 'none',
        matchedPackageId: null,
        matchConfidence: null,
      };
    }
    return {
      matchStatus: 'unsupported',
      matchReason: 'INSUFFICIENT_DATA',
      matchMethod: 'none',
      matchedPackageId: null,
      matchConfidence: null,
    };
  }

  // 5. WinGet format validation (Publisher.Product dot-separated notation)
  if (!WINGET_PACKAGE_ID_REGEX.test(rawId)) {
    return {
      matchStatus: 'unsupported',
      matchReason: 'INSUFFICIENT_DATA',
      matchMethod: 'none',
      matchedPackageId: null,
      matchConfidence: null,
    };
  }

  // 6. Verified exact match
  return {
    matchStatus: 'matched',
    matchReason: 'WINGET_ID_PRESENT',
    matchMethod: 'winget_id',
    matchedPackageId: rawId,
    matchConfidence: 1.0,
  };
}
