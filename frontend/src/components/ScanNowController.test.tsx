import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ScanNowController } from './ScanNowController';
import * as appsApi from '../api/applications';
import * as scansApi from '../api/scans';

describe('ScanNowController Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderComponent = (props: Partial<React.ComponentProps<typeof ScanNowController>> = {}) => {
    return render(
      <MemoryRouter>
        <ScanNowController
          isOnline={true}
          deviceId="dev-123"
          {...props}
        />
      </MemoryRouter>
    );
  };

  it('renders enabled "Scan now" button when agent is online', () => {
    renderComponent({ isOnline: true });

    const btn = screen.getByRole('button', { name: /scan now/i });
    expect(btn).toBeDefined();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('is disabled when agent is offline and shows why', () => {
    renderComponent({ isOnline: false });

    const btn = screen.getByRole('button', { name: /scan now/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);

    // Shows why it is disabled
    expect(screen.getByTestId('agent-offline-badge').textContent).toMatch(/agent offline/i);
    expect(screen.getByTestId('scan-disabled-reason').textContent).toMatch(/agent is offline/i);
  });

  it('shows queued state ("Waiting for the agent...") after clicking Scan now', async () => {
    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({
      success: true,
      scanId: 'job-101',
    });

    vi.spyOn(scansApi, 'fetchScanJob').mockResolvedValue({
      id: 'job-101',
      deviceId: 'dev-123',
      type: 'scan_inventory',
      status: 'queued',
      progressPercent: 0,
      progressStep: 'queued',
      appCount: 0,
      createdAt: new Date().toISOString(),
    });

    renderComponent();

    const btn = screen.getByRole('button', { name: /scan now/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByTestId('scan-queued-state')).toBeDefined();
    });

    expect(screen.getByTestId('scan-queued-state').textContent).toMatch(/waiting for the agent/i);
    // Button is disabled while active
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows running state with progress bar, percent and step text', async () => {
    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({
      success: true,
      scanId: 'job-102',
    });

    vi.spyOn(scansApi, 'fetchScanJob').mockResolvedValue({
      id: 'job-102',
      deviceId: 'dev-123',
      type: 'scan_inventory',
      status: 'running',
      progressPercent: 60,
      progressStep: 'Reading Windows registry...',
      appCount: 0,
      createdAt: new Date().toISOString(),
    });

    renderComponent();

    const btn = screen.getByRole('button', { name: /scan now/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByTestId('scan-running-state')).toBeDefined();
    });

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('60');
    expect(screen.getByTestId('scan-progress-step').textContent).toBe('Reading Windows registry...');
    expect(screen.getByText('60%')).toBeDefined();
  });

  it('shows succeeded state ("Found N applications" with link to Applications) and invokes onScanSuccess', async () => {
    const onScanSuccess = vi.fn();

    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({
      success: true,
      scanId: 'job-103',
    });

    vi.spyOn(scansApi, 'fetchScanJob').mockResolvedValue({
      id: 'job-103',
      deviceId: 'dev-123',
      type: 'scan_inventory',
      status: 'succeeded',
      progressPercent: 100,
      progressStep: 'completed',
      appCount: 42,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });

    renderComponent({ onScanSuccess });

    const btn = screen.getByRole('button', { name: /scan now/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByTestId('scan-succeeded-state')).toBeDefined();
    });

    expect(screen.getByTestId('scan-succeeded-state').textContent).toMatch(/found 42 applications/i);

    // Link to Applications
    const link = screen.getByRole('link', { name: /view in applications/i });
    expect(link.getAttribute('href')).toBe('/applications');

    // onScanSuccess callback fired
    expect(onScanSuccess).toHaveBeenCalledTimes(1);
  });

  it('shows failed state with safe error message and a "Try again" button', async () => {
    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({
      success: true,
      scanId: 'job-104',
    });

    vi.spyOn(scansApi, 'fetchScanJob').mockResolvedValue({
      id: 'job-104',
      deviceId: 'dev-123',
      type: 'scan_inventory',
      status: 'failed',
      progressPercent: 30,
      progressStep: 'error',
      appCount: 0,
      errorMessage: 'WinGet CLI crashed unexpectedly (code 0x8A150011)',
      createdAt: new Date().toISOString(),
    });

    renderComponent();

    const btn = screen.getByRole('button', { name: /scan now/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByTestId('scan-failed-state')).toBeDefined();
    });

    expect(screen.getByTestId('scan-failed-state').textContent).toMatch(
      /winget cli crashed unexpectedly/i
    );

    const retryBtn = screen.getByRole('button', { name: /try scan again/i });
    expect(retryBtn).toBeDefined();

    // Clicking try again re-triggers scan
    fireEvent.click(retryBtn);
    await waitFor(() => {
      expect(appsApi.triggerScan).toHaveBeenCalledTimes(2);
    });
  });

  it('handles 409 conflict by following existing active job instead of erroring', async () => {
    // 409 Conflict returns existing active job ID
    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({
      success: true,
      scanId: 'job-existing-active-999',
      isExisting: true,
    });

    vi.spyOn(scansApi, 'fetchScanJob').mockResolvedValue({
      id: 'job-existing-active-999',
      deviceId: 'dev-123',
      type: 'scan_inventory',
      status: 'running',
      progressPercent: 45,
      progressStep: 'Inspecting installed packages...',
      appCount: 0,
      createdAt: new Date().toISOString(),
    });

    renderComponent();

    const btn = screen.getByRole('button', { name: /scan now/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(appsApi.triggerScan).toHaveBeenCalledTimes(1);
    });

    // Seamlessly transitions into polling the active job
    await waitFor(() => {
      expect(scansApi.fetchScanJob).toHaveBeenCalledWith('dev-123', 'job-existing-active-999');
    });

    expect(screen.getByTestId('scan-running-state')).toBeDefined();
    expect(screen.getByTestId('scan-progress-step').textContent).toBe(
      'Inspecting installed packages...'
    );
  });

  it('pauses polling when tab is hidden and resumes when visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({
      success: true,
      scanId: 'job-vis-1',
    });

    const mockFetch = vi.spyOn(scansApi, 'fetchScanJob').mockResolvedValue({
      id: 'job-vis-1',
      deviceId: 'dev-123',
      type: 'scan_inventory',
      status: 'running',
      progressPercent: 50,
      progressStep: 'Scanning...',
      appCount: 0,
      createdAt: new Date().toISOString(),
    });

    renderComponent();

    const btn = screen.getByRole('button', { name: /scan now/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Mock document.visibilityState = 'hidden'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    // Advance 2s
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    // When hidden, poll was skipped
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Restore visibility
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {
      await Promise.resolve();
    });

    // Resumed
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('renders step list with done, active, pending, skipped icons and aria-valuenow', async () => {
    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({
      success: true,
      scanId: 'job-steps-1',
    });

    vi.spyOn(scansApi, 'fetchScanJob').mockResolvedValue({
      id: 'job-steps-1',
      deviceId: 'dev-123',
      type: 'scan_inventory',
      status: 'running',
      progressPercent: 78,
      progressStep: 'normalising_and_merging',
      progressMessage: 'Found 87 apps',
      skippedSteps: ['enriching_publishers'],
      appCount: 0,
      createdAt: new Date().toISOString(),
    });

    renderComponent();
    fireEvent.click(screen.getByRole('button', { name: /scan now/i }));

    await waitFor(() => {
      expect(screen.getByTestId('scan-steps-list')).toBeDefined();
    });

    const progressBar = screen.getByRole('progressbar');
    expect(progressBar.getAttribute('aria-valuenow')).toBe('78');
    expect(screen.getByTestId('scan-progress-step').textContent).toContain('Found 87 apps');

    expect(screen.getByTestId('scan-step-checking_winget').getAttribute('data-step-status')).toBe('done');
    expect(screen.getByTestId('scan-step-listing_winget').getAttribute('data-step-status')).toBe('done');
    expect(screen.getByTestId('scan-step-reading_registry').getAttribute('data-step-status')).toBe('done');
    expect(screen.getByTestId('scan-step-enriching_publishers').getAttribute('data-step-status')).toBe('skipped');
    expect(screen.getByTestId('scan-step-normalising_and_merging').getAttribute('data-step-status')).toBe('active');
    expect(screen.getByTestId('scan-step-submitting_results').getAttribute('data-step-status')).toBe('pending');
    expect(screen.getByTestId('scan-step-matching_packages').getAttribute('data-step-status')).toBe('pending');
  });

  it('displays final match breakdown summary on completion', async () => {
    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({
      success: true,
      scanId: 'job-summary-1',
    });

    vi.spyOn(scansApi, 'fetchScanJob').mockResolvedValue({
      id: 'job-summary-1',
      deviceId: 'dev-123',
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

    renderComponent();
    fireEvent.click(screen.getByRole('button', { name: /scan now/i }));

    await waitFor(() => {
      expect(screen.getByTestId('scan-match-summary')).toBeDefined();
    });

    expect(screen.getByTestId('scan-match-summary').textContent).toContain(
      '120 apps: 95 matched, 4 ambiguous, 21 unsupported'
    );
  });
});
