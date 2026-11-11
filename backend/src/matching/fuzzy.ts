import type { MatchStatus, MatchMethod, MatchReasonCode } from './reasons.js';

export interface NamePublisherCandidate {
  packageId: string;
  name: string;
  publisher: string;
}

export interface FuzzyMatchApp {
  name: string;
  publisher?: string | null;
  source?: string | null;
}

export interface FuzzyMatchResult {
  matchStatus: MatchStatus;
  matchReason: MatchReasonCode;
  matchMethod: MatchMethod;
  matchedPackageId: string | null;
  matchConfidence: number | null;
  candidates?: NamePublisherCandidate[];
}

/**
 * Seed table of known packages extracted from verified WinGet repositories and fixtures.
 * The agent or backend catalogue refresher can supplement or update this list.
 */
export const DEFAULT_KNOWN_PACKAGES: NamePublisherCandidate[] = [
  { packageId: '7zip.7zip', name: '7-Zip', publisher: 'Igor Pavlov' },
  { packageId: 'Anaconda.Anaconda3', name: 'Anaconda3', publisher: 'Anaconda' },
  { packageId: 'Google.AntigravityIDE', name: 'Antigravity IDE', publisher: 'Google LLC' },
  { packageId: 'AnyDesk.AnyDesk', name: 'AnyDesk', publisher: 'AnyDesk Software GmbH' },
  { packageId: 'OpenAI.ChatGPT', name: 'ChatGPT', publisher: 'OpenAI' },
  { packageId: 'Microsoft.365Copilot', name: 'Copilot', publisher: 'Microsoft Corporation' },
  { packageId: 'Anysphere.Cursor', name: 'Cursor', publisher: 'Anysphere' },
  { packageId: 'DBBrowserForSQLite.DBBrowserForSQLite', name: 'DB Browser for SQLite', publisher: 'DB Browser for SQLite Team' },
  { packageId: 'IObit.DriverBooster', name: 'Driver Booster', publisher: 'IObit' },
  { packageId: 'Git.Git', name: 'Git', publisher: 'The Git Development Community' },
  { packageId: 'GitHub.GitHubDesktop', name: 'GitHub Desktop', publisher: 'GitHub, Inc.' },
  { packageId: 'Google.Chrome', name: 'Google Chrome', publisher: 'Google LLC' },
  { packageId: 'Oracle.JDK.23', name: 'Java(TM) SE Development Kit', publisher: 'Oracle Corporation' },
  { packageId: 'Oracle.JDK.25', name: 'Java(TM) SE Development Kit', publisher: 'Oracle Corporation' },
  { packageId: 'Microsoft.Edge', name: 'Microsoft Edge', publisher: 'Microsoft Corporation' },
  { packageId: 'Microsoft.OneDrive', name: 'Microsoft OneDrive', publisher: 'Microsoft Corporation' },
  { packageId: 'Microsoft.Teams', name: 'Microsoft Teams', publisher: 'Microsoft Corporation' },
  { packageId: 'Mozilla.Firefox', name: 'Mozilla Firefox', publisher: 'Mozilla' },
  { packageId: 'Notepad++.Notepad++', name: 'Notepad++', publisher: 'Notepad++ Team' },
  { packageId: 'Postman.Postman', name: 'Postman', publisher: 'Postman, Inc.' },
  { packageId: 'Python.Python.3.14', name: 'Python', publisher: 'Python Software Foundation' },
  { packageId: 'VideoLAN.VLC', name: 'VLC media player', publisher: 'VideoLAN' },
  { packageId: 'Microsoft.VisualStudioCode', name: 'Visual Studio Code', publisher: 'Microsoft Corporation' },
  { packageId: 'RARLab.WinRAR', name: 'WinRAR', publisher: 'win.rar GmbH' },
  { packageId: 'Zoom.Zoom', name: 'Zoom', publisher: 'Zoom Video Communications, Inc.' },
];

/**
 * Normalise application name for conservative comparison:
 * - Lowercase
 * - Remove parenthetical metadata (e.g. (x64), (64-bit), (remove only), (user))
 * - Remove architecture markers (x64, x86, 64-bit, 32-bit, arm64, arm)
 * - Remove semantic version numbers (e.g. 24.09, 3.14.0, 2026.07-1, 9.0.104) and standalone years
 * - Remove edition words (remove only, community, enterprise, professional, edition, runtime, redistributable)
 * - Remove punctuation and collapse whitespace
 */
