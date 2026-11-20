export type VersionComparison = 'older' | 'same' | 'newer' | 'unknown';

interface CorePart {
  num: number;
  suffix?: string;
}

interface ParsedVersion {
  isCalVer: boolean;
  coreParts: CorePart[];
  preReleaseParts: string[] | null;
}

const PRE_RELEASE_PREFIXES = ['alpha', 'beta', 'rc', 'pre', 'preview', 'dev', 'snapshot'];

function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower === 'unknown' ||
    lower === 'n/a' ||
    lower === 'latest' ||
    lower === 'none' ||
    lower === 'null' ||
    lower === 'undefined'
  ) {
    return null;
  }

  // Reject operators, ranges, and unparseable symbols
  if (/^[<>=~^]/.test(trimmed) || /[@#$%&*]/.test(trimmed)) {
    return null;
  }

  // Strip leading 'v' or 'V' if immediately followed by a digit
  let s = trimmed.replace(/^[vV](?=\d)/, '');

  // Strip and validate build metadata (+...)
  const plusIdx = s.indexOf('+');
  if (plusIdx !== -1) {
    const buildMeta = s.slice(plusIdx + 1);
    s = s.slice(0, plusIdx);
    if (!buildMeta || !/^[0-9a-zA-Z.-]+$/.test(buildMeta)) {
      return null;
    }
  }

  // Pre-release tag separated by hyphen (-)
  const dashIdx = s.indexOf('-');
  let preReleaseParts: string[] | null = null;
  if (dashIdx !== -1) {
    const preStr = s.slice(dashIdx + 1);
    s = s.slice(0, dashIdx);
    if (!preStr) {
      return null;
    }
    const ids = preStr.split('.');
    for (const id of ids) {
      if (!id || !/^[0-9a-zA-Z-]+$/.test(id)) {
        return null;
      }
    }
    preReleaseParts = ids;
  }

  // Validate core version parts separated by dot (.)
  if (!s || s.startsWith('.') || s.endsWith('.') || s.includes('..')) {
    return null;
  }

  const rawParts = s.split('.');
  if (rawParts.length < 1 || rawParts.length > 5) {
    return null;
  }

  const coreParts: CorePart[] = [];
  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i];
    // Each part must start with digits and optionally have a suffix
    const match = part.match(/^(\d+)([a-zA-Z]+[a-zA-Z0-9]*)?$/);
    if (!match) {
      return null;
    }

    const num = parseInt(match[1], 10);
    if (isNaN(num) || num < 0) {
      return null;
    }

    let suffix: string | undefined = match[2]?.toLowerCase();
    if (suffix) {
      // If suffix is a pre-release indicator (e.g. 1.0.0rc1) and no preRelease was set, convert to preRelease
      const sfx = suffix;
      const isPre = PRE_RELEASE_PREFIXES.some((prefix) => sfx.startsWith(prefix));
      if (isPre && preReleaseParts === null && i === rawParts.length - 1) {
        preReleaseParts = [sfx];
        suffix = undefined;
      }
    }

    coreParts.push({ num, suffix });
  }

  // CalVer detection: 4-digit year (1990 - 2100) with at least 2 parts
  const isCalVer = coreParts[0].num >= 1990 && coreParts[0].num <= 2100 && coreParts.length >= 2;

  return {
    isCalVer,
    coreParts,
    preReleaseParts,
  };
}

/**
 * Compares installed version relative to available version.
 * Returns:
 * - "older" if installed < available (an update is available)
 * - "same" if installed == available
 * - "newer" if installed > available
 * - "unknown" if either cannot be parsed reliably or formats differ ambiguously
 */
export function compareVersions(
  installed: string | null | undefined,
  available: string | null | undefined
): VersionComparison {
  const parsedInstalled = parseVersion(installed);
  const parsedAvailable = parseVersion(available);

  if (!parsedInstalled || !parsedAvailable) {
    return 'unknown';
  }

  // If one is clearly CalVer (year-based) and the other is a small-number SemVer (< 100),
  // they differ in an ambiguous way and cannot be compared reliably.
  if (parsedInstalled.isCalVer !== parsedAvailable.isCalVer) {
    return 'unknown';
  }

  // 1. Compare numeric core parts left-to-right (pad shorter with 0)
  const maxParts = Math.max(parsedInstalled.coreParts.length, parsedAvailable.coreParts.length);
  for (let i = 0; i < maxParts; i++) {
    const partA = parsedInstalled.coreParts[i] || { num: 0 };
    const partB = parsedAvailable.coreParts[i] || { num: 0 };

    if (partA.num !== partB.num) {
      return partA.num < partB.num ? 'older' : 'newer';
    }

    // Numbers are equal, check suffix if present
    const suffA = partA.suffix;
    const suffB = partB.suffix;
    if (suffA !== suffB) {
      // Patch release letter (e.g. '1.1.1' vs '1.1.1a'): letter is newer than no letter
      if (!suffA && suffB) return 'older';
      if (suffA && !suffB) return 'newer';
      if (suffA && suffB) {
        const cmp = suffA.localeCompare(suffB);
        if (cmp !== 0) {
          return cmp < 0 ? 'older' : 'newer';
        }
      }
    }
  }

  // 2. Core parts are identical, compare pre-release tags
  const hasPreA = parsedInstalled.preReleaseParts !== null && parsedInstalled.preReleaseParts.length > 0;
  const hasPreB = parsedAvailable.preReleaseParts !== null && parsedAvailable.preReleaseParts.length > 0;

  if (hasPreA && !hasPreB) {
    // Installed has pre-release, available is normal release -> installed is older
    return 'older';
  }
  if (!hasPreA && hasPreB) {
    // Installed is normal release, available has pre-release -> installed is newer
    return 'newer';
  }
  if (!hasPreA && !hasPreB) {
    return 'same';
  }

  // Both have pre-release tags: compare identifiers left-to-right
  const preA = parsedInstalled.preReleaseParts!;
  const preB = parsedAvailable.preReleaseParts!;
  const maxPre = Math.max(preA.length, preB.length);

  for (let j = 0; j < maxPre; j++) {
    const idA = preA[j];
    const idB = preB[j];

    if (idA === undefined) {
      // Shorter pre-release has lower precedence
      return 'older';
    }
    if (idB === undefined) {
      return 'newer';
    }
    if (idA === idB) {
      continue;
    }

    const isNumA = /^\d+$/.test(idA);
    const isNumB = /^\d+$/.test(idB);

    if (isNumA && isNumB) {
      const nA = parseInt(idA, 10);
      const nB = parseInt(idB, 10);
      if (nA !== nB) {
        return nA < nB ? 'older' : 'newer';
      }
    } else if (isNumA && !isNumB) {
      // Numeric identifier always has lower precedence than string identifier
      return 'older';
    } else if (!isNumA && isNumB) {
      return 'newer';
    } else {
      const cmp = idA.localeCompare(idB);
      if (cmp !== 0) {
        return cmp < 0 ? 'older' : 'newer';
      }
    }
  }

  return 'same';
}
