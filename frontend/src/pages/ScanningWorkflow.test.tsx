import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Overview } from './Overview';
import { Applications } from './Applications';
import * as overviewApi from '../api/overview';
import * as appsApi from '../api/applications';
import * as scansApi from '../api/scans';

describe('Complete UI Scanning & Matching Workflow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs Scan now -> sees step progress -> sees summary -> opens Applications -> filters Not supported -> opens reason tooltip', async () => {
    // 1. Mock Overview initial state (agent ONLINE)
    vi.spyOn(overviewApi, 'fetchOverviewMetrics').mockResolvedValue({
      ...overviewApi.defaultOverviewMetrics,
      agentStatus: 'ONLINE',
      agentHostname: 'WORKSTATION-01',
      totalApps: 0,
      managedApps: 0,
      unsupportedApps: 0,
    });

    // 2. Mock Scan trigger and progressive poll responses
    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({
      success: true,
      scanId: 'job-ui-e2e-1',
    });

    const fetchScanJobSpy = vi
      .spyOn(scansApi, 'fetchScanJob')
      .mockResolvedValueOnce({
        id: 'job-ui-e2e-1',
        deviceId: 'dev-1',
        type: 'scan_inventory',
        status: 'running',
        progressPercent: 78,
        progressStep: 'normalising_and_merging',
        progressMessage: 'Found 87 apps',
        skippedSteps: ['enriching_publishers'],
        appCount: 0,
        createdAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        id: 'job-ui-e2e-1',
        deviceId: 'dev-1',
        type: 'scan_inventory',
        status: 'succeeded',
        progressPercent: 100,
        progressStep: 'matching_packages',
        appCount: 120,
        matchedCount: 95,
        ambiguousCount: 4,
        unsupportedCount: 21,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

    // 3. Mock Applications inventory after scan
    vi.spyOn(appsApi, 'fetchApplications').mockResolvedValue({
      total: 2,
      page: 1,
      limit: 15,
      totalPages: 1,
      applications: [
        {
          id: 'app-git',
          name: 'Git',
          packageId: 'Git.Git',
          installedVersion: '2.50.0',
          source: 'winget',
          isManaged: true,
          matchStatus: 'matched',
          matchReason: 'WINGET_ID_PRESENT',
          matchMessage: 'Matched via verified WinGet package identifier.',
          matchNextStep: 'Updates can be queried and approved through WinGet.',
          matchedPackageId: 'Git.Git',
          matchConfidence: 1.0,
          matchMethod: 'winget_id',
        },
        {
          id: 'app-reg',
          name: 'Internal Payroll Tool',
          packageId: null,
          installedVersion: '3.2.1',
          source: 'registry',
          isManaged: false,
          matchStatus: 'unsupported',
          matchReason: 'REGISTRY_ONLY',
          matchMessage: 'Installed application was discovered exclusively from the Windows Uninstall registry.',
          matchNextStep: 'Update manually using the vendor installer.',
          matchedPackageId: null,
          matchConfidence: null,
          matchMethod: 'none',
        },
      ],
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/applications" element={<Applications />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for Overview to load with Scan now enabled
    await waitFor(() => {
      expect(screen.getByTestId('overview-page')).toBeDefined();
      expect((screen.getByTestId('scan-now-btn') as HTMLButtonElement).disabled).toBe(false);
    });

    // Click Scan now
    fireEvent.click(screen.getByTestId('scan-now-btn'));

    // Verify running step list and progress
    await waitFor(() => {
      expect(screen.getByTestId('scan-running-state')).toBeDefined();
    });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('78');
    expect(screen.getByTestId('scan-progress-step').textContent).toContain('Found 87 apps');
    expect(screen.getByTestId('scan-step-enriching_publishers').getAttribute('data-step-status')).toBe('skipped');
    expect(screen.getByTestId('scan-step-normalising_and_merging').getAttribute('data-step-status')).toBe('active');

    // Advance 2s to trigger next poll -> succeeded summary
    await vi.advanceTimersByTimeAsync(2000);

    await waitFor(() => {
      expect(screen.getByTestId('scan-succeeded-state')).toBeDefined();
    });
    expect(fetchScanJobSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('scan-match-summary').textContent).toContain(
      '120 apps: 95 matched, 4 ambiguous, 21 unsupported'
    );

    vi.useRealTimers();

    // Navigate to Applications via the "View in Applications" link
    fireEvent.click(screen.getByRole('link', { name: /view in applications/i }));

    await waitFor(() => {
      expect(screen.getByTestId('applications-page')).toBeDefined();
    });

    // Filter by "Not supported"
    fireEvent.click(screen.getByTestId('filter-chip-unsupported'));
    await waitFor(() => {
      expect(screen.getByText('Internal Payroll Tool')).toBeDefined();
      expect(screen.queryByText('Git')).toBeNull();
    });

    // Open tooltip on the "Not supported" badge
    const unsupportedBadge = screen.getByTestId('match-badge-unsupported');
    fireEvent.click(unsupportedBadge);

    await waitFor(() => {
      expect(screen.getByTestId('match-reason-popover')).toBeDefined();
    });
    expect(screen.getByTestId('match-reason-popover').textContent).toContain('REGISTRY_ONLY');
    expect(screen.getByTestId('match-reason-popover').textContent).toContain(
      'Windows Uninstall registry'
    );
  });
});
