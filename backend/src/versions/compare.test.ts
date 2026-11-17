import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from './compare.js';

describe('Version Comparison Utility - compareVersions', () => {
  describe('Semantic versions (SemVer basic)', () => {
    it('identical versions return "same"', () => {
      assert.equal(compareVersions('1.0.0', '1.0.0'), 'same');
      assert.equal(compareVersions('2.15.3', '2.15.3'), 'same');
    });

    it('patch increment returns "older" or "newer"', () => {
      assert.equal(compareVersions('1.0.0', '1.0.1'), 'older');
      assert.equal(compareVersions('1.0.1', '1.0.0'), 'newer');
    });

    it('minor increment returns "older" or "newer"', () => {
      assert.equal(compareVersions('1.1.0', '1.2.0'), 'older');
      assert.equal(compareVersions('1.2.0', '1.1.0'), 'newer');
      assert.equal(compareVersions('1.1.0', '1.0.9'), 'newer');
    });

    it('major increment returns "older" or "newer"', () => {
      assert.equal(compareVersions('1.99.99', '2.0.0'), 'older');
      assert.equal(compareVersions('2.0.0', '1.99.99'), 'newer');
      assert.equal(compareVersions('0.9.0', '1.0.0'), 'older');
    });
  });

  describe('2 to 4 part numeric versions & different lengths', () => {
    it('2-part vs 3-part with trailing zeros returns "same"', () => {
      assert.equal(compareVersions('1.2', '1.2.0'), 'same');
      assert.equal(compareVersions('1.2.0', '1.2'), 'same');
    });

    it('2-part vs 4-part with trailing zeros returns "same"', () => {
      assert.equal(compareVersions('1.2', '1.2.0.0'), 'same');
      assert.equal(compareVersions('1.2.0.0', '1.2'), 'same');
    });

    it('2-part comparison', () => {
      assert.equal(compareVersions('1.2', '1.3'), 'older');
      assert.equal(compareVersions('1.3', '1.2'), 'newer');
    });

    it('2-part vs 3-part with non-zero third part', () => {
      assert.equal(compareVersions('1.2', '1.2.1'), 'older');
      assert.equal(compareVersions('1.2.1', '1.2'), 'newer');
    });

    it('4-part versions (Major.Minor.Build.Revision)', () => {
      assert.equal(compareVersions('1.2.3.4', '1.2.3.4'), 'same');
      assert.equal(compareVersions('1.2.3.4', '1.2.3.5'), 'older');
      assert.equal(compareVersions('1.2.3.5', '1.2.3.4'), 'newer');
    });

    it('3-part vs 4-part with revision', () => {
      assert.equal(compareVersions('1.2.3', '1.2.3.1'), 'older');
      assert.equal(compareVersions('1.2.3.1', '1.2.3'), 'newer');
      assert.equal(compareVersions('1.2.3', '1.2.3.0'), 'same');
    });
  });

  describe('Leading zeros & numeric comparisons (1.10 vs 1.9)', () => {
    it('1.10 vs 1.9 numerically compares 10 > 9', () => {
      assert.equal(compareVersions('1.10', '1.9'), 'newer');
      assert.equal(compareVersions('1.9', '1.10'), 'older');
      assert.equal(compareVersions('1.9.0', '1.10.0'), 'older');
      assert.equal(compareVersions('1.10.0', '1.9.0'), 'newer');
    });

    it('leading zeros normalize to same integer value', () => {
      assert.equal(compareVersions('1.01', '1.1'), 'same');
      assert.equal(compareVersions('1.1', '1.01'), 'same');
      assert.equal(compareVersions('01.02.03', '1.2.3'), 'same');
      assert.equal(compareVersions('1.002', '1.2'), 'same');
    });

    it('leading zeros with differing numbers', () => {
      assert.equal(compareVersions('1.01', '1.02'), 'older');
      assert.equal(compareVersions('1.02', '1.1'), 'newer');
    });
  });

  describe('Leading "v" / "V" and whitespace handling', () => {
    it('strips leading "v" and "V"', () => {
      assert.equal(compareVersions('v1.2.3', '1.2.3'), 'same');
      assert.equal(compareVersions('1.2.3', 'v1.2.3'), 'same');
      assert.equal(compareVersions('V2.0', 'v2.0.0'), 'same');
      assert.equal(compareVersions('V3.1.2', 'V3.1.1'), 'newer');
    });

    it('trims leading and trailing whitespace', () => {
      assert.equal(compareVersions('  v1.0.0  ', '1.0.0'), 'same');
      assert.equal(compareVersions(' 2.50.0 ', ' 2.56.0 '), 'older');
    });
  });

  describe('Pre-release tags', () => {
    it('normal version is newer than pre-release version with same core', () => {
      assert.equal(compareVersions('1.0.0-beta', '1.0.0'), 'older');
      assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 'newer');
      assert.equal(compareVersions('1.0.0-alpha', '1.0.0'), 'older');
      assert.equal(compareVersions('1.0.0-preview', '1.0.0'), 'older');
    });

    it('compares pre-release tags alphabetically (alpha < beta < rc)', () => {
      assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), 'older');
      assert.equal(compareVersions('1.0.0-beta', '1.0.0-alpha'), 'newer');
      assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-beta.99'), 'newer');
    });

    it('compares numeric pre-release identifiers numerically (2 < 11)', () => {
      assert.equal(compareVersions('1.0.0-beta.1', '1.0.0-beta.2'), 'older');
      assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), 'older');
      assert.equal(compareVersions('1.0.0-beta.11', '1.0.0-beta.2'), 'newer');
    });

    it('numeric pre-release identifier has lower precedence than string identifier', () => {
      assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), 'older');
      assert.equal(compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.1'), 'newer');
    });

    it('fewer pre-release identifiers has lower precedence', () => {
      assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), 'older');
      assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha'), 'newer');
    });

    it('higher core version beats pre-release tag', () => {
      assert.equal(compareVersions('2.0.0-alpha', '1.0.0'), 'newer');
      assert.equal(compareVersions('1.0.0', '2.0.0-alpha'), 'older');
    });
  });

  describe('Build metadata (+...) is ignored in precedence', () => {
    it('ignores build metadata during comparison', () => {
      assert.equal(compareVersions('1.0.0+20130313144700', '1.0.0'), 'same');
      assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 'same');
      assert.equal(compareVersions('1.0.0-beta+exp.sha.1', '1.0.0-beta+exp.sha.2'), 'same');
      assert.equal(compareVersions('1.0.0-beta+1', '1.0.0'), 'older');
    });

    it('core version precedence still applies with build metadata', () => {
      assert.equal(compareVersions('1.0.1+2020', '1.0.0+2024'), 'newer');
      assert.equal(compareVersions('1.0.0+2024', '1.0.1+2020'), 'older');
    });
  });

  describe('Date versions (CalVer)', () => {
    it('compares standard 3-part date versions', () => {
      assert.equal(compareVersions('2024.05.01', '2024.05.02'), 'older');
      assert.equal(compareVersions('2024.05.02', '2024.05.01'), 'newer');
      assert.equal(compareVersions('2023.12.31', '2024.01.01'), 'older');
    });

    it('compares date versions with leading zeros', () => {
      assert.equal(compareVersions('2024.05.01', '2024.5.1'), 'same');
      assert.equal(compareVersions('2024.5.1', '2024.05.01'), 'same');
    });

    it('compares date versions with 4 parts (revision/build of the day)', () => {
      assert.equal(compareVersions('2024.11.12.1', '2024.11.12.2'), 'older');
      assert.equal(compareVersions('2024.11.12.2', '2024.11.12.1'), 'newer');
      assert.equal(compareVersions('2024.11.12.1', '2024.11.12.1'), 'same');
    });
  });

  describe('Versions with text suffixes', () => {
    it('compares letter patch suffixes (1.2.3a vs 1.2.3b)', () => {
      assert.equal(compareVersions('1.2.3a', '1.2.3b'), 'older');
      assert.equal(compareVersions('1.2.3b', '1.2.3a'), 'newer');
      assert.equal(compareVersions('1.2.3a', '1.2.3a'), 'same');
    });

    it('patch letter suffix is newer than bare version (1.2.3 vs 1.2.3a)', () => {
      assert.equal(compareVersions('1.2.3', '1.2.3a'), 'older');
      assert.equal(compareVersions('1.2.3a', '1.2.3'), 'newer');
    });

    it('2-part versions with letter suffixes (1.0b vs 1.0c)', () => {
      assert.equal(compareVersions('1.0b', '1.0c'), 'older');
      assert.equal(compareVersions('1.0c', '1.0b'), 'newer');
    });

    it('pre-release suffix without hyphen (1.2.3rc1 < 1.2.3)', () => {
      assert.equal(compareVersions('1.2.3rc1', '1.2.3'), 'older');
      assert.equal(compareVersions('1.2.3', '1.2.3rc1'), 'newer');
      assert.equal(compareVersions('1.2.3rc1', '1.2.3rc2'), 'older');
    });
  });

  describe('Garbage, invalid, unknown, and ambiguous inputs', () => {
    it('returns "unknown" for empty or whitespace strings', () => {
      assert.equal(compareVersions('', '1.0.0'), 'unknown');
      assert.equal(compareVersions('1.0.0', ''), 'unknown');
      assert.equal(compareVersions('   ', '1.0.0'), 'unknown');
      assert.equal(compareVersions('1.0.0', '   '), 'unknown');
    });

    it('returns "unknown" for null or undefined', () => {
      assert.equal(compareVersions(null, '1.0.0'), 'unknown');
      assert.equal(compareVersions('1.0.0', null), 'unknown');
      assert.equal(compareVersions(undefined, '1.0.0'), 'unknown');
      assert.equal(compareVersions('1.0.0', undefined), 'unknown');
    });

    it('returns "unknown" for "Unknown", "latest", "n/a", etc.', () => {
      assert.equal(compareVersions('Unknown', '1.0.0'), 'unknown');
      assert.equal(compareVersions('unknown', '1.0.0'), 'unknown');
      assert.equal(compareVersions('1.0.0', 'UNKNOWN'), 'unknown');
      assert.equal(compareVersions('latest', '1.0.0'), 'unknown');
      assert.equal(compareVersions('n/a', '1.0.0'), 'unknown');
      assert.equal(compareVersions('none', '1.0.0'), 'unknown');
    });

    it('returns "unknown" for comparison operators or ranges (e.g. WinGet "< 14.0.1.462")', () => {
      assert.equal(compareVersions('< 14.0.1.462', '14.0.1.462'), 'unknown');
      assert.equal(compareVersions('> 1.0', '1.0'), 'unknown');
      assert.equal(compareVersions('>= 2.0', '2.0'), 'unknown');
      assert.equal(compareVersions('~1.2.3', '1.2.3'), 'unknown');
      assert.equal(compareVersions('^1.2.3', '1.2.3'), 'unknown');
    });

    it('returns "unknown" for unparseable text or symbols', () => {
      assert.equal(compareVersions('git-1a2b3c', '1.0.0'), 'unknown');
      assert.equal(compareVersions('foo.bar', '1.0.0'), 'unknown');
      assert.equal(compareVersions('1.0.0@prod', '1.0.0'), 'unknown');
      assert.equal(compareVersions('1.0.0#1', '1.0.0'), 'unknown');
    });

    it('returns "unknown" for malformed dot structures', () => {
      assert.equal(compareVersions('1..2', '1.2'), 'unknown');
      assert.equal(compareVersions('.1.2', '1.2'), 'unknown');
      assert.equal(compareVersions('1.2.', '1.2'), 'unknown');
      assert.equal(compareVersions('1.2.3.4.5.6.7', '1.0.0'), 'unknown');
    });

    it('returns "unknown" when formats differ in an ambiguous way (CalVer vs small SemVer)', () => {
      assert.equal(compareVersions('2024.05.01', '1.2.3'), 'unknown');
      assert.equal(compareVersions('1.2.3', '2024.05.01'), 'unknown');
    });
  });
});
