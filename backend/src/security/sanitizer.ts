/**
 * Security sanitization module for external URLs and text.
 * Enforces strict HTTPS-only links, strips embedded credentials,
 * removes ASCII control characters, and safely truncates text to plain string format.
 */

export const MAX_URL_LENGTH = 2048;
export const MAX_RELEASE_NOTES_LENGTH = 16384;
export const MAX_SHORT_TEXT_LENGTH = 256;

// ASCII control characters excluding standard line breaks and tab:
// Excludes \t (0x09), \n (0x0A), \r (0x0D)
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// All control characters including whitespace control characters for URLs
const URL_DISALLOWED_CHARS_REGEX = /[\x00-\x1F\x7F\s]/;

export interface UrlSanitizeResult {
  url: string | null;
  valid: boolean;
  reason?: string;
  originalUrl?: string;
}

export interface TextSanitizeResult {
  text: string | null;
  truncated: boolean;
  originalLength: number;
}

/**
 * Validates and sanitizes an external URL.
 * 
 * Rules:
 * 1. Must be a valid string conforming to WHATWG URL standard.
 * 2. Only 'https:' protocol is permitted. Rejects 'http:', 'javascript:', 'data:', 'file:', etc.
 * 3. Strips embedded user credentials (e.g. https://user:pass@example.com -> https://example.com).
 * 4. Must possess a valid hostname.
 * 5. Rejects URLs containing control characters or whitespace.
 * 6. Drops URLs exceeding MAX_URL_LENGTH (2048 characters) and records the reason.
 */
export function sanitizeHttpsUrl(rawUrl: unknown, maxLength = MAX_URL_LENGTH): UrlSanitizeResult {
  if (rawUrl === null || rawUrl === undefined) {
    return { url: null, valid: false, reason: 'URL is null or undefined' };
  }

  if (typeof rawUrl !== 'string') {
    return { url: null, valid: false, reason: `URL must be a string (received ${typeof rawUrl})` };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { url: null, valid: false, reason: 'URL is empty' };
  }

  if (trimmed.length > maxLength) {
    return {
      url: null,
      valid: false,
      reason: `URL exceeds maximum permitted length of ${maxLength} characters (length: ${trimmed.length})`,
      originalUrl: trimmed.slice(0, 100) + '...',
    };
  }

  if (URL_DISALLOWED_CHARS_REGEX.test(trimmed)) {
    return {
      url: null,
      valid: false,
      reason: 'URL contains disallowed whitespace or control characters',
      originalUrl: trimmed.slice(0, 100),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    return {
      url: null,
      valid: false,
      reason: `Malformed URL could not be parsed: ${(err as Error).message}`,
      originalUrl: trimmed.slice(0, 100),
    };
  }

  // Enforce HTTPS only
  if (parsed.protocol.toLowerCase() !== 'https:') {
    return {
      url: null,
      valid: false,
      reason: `Disallowed protocol '${parsed.protocol}'; only 'https:' is permitted`,
      originalUrl: trimmed.slice(0, 100),
    };
  }

  // Must have a hostname
  if (!parsed.hostname || parsed.hostname.trim().length === 0) {
    return {
      url: null,
      valid: false,
      reason: 'URL is missing a valid hostname',
      originalUrl: trimmed.slice(0, 100),
    };
  }

  // Strip credentials if present (user:pass@)
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
  }

  const sanitized = parsed.toString();
  if (sanitized.length > maxLength) {
    return {
      url: null,
      valid: false,
      reason: `Sanitized URL exceeds maximum permitted length of ${maxLength} characters`,
    };
  }

  return {
    url: sanitized,
    valid: true,
  };
}

/**
 * Sanitizes plain text input by stripping ASCII control characters,
 * normalizing line endings, and truncating to a safe ceiling.
 */
export function sanitizePlainText(
  rawText: unknown,
  maxLength = MAX_RELEASE_NOTES_LENGTH
): TextSanitizeResult {
  if (rawText === null || rawText === undefined) {
    return { text: null, truncated: false, originalLength: 0 };
  }

  let str = String(rawText);

  // Remove control characters (preserves \t, \n, \r)
  str = str.replace(CONTROL_CHARS_REGEX, '');

  // Normalize CRLF to LF
  str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Trim whitespace
  str = str.trim();

  if (str.length === 0) {
    return { text: null, truncated: false, originalLength: 0 };
  }

  const originalLength = str.length;
  if (str.length > maxLength) {
    return {
      text: str.slice(0, maxLength).trim(),
      truncated: true,
      originalLength,
    };
  }

  return {
    text: str,
    truncated: false,
    originalLength,
  };
}
