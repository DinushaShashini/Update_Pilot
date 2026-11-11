import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchExactPackageId, isValidWinGetPackageId } from './exact.js';

describe('Exact Package ID Matching (backend/src/matching/exact.ts)', () => {
  describe('Valid WinGet Package IDs from Real Fixtures', () => {
    it('matches standard Vendor.Product identifiers from winget source', () => {
      const candidates = [
        { packageId: 'Git.Git', source: 'winget', name: 'Git' },
        { packageId: '7zip.7zip', source: 'both', name: '7-Zip 24.09 (x64)' },
        { packageId: 'Anaconda.Anaconda3', source: 'winget', name: 'Anaconda3' },
        { packageId: 'Google.AntigravityIDE', source: 'winget', name: 'Antigravity IDE' },
        { packageId: 'Microsoft.365Copilot', source: 'winget', name: 'Copilot' },
        { packageId: 'Zoom.Zoom.EXE', source: 'winget', name: 'Zoom' },
        { packageId: 'Microsoft.WindowsAppRuntime.1.8', source: 'winget', name: 'WindowsAppRuntime' },
        { packageId: 'Oracle.JDK.23', source: 'both', name: 'Java(TM) SE Development Kit 23' },
      ];

      for (const candidate of candidates) {
        const result = matchExactPackageId(candidate);
        assert.equal(result.matchStatus, 'matched', `Expected ${candidate.packageId} to match`);
        assert.equal(result.matchReason, 'WINGET_ID_PRESENT');
        assert.equal(result.matchMethod, 'winget_id');
        assert.equal(result.matchedPackageId, candidate.packageId);
        assert.equal(result.matchConfidence, 1.0);
      }
    });

    it('case-insensitively accepts valid sources winget and both', () => {
      const res1 = matchExactPackageId({ packageId: 'Git.Git', source: 'WINGET' });
      assert.equal(res1.matchStatus, 'matched');

      const res2 = matchExactPackageId({ packageId: 'Git.Git', source: 'Both' });
      assert.equal(res2.matchStatus, 'matched');
    });
  });

  describe('Missing or Empty Package IDs', () => {
    it('marks empty or null package ID as unsupported with NO_PACKAGE_ID', () => {
      const emptyInputs = [
        { packageId: null, source: 'winget' },
        { packageId: undefined, source: 'winget' },
        { packageId: '', source: 'winget' },
        { packageId: '   ', source: 'winget' },
      ];

      for (const input of emptyInputs) {
        const result = matchExactPackageId(input);
        assert.equal(result.matchStatus, 'unsupported');
        assert.equal(result.matchReason, 'NO_PACKAGE_ID');
        assert.equal(result.matchMethod, 'none');
        assert.equal(result.matchedPackageId, null);
        assert.equal(result.matchConfidence, null);
      }
    });
  });

  describe('Microsoft Store & Non-WinGet System Prefixes', () => {
    it('marks ARP and MSIX prefixed entries as MSSTORE_OR_SYSTEM_APP', () => {
      const systemCandidates = [
        { packageId: 'ARP\\Machine\\X86\\Google Chrome', source: null },
        { packageId: 'ARP\\Machine\\X64\\{FA325AF9-171E-4615-B301-B049DF1F78F1}', source: null },
        { packageId: 'MSIX\\Microsoft.AV1VideoExtension_2.0.35.0_x64__8wekyb3d8bbwe', source: null },
        { packageId: 'msix\\DrivewintechTechnologyCo.DiracAudoManager', source: 'winget' },
        { packageId: '{5E366957-8D78-4BB5-A790-96F97A9766BD}', source: null },
      ];

      for (const candidate of systemCandidates) {
        const result = matchExactPackageId(candidate);
        assert.equal(result.matchStatus, 'unsupported');
        assert.equal(result.matchReason, 'MSSTORE_OR_SYSTEM_APP');
        assert.equal(result.matchMethod, 'none');
        assert.equal(result.matchedPackageId, null);
      }
    });

    it('marks packages with source msstore as MSSTORE_OR_SYSTEM_APP', () => {
      const msstoreCandidate = { packageId: 'Spotify.Spotify', source: 'msstore' };
      const result = matchExactPackageId(msstoreCandidate);
      assert.equal(result.matchStatus, 'unsupported');
      assert.equal(result.matchReason, 'MSSTORE_OR_SYSTEM_APP');
      assert.equal(result.matchMethod, 'none');
    });
  });

  describe('Registry Only & Unverified Sources', () => {
    it('marks apps with source registry as REGISTRY_ONLY', () => {
      const regApp = { packageId: 'CustomApp.Tool', source: 'registry' };
      const result = matchExactPackageId(regApp);
      assert.equal(result.matchStatus, 'unsupported');
      assert.equal(result.matchReason, 'REGISTRY_ONLY');
      assert.equal(result.matchMethod, 'none');
    });

    it('marks apps with unknown or null source as INSUFFICIENT_DATA', () => {
      const unknownApp = { packageId: 'Valid.Package', source: null };
      const result = matchExactPackageId(unknownApp);
      assert.equal(result.matchStatus, 'unsupported');
      assert.equal(result.matchReason, 'INSUFFICIENT_DATA');
    });
  });

  describe('Malformed, Oversized & Injection-Style IDs', () => {
    it('rejects IDs containing spaces', () => {
      const candidates = [
        { packageId: 'Git for Windows', source: 'winget' },
        { packageId: 'Vendor . Product', source: 'winget' },
        { packageId: 'Microsoft. Office', source: 'winget' },
      ];

      for (const c of candidates) {
        const result = matchExactPackageId(c);
        assert.equal(result.matchStatus, 'unsupported');
        assert.equal(result.matchReason, 'INSUFFICIENT_DATA');
      }
    });

    it('rejects command injection attempts and dangerous shell characters', () => {
      const maliciousCandidates = [
        { packageId: 'Git.Git; rm -rf /', source: 'winget' },
        { packageId: 'Git.Git & calc.exe', source: 'winget' },
        { packageId: 'Git.Git && notepad', source: 'winget' },
        { packageId: 'Git.Git | whoami', source: 'winget' },
        { packageId: 'Git.Git > output.txt', source: 'winget' },
        { packageId: 'Git.Git`id`', source: 'winget' },
        { packageId: 'Git.Git$(calc)', source: 'winget' },
        { packageId: 'Git.Git\\..\\System32', source: 'winget' },
        { packageId: 'Git.Git"quoted"', source: 'winget' },
        { packageId: "Git.Git'single'", source: 'winget' },
        { packageId: 'Git.Git\x00', source: 'winget' },
      ];

      for (const candidate of maliciousCandidates) {
        const result = matchExactPackageId(candidate);
        assert.equal(result.matchStatus, 'unsupported');
        assert.equal(result.matchReason, 'INSUFFICIENT_DATA');
        assert.equal(result.matchedPackageId, null);
      }
    });

    it('rejects oversized package IDs (> 256 characters)', () => {
      const hugeId = 'Vendor.' + 'A'.repeat(260);
      const result = matchExactPackageId({ packageId: hugeId, source: 'winget' });
      assert.equal(result.matchStatus, 'unsupported');
      assert.equal(result.matchReason, 'INSUFFICIENT_DATA');
    });

    it('rejects single-token IDs without dot separation', () => {
      const singleTokens = [
        { packageId: 'git', source: 'winget' },
        { packageId: '7zip', source: 'winget' },
        { packageId: 'Application', source: 'winget' },
      ];

      for (const c of singleTokens) {
        const result = matchExactPackageId(c);
        assert.equal(result.matchStatus, 'unsupported');
        assert.equal(result.matchReason, 'INSUFFICIENT_DATA');
      }
    });
  });

  describe('isValidWinGetPackageId Helper', () => {
    it('returns true for legitimate WinGet IDs', () => {
      assert.equal(isValidWinGetPackageId('Git.Git'), true);
      assert.equal(isValidWinGetPackageId('7zip.7zip'), true);
      assert.equal(isValidWinGetPackageId('Microsoft.WindowsAppRuntime.1.8'), true);
    });

    it('returns false for invalid types, shell chars, spaces and invalid formats', () => {
      assert.equal(isValidWinGetPackageId(null), false);
      assert.equal(isValidWinGetPackageId(123), false);
      assert.equal(isValidWinGetPackageId('SingleWord'), false);
      assert.equal(isValidWinGetPackageId('With Space'), false);
      assert.equal(isValidWinGetPackageId('Dangerous;Command'), false);
      assert.equal(isValidWinGetPackageId('A'.repeat(300)), false);
    });
  });
});
