import { describe, it, expect } from 'vitest';
import { isValidHttpsUrl, extractHostname, formatRelativeTime } from './urlSafety';

describe('Frontend URL Safety & Relative Time Utilities', () => {
  it('accepts valid https URLs only', () => {
    expect(isValidHttpsUrl('https://git-scm.com/')).toBe(true);
    expect(isValidHttpsUrl('https://github.com/git-for-windows/git/releases')).toBe(true);
    expect(isValidHttpsUrl('https://7-zip.org/download.html')).toBe(true);
  });

  it('rejects unsafe protocols: javascript, data, http, file', () => {
    expect(isValidHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isValidHttpsUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isValidHttpsUrl('http://insecure-site.com')).toBe(false);
    expect(isValidHttpsUrl('file:///C:/Windows/System32')).toBe(false);
    expect(isValidHttpsUrl('blob:https://example.com/uuid')).toBe(false);
  });

  it('rejects credentials in URLs and control characters', () => {
    expect(isValidHttpsUrl('https://user:pass@example.com/')).toBe(false);
    expect(isValidHttpsUrl('https://example.com/\x00evil')).toBe(false);
    expect(isValidHttpsUrl('')).toBe(false);
    expect(isValidHttpsUrl(null)).toBe(false);
    expect(isValidHttpsUrl(undefined)).toBe(false);
  });

  it('extracts hostname safely', () => {
    expect(extractHostname('https://git-scm.com/download')).toBe('git-scm.com');
    expect(extractHostname('https://sub.domain.co.uk/path?arg=1')).toBe('sub.domain.co.uk');
    expect(extractHostname('http://insecure.com')).toBeNull();
    expect(extractHostname('javascript:void(0)')).toBeNull();
  });

  it('formats relative time correctly', () => {
    const fixedNow = new Date('2026-11-17T12:00:00Z');

    // Just now (< 1 min)
    expect(formatRelativeTime('2026-11-17T11:59:30Z', fixedNow)).toBe('Information last updated just now');

    // 15 minutes ago
    expect(formatRelativeTime('2026-11-17T11:45:00Z', fixedNow)).toBe('Information last updated 15 minutes ago');

    // 3 hours ago
    expect(formatRelativeTime('2026-11-17T09:00:00Z', fixedNow)).toBe('Information last updated 3 hours ago');

    // 2 days ago
    expect(formatRelativeTime('2026-11-15T12:00:00Z', fixedNow)).toBe('Information last updated 2 days ago');

    // Missing / invalid
    expect(formatRelativeTime(null, fixedNow)).toBe('Information not yet updated');
    expect(formatRelativeTime('invalid-date', fixedNow)).toBe('Information not yet updated');
  });
});
