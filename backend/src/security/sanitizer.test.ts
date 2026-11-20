import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  sanitizeHttpsUrl,
  sanitizePlainText,
  MAX_URL_LENGTH,
  MAX_RELEASE_NOTES_LENGTH,
} from './sanitizer.js';

describe('URL and Text Safety Sanitizer (backend/src/security/sanitizer.ts)', () => {
  describe('HTTPS URL Validation & Sanitization', () => {
    it('accepts valid https:// URLs and retains standard query params, ports, and fragments', () => {
      const cases = [
        'https://git-scm.com',
        'https://www.example.com/',
        'https://example.com/release-notes/2.50.0.txt',
        'https://sub.domain.org:8443/path/index.html?version=2.50.0&lang=en#section-1',
        'https://raw.githubusercontent.com/git/git/master/Documentation/RelNotes/2.50.0.txt',
      ];

      for (const urlStr of cases) {
        const result = sanitizeHttpsUrl(urlStr);
        assert.strictEqual(result.valid, true, `Expected valid for: ${urlStr}`);
        assert.ok(result.url?.startsWith('https://'));
      }
    });

    it('rejects javascript: URLs with a clear reason', () => {
      const malicious = [
        'javascript:alert(1)',
        'javascript:alert(document.cookie)',
        'JAVASCRIPT:void(0)',
        'javascript://%0aalert(1)',
        'javascript:console.log("xss")',
      ];

      for (const urlStr of malicious) {
        const result = sanitizeHttpsUrl(urlStr);
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.url, null);
        assert.ok(result.reason?.includes('only \'https:\' is permitted'));
      }
    });

    it('rejects data: URLs with a clear reason', () => {
      const dataUrls = [
        'data:text/html,<script>alert(1)</script>',
        'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        'DATA:text/plain;charset=utf-8,Hello',
      ];

      for (const urlStr of dataUrls) {
        const result = sanitizeHttpsUrl(urlStr);
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.url, null);
        assert.ok(result.reason?.includes('only \'https:\' is permitted'));
      }
    });

    it('rejects plain http: URLs to enforce HTTPS transport security', () => {
      const httpUrls = [
        'http://insecure.example.com',
        'http://www.7-zip.org/download.html',
        'http://localhost:8080/release',
      ];

      for (const urlStr of httpUrls) {
        const result = sanitizeHttpsUrl(urlStr);
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.url, null);
        assert.ok(result.reason?.includes('only \'https:\' is permitted'));
      }
    });

    it('rejects other non-https protocols (file:, blob:, ftp:, vbscript:)', () => {
      const otherUrls = [
        'file:///C:/Windows/System32/calc.exe',
        'file:///etc/passwd',
        'blob:https://example.com/uuid-blob',
        'ftp://ftp.example.com/file.zip',
        'vbscript:msgbox("test")',
      ];

      for (const urlStr of otherUrls) {
        const result = sanitizeHttpsUrl(urlStr);
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.url, null);
      }
    });

    it('strips embedded user credentials (user:pass@) from URLs', () => {
      const credentialCases = [
        {
          input: 'https://admin:secret123@example.com/notes',
          expected: 'https://example.com/notes',
        },
        {
          input: 'https://user@example.com/path',
          expected: 'https://example.com/path',
        },
        {
          input: 'https://user:p%40ssword@secure.org:8443/rel?tag=v1',
          expected: 'https://secure.org:8443/rel?tag=v1',
        },
      ];

      for (const { input, expected } of credentialCases) {
        const result = sanitizeHttpsUrl(input);
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.url, expected);
      }
    });

    it('rejects URLs exceeding maximum permitted length (2048 chars) with reason', () => {
      const longPath = 'a'.repeat(MAX_URL_LENGTH);
      const oversizedUrl = `https://example.com/${longPath}`;
      assert.ok(oversizedUrl.length > MAX_URL_LENGTH);

      const result = sanitizeHttpsUrl(oversizedUrl);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.url, null);
      assert.ok(result.reason?.includes('exceeds maximum permitted length'));
    });

    it('rejects malformed, non-string, or whitespace-only inputs', () => {
      const malformed = [
        '',
        '   ',
        null,
        undefined,
        12345,
        'not a url',
        'https://',
        'https://   ',
        'https://[invalid-ipv6-bracket',
        'https://example.com/with space',
      ];

      for (const item of malformed) {
        const result = sanitizeHttpsUrl(item);
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.url, null);
        assert.ok(result.reason);
      }
    });

    it('rejects URLs containing embedded control characters or null bytes', () => {
      const controlCharUrls = [
        'https://example.com/\0alert',
        'https://example.com/\x08test',
        'https://example.com/\x1B[31mred\x1B[0m',
        'https://example.com/\r\nHeader-Injection: 1',
      ];

      for (const urlStr of controlCharUrls) {
        const result = sanitizeHttpsUrl(urlStr);
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.url, null);
      }
    });
  });

  describe('Plain Text Sanitization & Safe Truncation', () => {
    it('removes control characters while preserving valid line breaks and tabs', () => {
      const input = 'Line 1\r\nLine 2\tTabbed\x00Null\x07Bell\x1BAnsi';
      const result = sanitizePlainText(input);

      assert.strictEqual(result.truncated, false);
      assert.strictEqual(result.text, 'Line 1\nLine 2\tTabbedNullBellAnsi');
    });

    it('truncates release notes exceeding maximum character ceiling', () => {
      const longText = 'A'.repeat(MAX_RELEASE_NOTES_LENGTH + 500);
      const result = sanitizePlainText(longText, MAX_RELEASE_NOTES_LENGTH);

      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.originalLength, MAX_RELEASE_NOTES_LENGTH + 500);
      assert.strictEqual(result.text?.length, MAX_RELEASE_NOTES_LENGTH);
    });

    it('handles empty, null, or whitespace-only text gracefully', () => {
      assert.strictEqual(sanitizePlainText(null).text, null);
      assert.strictEqual(sanitizePlainText(undefined).text, null);
      assert.strictEqual(sanitizePlainText('').text, null);
      assert.strictEqual(sanitizePlainText('    \n\t  ').text, null);
    });

    it('normalizes mixed CRLF, CR, and LF line endings to standard LF', () => {
      const input = 'First line\r\nSecond line\rThird line\nFourth line';
      const result = sanitizePlainText(input);
      assert.strictEqual(result.text, 'First line\nSecond line\nThird line\nFourth line');
    });
  });
});
