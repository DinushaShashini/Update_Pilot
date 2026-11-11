import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchNameAndPublisher,
  normalizeAppName,
  normalizePublisher,
  type NamePublisherCandidate,
} from './fuzzy.js';

describe('Name and Publisher Matching (backend/src/matching/fuzzy.ts)', () => {
  describe('Normalization Helpers', () => {
    it('normalizes application names by stripping versions, arch markers, and punctuation', () => {
      assert.equal(normalizeAppName('Google Chrome (x64)'), 'google chrome');
      assert.equal(normalizeAppName('7-Zip 24.09 (x64)'), '7 zip');
      assert.equal(normalizeAppName('Python 3.14.0 (64-bit)'), 'python');
      assert.equal(normalizeAppName('Apache Tomcat 9.0 Tomcat9 (remove only)'), 'apache tomcat');
      assert.equal(normalizeAppName('Visual Studio Code Community Edition'), 'visual studio code');
      assert.equal(normalizeAppName('  GitHub   Desktop!  '), 'github desktop');
    });

    it('normalizes publishers by removing corporate suffixes and punctuation', () => {
      assert.equal(normalizePublisher('Google LLC'), 'google');
      assert.equal(normalizePublisher('Microsoft Corporation'), 'microsoft');
      assert.equal(normalizePublisher('GitHub, Inc.'), 'github');
      assert.equal(normalizePublisher('AnyDesk Software GmbH'), 'anydesk software');
      assert.equal(normalizePublisher('The Git Development Community'), 'git development community');
      assert.equal(normalizePublisher('Zoom Video Communications, Inc.'), 'zoom video communications');
      assert.equal(normalizePublisher('Acme Corp. Ltd.'), 'acme');
    });
  });

  describe('Unique Matches', () => {
    it('matches when exactly one candidate has the same normalized name and publisher', () => {
      const result = matchNameAndPublisher({
        name: 'Google Chrome (x64)',
        publisher: 'Google LLC',
        source: 'registry',
      });

      assert.equal(result.matchStatus, 'matched');
      assert.equal(result.matchReason, 'NAME_PUBLISHER_UNIQUE');
      assert.equal(result.matchMethod, 'name_publisher');
      assert.equal(result.matchedPackageId, 'Google.Chrome');
      assert.equal(result.matchConfidence, 0.75);
      assert.equal(result.candidates?.length, 1);
    });

    it('matches regardless of casing differences, corporate suffixes and punctuation', () => {
      const result = matchNameAndPublisher({
        name: 'GITHUB DESKTOP',
        publisher: 'GitHub Corporation',
      });

      assert.equal(result.matchStatus, 'matched');
      assert.equal(result.matchReason, 'NAME_PUBLISHER_UNIQUE');
      assert.equal(result.matchedPackageId, 'GitHub.GitHubDesktop');
    });

    it('matches apps with version suffixes stripped from uninstall registry strings', () => {
      const result = matchNameAndPublisher({
        name: '7-Zip 24.09 (x64)',
        publisher: 'Igor Pavlov',
      });

      assert.equal(result.matchStatus, 'matched');
      assert.equal(result.matchedPackageId, '7zip.7zip');
      assert.equal(result.matchReason, 'NAME_PUBLISHER_UNIQUE');
    });
  });

  describe('Duplicates and Multiple Candidates (Ambiguous)', () => {
    it('returns ambiguous with MULTIPLE_CANDIDATES when multiple catalog entries match', () => {
      // In the seed catalogue, Java(TM) SE Development Kit has Oracle.JDK.23 and Oracle.JDK.25
      const result = matchNameAndPublisher({
        name: 'Java(TM) SE Development Kit 23.0.2 (64-bit)',
        publisher: 'Oracle Corporation',
      });

      assert.equal(result.matchStatus, 'ambiguous');
      assert.equal(result.matchReason, 'MULTIPLE_CANDIDATES');
      assert.equal(result.matchMethod, 'none');
      assert.equal(result.matchedPackageId, null);
      assert.ok(result.candidates && result.candidates.length >= 2);
    });

    it('returns ambiguous when custom test catalog contains competing identical packages', () => {
      const customCatalog: NamePublisherCandidate[] = [
        { packageId: 'Vendor.App.Community', name: 'Cool App', publisher: 'Vendor Inc' },
        { packageId: 'Vendor.App.Professional', name: 'Cool App', publisher: 'Vendor Inc' },
      ];

      const result = matchNameAndPublisher(
        { name: 'Cool App', publisher: 'Vendor LLC' },
        customCatalog
      );

      assert.equal(result.matchStatus, 'ambiguous');
      assert.equal(result.matchReason, 'MULTIPLE_CANDIDATES');
      assert.equal(result.matchedPackageId, null);
      assert.equal(result.candidates?.length, 2);
    });
  });

  describe('Same Name Different Publisher', () => {
    it('returns unsupported with PUBLISHER_MISMATCH when name matches but publisher disagrees', () => {
      const result = matchNameAndPublisher({
        name: 'Google Chrome',
        publisher: 'Untrusted Third Party Corp',
      });

      assert.equal(result.matchStatus, 'unsupported');
      assert.equal(result.matchReason, 'PUBLISHER_MISMATCH');
      assert.equal(result.matchMethod, 'none');
      assert.equal(result.matchedPackageId, null);
      assert.ok(result.candidates && result.candidates.length > 0);
    });
  });

  describe('Missing or Empty Publisher', () => {
    it('returns unsupported with INSUFFICIENT_DATA when app publisher is empty', () => {
      const result = matchNameAndPublisher({
        name: 'Google Chrome',
        publisher: null,
      });

      assert.equal(result.matchStatus, 'unsupported');
      assert.equal(result.matchReason, 'INSUFFICIENT_DATA');
      assert.equal(result.matchedPackageId, null);
      assert.ok(result.candidates && result.candidates.length > 0);
    });

    it('returns unsupported with INSUFFICIENT_DATA when app publisher is whitespace only', () => {
      const result = matchNameAndPublisher({
        name: 'Git',
        publisher: '   ',
      });

      assert.equal(result.matchStatus, 'unsupported');
      assert.equal(result.matchReason, 'INSUFFICIENT_DATA');
      assert.equal(result.matchedPackageId, null);
    });
  });

  describe('Lookalike Names & Strict Non-Partial Matching', () => {
    it('never uses partial or contains matching to falsely match distinct software', () => {
      const lookalikes = [
        { name: 'Git GUI', publisher: 'The Git Development Community' },
        { name: 'Postman Agent', publisher: 'Postman, Inc.' },
        { name: 'Python Launcher', publisher: 'Python Software Foundation' },
        { name: 'Microsoft Visual Studio Code Insiders', publisher: 'Microsoft Corporation' },
      ];

      for (const item of lookalikes) {
        const result = matchNameAndPublisher(item);
        // Lookalike name should not match the parent package
        assert.notEqual(result.matchStatus, 'matched', `Lookalike "${item.name}" must not falsely match`);
        assert.equal(result.matchStatus, 'unsupported');
        assert.equal(result.matchReason, 'NOT_IN_WINGET');
      }
    });
  });

  describe('Unmatched Packages & Registry-Only Handling', () => {
    it('returns NOT_IN_WINGET when candidate does not exist in catalogue', () => {
      const result = matchNameAndPublisher({
        name: 'Custom Proprietary Internal Tool',
        publisher: 'Internal Engineering',
        source: 'winget',
      });

      assert.equal(result.matchStatus, 'unsupported');
      assert.equal(result.matchReason, 'NOT_IN_WINGET');
      assert.equal(result.matchedPackageId, null);
    });

    it('returns REGISTRY_ONLY when app source is registry and no package matches', () => {
      const result = matchNameAndPublisher({
        name: 'Custom Proprietary Internal Tool',
        publisher: 'Internal Engineering',
        source: 'registry',
      });

      assert.equal(result.matchStatus, 'unsupported');
      assert.equal(result.matchReason, 'REGISTRY_ONLY');
      assert.equal(result.matchedPackageId, null);
    });
  });
});
