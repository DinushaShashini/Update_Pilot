export type MatchStatus = 'matched' | 'ambiguous' | 'unsupported' | 'pending';

export type MatchMethod = 'winget_id' | 'name_publisher' | 'none';

export const MATCH_REASON_CODES = [
  'WINGET_ID_PRESENT',
  'NAME_PUBLISHER_UNIQUE',
  'MULTIPLE_CANDIDATES',
  'NO_PACKAGE_ID',
  'NOT_IN_WINGET',
  'REGISTRY_ONLY',
  'MSSTORE_OR_SYSTEM_APP',
  'PUBLISHER_MISMATCH',
  'INSUFFICIENT_DATA',
  'PENDING',
] as const;

export type MatchReasonCode = (typeof MATCH_REASON_CODES)[number];

export interface MatchReasonMetadata {
  code: MatchReasonCode;
  status: MatchStatus;
  message: string;
  nextStep: string;
}

export const MATCH_REASONS: Record<MatchReasonCode, MatchReasonMetadata> = {
  WINGET_ID_PRESENT: {
    code: 'WINGET_ID_PRESENT',
    status: 'matched',
    message: 'Matched via verified WinGet package identifier reported directly by the Windows package manager.',
    nextStep: 'Updates can be queried and approved through WinGet repository manifests.',
  },
  NAME_PUBLISHER_UNIQUE: {
    code: 'NAME_PUBLISHER_UNIQUE',
    status: 'matched',
    message: 'Matched via unique application name and matching publisher in the package catalog.',
    nextStep: 'Updates can be queried and evaluated against the verified catalog package.',
  },
  MULTIPLE_CANDIDATES: {
    code: 'MULTIPLE_CANDIDATES',
    status: 'ambiguous',
    message: 'Multiple distinct package manifests matched this software name. Automated matching was halted to prevent applying updates to the wrong product.',
    nextStep: 'Verify the application identifier manually or install the official WinGet package.',
  },
  PUBLISHER_MISMATCH: {
    code: 'PUBLISHER_MISMATCH',
    status: 'ambiguous',
    message: 'Application name matched a catalog package, but publisher information did not agree. Automated matching was halted to ensure safety.',
    nextStep: 'Confirm whether this application originated from an alternate vendor distribution.',
  },
  NO_PACKAGE_ID: {
    code: 'NO_PACKAGE_ID',
    status: 'unsupported',
    message: 'Application was discovered without a package identifier or recognizable installer signature.',
    nextStep: 'This software is inventoried for visibility, but automated updates are not supported.',
  },
  NOT_IN_WINGET: {
    code: 'NOT_IN_WINGET',
    status: 'unsupported',
    message: 'No matching package manifest exists in configured WinGet or public repositories.',
    nextStep: 'Update this software manually or check if the vendor publishes a WinGet manifest.',
  },
  REGISTRY_ONLY: {
    code: 'REGISTRY_ONLY',
    status: 'unsupported',
    message: 'Installed application was discovered exclusively from the Windows Uninstall registry without WinGet management metadata.',
    nextStep: 'No action required; inventory is recorded. Update manually using the vendor installer.',
  },
  MSSTORE_OR_SYSTEM_APP: {
    code: 'MSSTORE_OR_SYSTEM_APP',
    status: 'unsupported',
    message: 'Application is managed by Microsoft Store, MSIX package manager, or Windows system components.',
    nextStep: 'Use the Microsoft Store or Windows Update to manage updates for this application.',
  },
  INSUFFICIENT_DATA: {
    code: 'INSUFFICIENT_DATA',
    status: 'unsupported',
    message: 'Discovered inventory entry lacks sufficient name, version, or identifier metadata to perform deterministic matching.',
    nextStep: 'Ensure the application is properly installed and detected in Windows Add/Remove Programs.',
  },
  PENDING: {
    code: 'PENDING',
    status: 'pending',
    message: 'Application discovered in recent scan and awaiting catalog matching.',
    nextStep: 'Matching will execute automatically during inventory processing.',
  },
};

/**
 * Safely retrieve human-readable metadata for a given match reason code.
 * Always returns a valid explanation, defaulting gracefully if an unknown code is provided.
 */
export function getMatchReasonMetadata(code: string | null | undefined): MatchReasonMetadata {
  if (code && code in MATCH_REASONS) {
    return MATCH_REASONS[code as MatchReasonCode];
  }
  return {
    code: 'INSUFFICIENT_DATA',
    status: 'unsupported',
    message: 'Unknown or unspecified match status.',
    nextStep: 'Run a new inventory scan to re-evaluate application matching.',
  };
}
