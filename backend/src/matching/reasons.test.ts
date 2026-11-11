import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATCH_REASON_CODES,
  MATCH_REASONS,
  getMatchReasonMetadata,
  type MatchStatus,
  type MatchReasonCode,
} from './reasons.js';

describe('Application Match Reason Codes & Metadata', () => {
  const validStatuses: MatchStatus[] = ['matched', 'ambiguous', 'unsupported', 'pending'];

  it('every declared reason code has an entry in MATCH_REASONS', () => {
    for (const code of MATCH_REASON_CODES) {
      assert.ok(
        MATCH_REASONS[code],
        `Expected MATCH_REASONS to contain an entry for reason code: ${code}`
      );
      assert.equal(MATCH_REASONS[code].code, code);
    }
  });

  it('every reason code has a non-empty human-readable message and nextStep', () => {
    for (const code of MATCH_REASON_CODES) {
      const meta = MATCH_REASONS[code];
      assert.ok(meta.message && meta.message.trim().length > 15, `Reason ${code} must have a detailed message`);
      assert.ok(meta.nextStep && meta.nextStep.trim().length > 15, `Reason ${code} must have a suggested nextStep`);
      assert.ok(
        validStatuses.includes(meta.status),
        `Reason ${code} has invalid status ${meta.status}`
      );
    }
  });

  it('unsupported status entries are informative explanations, not error states', () => {
    const unsupportedCodes: MatchReasonCode[] = [
      'NO_PACKAGE_ID',
      'NOT_IN_WINGET',
      'REGISTRY_ONLY',
      'MSSTORE_OR_SYSTEM_APP',
      'INSUFFICIENT_DATA',
    ];

    for (const code of unsupportedCodes) {
      const meta = MATCH_REASONS[code];
      assert.equal(meta.status, 'unsupported');
      // Must not use alarming error words
      assert.doesNotMatch(meta.message.toLowerCase(), /\b(fatal|crash|panic|corrupt)\b/i);
    }
  });

  it('matched status codes map to matched with appropriate nextSteps', () => {
    const matchedCodes: MatchReasonCode[] = ['WINGET_ID_PRESENT', 'NAME_PUBLISHER_UNIQUE'];
    for (const code of matchedCodes) {
      const meta = MATCH_REASONS[code];
      assert.equal(meta.status, 'matched');
      assert.ok(meta.nextStep.length > 0);
    }
  });

  it('ambiguous status codes explain safety-first conservative matching', () => {
    const ambiguousCodes: MatchReasonCode[] = ['MULTIPLE_CANDIDATES', 'PUBLISHER_MISMATCH'];
    for (const code of ambiguousCodes) {
      const meta = MATCH_REASONS[code];
      assert.equal(meta.status, 'ambiguous');
      assert.ok(meta.message.toLowerCase().includes('halted') || meta.message.toLowerCase().includes('safety'));
    }
  });

  it('getMatchReasonMetadata retrieves metadata and handles unknown codes gracefully', () => {
    const wingetMeta = getMatchReasonMetadata('WINGET_ID_PRESENT');
    assert.equal(wingetMeta.code, 'WINGET_ID_PRESENT');
    assert.equal(wingetMeta.status, 'matched');

    // Unknown code falls back safely
    const fallbackMeta = getMatchReasonMetadata('NON_EXISTENT_REASON_CODE');
    assert.equal(fallbackMeta.code, 'INSUFFICIENT_DATA');
    assert.equal(fallbackMeta.status, 'unsupported');

    // Null/undefined code falls back safely
    const nullMeta = getMatchReasonMetadata(null);
    assert.equal(nullMeta.code, 'INSUFFICIENT_DATA');
  });
});