export function normalizeAppName(name: string | null | undefined): string {
  if (!name) return '';
  let n = name.toLowerCase();

  // Remove parenthetical clauses
  n = n.replace(/\((.*?)\)/g, ' ');

  // Remove architecture markers
  n = n.replace(/\b(x64|x86|64-bit|32-bit|arm64|arm)\b/g, ' ');

  // Remove version patterns: e.g. v1.2.3, 2026.07-1, 24.09, 3.14.0, 9.0.104
  n = n.replace(/\bv?\d+(\.\d+)+(-\w+)?\b/g, ' ');

  // Remove 4-digit years (e.g. 2021, 2024, 2026)
  n = n.replace(/\b(19|20)\d{2}\b/g, ' ');

  // Remove edition, variant and uninstall descriptor words
  n = n.replace(/\b(remove only|community|enterprise|professional|edition|runtime|redistributable|user)\b/g, ' ');

  // Remove trailing version digits attached to words (e.g. tomcat9 -> tomcat, python3 -> python)
  n = n.replace(/([a-z]+)\d+\b/g, '$1');

  // Remove all non-alphanumeric characters (punctuation, hyphens, brackets)
  n = n.replace(/[^\w\s]/g, ' ');

  // Deduplicate consecutive identical words and collapse whitespace
  const tokens = n.trim().split(/\s+/);
  const deduped: string[] = [];
  for (const token of tokens) {
    if (token && deduped[deduped.length - 1] !== token) {
      deduped.push(token);
    }
  }

  return deduped.join(' ');
}

/**
 * Normalise publisher string for conservative comparison:
 * - Lowercase
 * - Remove parenthetical metadata
 * - Remove corporate and legal business entity suffixes (Inc, Ltd, Corporation, LLC, GmbH, etc.)
 * - Remove punctuation and collapse whitespace
 */
export function normalizePublisher(publisher: string | null | undefined): string {
  if (!publisher) return '';
  let p = publisher.toLowerCase();

  // Remove parenthetical clauses
  p = p.replace(/\((.*?)\)/g, ' ');

  // Remove punctuation
  p = p.replace(/[^\w\s]/g, ' ');

  // Remove corporate suffixes and articles
  p = p.replace(
    /\b(incorporated|corporation|limited|company|gmbh|corp|ltd|inc|llc|pty|sa|co|the)\b/g,
    ' '
  );

  // Trim and collapse whitespace
  return p.trim().replace(/\s+/g, ' ');
}

/**
 * Conservative Name and Publisher Matching:
 * 
 * Rules:
 * 1. Strict equality: Both normalized name AND normalized publisher must agree.
 * 2. Never use partial or 'contains' matching.
 * 3. Matched only when exactly ONE candidate matches both name and publisher (NAME_PUBLISHER_UNIQUE, confidence 0.75).
 * 4. More than one candidate gives ambiguous with reason MULTIPLE_CANDIDATES and candidates list stored.
 * 5. Name match with a different publisher gives unsupported with PUBLISHER_MISMATCH.
 * 6. No name candidate in catalog gives unsupported with NOT_IN_WINGET (or REGISTRY_ONLY if source was registry).
 */
export function matchNameAndPublisher(
  app: FuzzyMatchApp,
  catalog: NamePublisherCandidate[] = DEFAULT_KNOWN_PACKAGES
): FuzzyMatchResult {
  const normAppName = normalizeAppName(app.name);
  const normAppPublisher = normalizePublisher(app.publisher);
  const source = app.source ? app.source.trim().toLowerCase() : '';

  if (!normAppName) {
    return {
      matchStatus: 'unsupported',
      matchReason: 'INSUFFICIENT_DATA',
      matchMethod: 'none',
      matchedPackageId: null,
      matchConfidence: null,
    };
  }

  // 1. Strict name match candidates (never partial or substring match)
  const nameMatches = catalog.filter((candidate) => normalizeAppName(candidate.name) === normAppName);

  // 2. No candidate matched the normalized name
  if (nameMatches.length === 0) {
    if (source === 'registry') {
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
      matchReason: 'NOT_IN_WINGET',
      matchMethod: 'none',
      matchedPackageId: null,
      matchConfidence: null,
    };
  }

  // 3. Name matched, but app has missing or empty publisher
  if (!normAppPublisher) {
    return {
      matchStatus: 'unsupported',
      matchReason: 'INSUFFICIENT_DATA',
      matchMethod: 'none',
      matchedPackageId: null,
      matchConfidence: null,
      candidates: nameMatches,
    };
  }

  // 4. Filter candidates that also match the normalized publisher
  const bothMatches = nameMatches.filter(
    (candidate) => normalizePublisher(candidate.publisher) === normAppPublisher
  );

  // 5. Exactly one candidate matches both name AND publisher
  if (bothMatches.length === 1) {
    return {
      matchStatus: 'matched',
      matchReason: 'NAME_PUBLISHER_UNIQUE',
      matchMethod: 'name_publisher',
      matchedPackageId: bothMatches[0].packageId,
      matchConfidence: 0.75,
      candidates: bothMatches,
    };
  }

  // 6. More than one candidate has matching name and publisher (ambiguous)
  if (bothMatches.length > 1) {
    return {
      matchStatus: 'ambiguous',
      matchReason: 'MULTIPLE_CANDIDATES',
      matchMethod: 'none',
      matchedPackageId: null,
      matchConfidence: null,
      candidates: bothMatches,
    };
  }

  // 7. Name matched one or more packages, but publisher did NOT match
  return {
    matchStatus: 'unsupported',
    matchReason: 'PUBLISHER_MISMATCH',
    matchMethod: 'none',
    matchedPackageId: null,
    matchConfidence: null,
    candidates: nameMatches,
  };
}
