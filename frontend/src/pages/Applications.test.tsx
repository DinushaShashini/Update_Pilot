import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Applications } from './Applications';
import * as appsApi from '../api/applications';

describe('Applications Inventory Screen', () => {
  const mockApplications: appsApi.Application[] = [
    {
      id: 'app-1',
      name: 'Git for Windows',
      packageId: 'Git.Git',
      installedVersion: '2.44.0',
      availableVersion: '2.45.0',
      source: 'winget',
      isManaged: true,
    },
    {
      id: 'app-2',
      name: 'Visual Studio Code',
      packageId: 'Microsoft.VisualStudioCode',
      installedVersion: '1.88.1',
      availableVersion: null,
      source: 'winget',
      isManaged: true,
    },
    {
      id: 'app-3',
      name: 'Legacy Accounting Tool',
      packageId: null,
      installedVersion: '3.2.0',
      availableVersion: null,
      source: null,
      isManaged: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(appsApi, 'fetchApplications').mockResolvedValue({
      total: 3,
      page: 1,
      limit: 15,
      totalPages: 1,
      applications: mockApplications,
    });
    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({
      success: true,
      scanId: 'scan-123',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders application list with inventory metrics', async () => {
    render(<Applications />);

    await waitFor(() => {
      expect(screen.getByTestId('app-row-Git.Git')).toBeDefined();
    });

    expect(screen.getByRole('heading', { name: /installed applications/i })).toBeDefined();
    expect(screen.getByText(/3 discovered applications/i)).toBeDefined();
    expect(screen.getByText(/2 supported via winget/i)).toBeDefined();
    expect(screen.getByText(/1 updates available/i)).toBeDefined();
  });

  it('filters applications by live search query', async () => {
    render(<Applications />);

    await waitFor(() => {
      expect(screen.getByTestId('app-row-Git.Git')).toBeDefined();
    });

    const searchInput = screen.getByRole('searchbox', { name: /search applications/i });
    fireEvent.change(searchInput, { target: { value: 'Visual Studio' } });

    expect(screen.getByTestId('app-row-Microsoft.VisualStudioCode')).toBeDefined();
    expect(screen.queryByTestId('app-row-Git.Git')).toBeNull();
  });

  it('filters applications by status (Update Available, Managed, Unsupported)', async () => {
    render(<Applications />);

    await waitFor(() => {
      expect(screen.getByTestId('app-row-Git.Git')).toBeDefined();
    });

    const statusSelect = screen.getByRole('combobox', { name: /filter by status/i });

    // Filter to Updates Available
    fireEvent.change(statusSelect, { target: { value: 'update_available' } });
    await waitFor(() => {
      expect(screen.getByTestId('app-row-Git.Git')).toBeDefined();
      expect(screen.queryByTestId('app-row-Microsoft.VisualStudioCode')).toBeNull();
    });

    // Filter to Unsupported
    fireEvent.change(statusSelect, { target: { value: 'unsupported' } });
    await waitFor(() => {
      expect(screen.getByTestId('app-row-Legacy Accounting Tool')).toBeDefined();
      expect(screen.queryByTestId('app-row-Git.Git')).toBeNull();
    });
  });

  it('opens and closes slide-over details panel on row click and Escape key', async () => {
    render(<Applications />);

    await waitFor(() => {
      expect(screen.getByTestId('app-row-Git.Git')).toBeDefined();
    });

    // Click Git row
    fireEvent.click(screen.getByTestId('app-row-Git.Git'));

    // Details panel opens
    const panel = screen.getByRole('dialog');
    expect(panel).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Git for Windows' })).toBeDefined();
    expect(screen.getAllByText('Git.Git').length).toBeGreaterThanOrEqual(1);

    // Press Escape to close
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('triggers scan on "Scan now" button click and displays confirmation', async () => {
    render(<Applications />);

    await waitFor(() => {
      expect(screen.getByTestId('app-row-Git.Git')).toBeDefined();
    });

    const scanBtn = screen.getByRole('button', { name: /trigger scan now/i });
    fireEvent.click(scanBtn);

    await waitFor(() => {
      expect(appsApi.triggerScan).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByRole('status').textContent).toMatch(/scan initiated successfully/i);
  });

  it('renders empty state when no applications are discovered', async () => {
    vi.spyOn(appsApi, 'fetchApplications').mockResolvedValue({
      total: 0,
      page: 1,
      limit: 15,
      totalPages: 1,
      applications: [],
    });

    render(<Applications />);

    await waitFor(() => {
      expect(screen.getByTestId('apps-empty')).toBeDefined();
    });

    expect(screen.getByText(/no applications found/i)).toBeDefined();
  });

  it('renders error state on API failure with Retry button', async () => {
    vi.spyOn(appsApi, 'fetchApplications').mockRejectedValue(new Error('Network failure loading inventory'));

    render(<Applications />);

    await waitFor(() => {
      expect(screen.getByTestId('apps-error')).toBeDefined();
    });

    expect(screen.getByText('Network failure loading inventory')).toBeDefined();
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toBeDefined();
  });

  it('renders Update support badges with icon and text, keyboard-accessible popover, and clickable summary chips', async () => {
    const richApps: appsApi.Application[] = [
      {
        id: 'app-1',
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
        candidates: [],
      },
      {
        id: 'app-2',
        name: 'Java SE Development Kit',
        packageId: null,
        installedVersion: '23.0.2',
        source: 'registry',
        isManaged: false,
        matchStatus: 'ambiguous',
        matchReason: 'MULTIPLE_CANDIDATES',
        matchMessage: 'Multiple distinct package manifests matched this software name.',
        matchNextStep: 'Verify the application identifier manually.',
        matchedPackageId: null,
        matchConfidence: null,
        matchMethod: 'none',
        candidates: [
          { packageId: 'Oracle.JDK.23', name: 'Java(TM) SE Development Kit', publisher: 'Oracle Corporation' },
          { packageId: 'Oracle.JDK.25', name: 'Java(TM) SE Development Kit', publisher: 'Oracle Corporation' },
        ],
      },
      {
        id: 'app-3',
        name: 'Custom Internal Tool',
        packageId: null,
        installedVersion: '1.0.0',
        source: 'registry',
        isManaged: false,
        matchStatus: 'unsupported',
        matchReason: 'REGISTRY_ONLY',
        matchMessage: 'Discovered exclusively from the Windows Uninstall registry.',
        matchNextStep: 'Update manually using the vendor installer.',
        matchedPackageId: null,
        matchConfidence: null,
        matchMethod: 'none',
        candidates: [],
      },
    ];

    vi.spyOn(appsApi, 'fetchApplications').mockResolvedValue({
      total: 3,
      page: 1,
      limit: 15,
      totalPages: 1,
      applications: richApps,
    });

    render(<Applications />);

    await waitFor(() => {
      expect(screen.getByTestId('match-summary-bar')).toBeDefined();
    });

    // Verify summary chips show accurate counts
    expect(screen.getByTestId('filter-chip-all').textContent).toContain('All (3)');
    expect(screen.getByTestId('filter-chip-matched').textContent).toContain('Supported (1)');
    expect(screen.getByTestId('filter-chip-ambiguous').textContent).toContain('Needs review (1)');
    expect(screen.getByTestId('filter-chip-unsupported').textContent).toContain('Not supported (1)');

    // Verify badges include both icon and text
    const ambiguousBadge = screen.getByTestId('match-badge-ambiguous');
    expect(ambiguousBadge.textContent).toContain('Needs review');

    // Open keyboard-reachable popover on ambiguous badge
    fireEvent.click(ambiguousBadge);
    await waitFor(() => {
      expect(screen.getByTestId('match-reason-popover')).toBeDefined();
    });
    expect(screen.getByTestId('match-reason-popover').textContent).toContain('MULTIPLE_CANDIDATES');
    expect(screen.getByTestId('match-reason-popover').textContent).toContain('Multiple distinct package manifests');

    // Escape closes popover
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('match-reason-popover')).toBeNull();
    });

    // Clicking "Needs review" chip filters table to ambiguous app only
    fireEvent.click(screen.getByTestId('filter-chip-ambiguous'));
    await waitFor(() => {
      expect(screen.getByText('Java SE Development Kit')).toBeDefined();
      expect(screen.queryByText('Custom Internal Tool')).toBeNull();
    });

    // Clicking row opens Application Details with match metadata and read-only candidates list
    fireEvent.click(screen.getByTestId('app-row-Java SE Development Kit'));
    await waitFor(() => {
      expect(screen.getByTestId('app-match-details')).toBeDefined();
    });
    expect(screen.getByTestId('detail-match-method').textContent).toBe('none');
    expect(screen.getByTestId('detail-match-reason').textContent).toContain('MULTIPLE_CANDIDATES');
    expect(screen.getByTestId('ambiguous-candidates-list')).toBeDefined();
    expect(screen.getByTestId('ambiguous-candidates-list').textContent).toContain('Oracle.JDK.23');
    expect(screen.getByTestId('ambiguous-candidates-list').textContent).toContain('Oracle.JDK.25');
  });
});
