/**
 * Security and URL validation utilities for rendering external package metadata.
 * Non-negotiable rule: only render links that are valid https:// URLs (no javascript:, data: or http:).
 */

export function isValidHttpsUrl(urlString: string | null | undefined): boolean {
  if (!urlString || typeof urlString !== 'string') {
    return false;
  }

  const trimmed = urlString.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) {
    return false;
  }

  // Reject control characters or whitespace
  if (/[\x00-\x1F\x7F\s]/.test(trimmed)) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    // Strictly HTTPS only (no http, javascript, data, file, etc.)
    if (parsed.protocol !== 'https:') {
      return false;
    }

    // Must have a valid hostname containing at least one dot or localhost
    if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
      return false;
    }

    // Reject URLs with embedded credentials
    if (parsed.username || parsed.password) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Safely extracts the hostname from an HTTPS URL for user-facing display.
 */
export function extractHostname(urlString: string | null | undefined): string | null {
  if (!isValidHttpsUrl(urlString)) {
    return null;
  }
  try {
    const parsed = new URL(urlString!.trim());
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Formats a timestamp into the required human-readable relative time string:
 * "Information last updated 3 hours ago", "Information last updated just now", etc.
 */
export function formatRelativeTime(dateInput: string | Date | null | undefined, nowInput?: Date): string {
  if (!dateInput) {
    return 'Information not yet updated';
  }

  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) {
    return 'Information not yet updated';
  }

  const now = nowInput || new Date();
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMin < 1) {
    return 'Information last updated just now';
  }
  if (diffHours < 1) {
    return `Information last updated ${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  }
  if (diffDays < 1) {
    return `Information last updated ${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  }
  return `Information last updated ${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}
