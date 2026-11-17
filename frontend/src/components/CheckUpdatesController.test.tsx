import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CheckUpdatesController } from './CheckUpdatesController';
import * as updatesApi from '../api/updates';

describe('CheckUpdatesController Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders enabled "Check for updates" button when device is online', () => {
    render(<CheckUpdatesController isOnline={true} />);

    const btn = screen.getByRole('button', { name: /check for updates/i });
    expect(btn).toBeDefined();
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.textContent).toContain('Check for updates');
  });

  it('disables button when device is offline', () => {
    render(<CheckUpdatesController isOnline={false} />);

    const btn = screen.getByRole('button', { name: /check for updates/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('triggers update check, shows progress bar with percent, and completes with summary', async () => {
    const onCheckSuccess = vi.fn();
    vi.spyOn(updatesApi, 'triggerUpdateCheck').mockResolvedValue({
      jobId: 'upd-job-123',
      status: 'queued',
    });

    let pollCount = 0;
    vi.spyOn(updatesApi, 'fetchUpdateCheckJob').mockImplementation(async () => {
      pollCount++;
      if (pollCount === 1) {
        return {
          id: 'upd-job-123',
          deviceId: 'dev-1',
          type: 'check_updates',
          status: 'running',
          progressPercent: 50,
          progressStep: 'Querying WinGet upgrade table...',
          progressMessage: 'Parsed 12 updates so far',
          appCount: 0,
          createdAt: new Date().toISOString(),
        };
      }
      return {
        id: 'upd-job-123',
        deviceId: 'dev-1',
        type: 'check_updates',
        status: 'succeeded',
        progressPercent: 100,
        progressStep: 'Completed',
        progressMessage: '87 matched apps checked: 4 updates available, 0 unknown',
        appCount: 4,
        createdAt: new Date().toISOString(),
      };
    });

    render(<CheckUpdatesController isOnline={true} onCheckSuccess={onCheckSuccess} />);

    const btn = screen.getByRole('button', { name: /check for updates/i });
    fireEvent.click(btn);

    // Shows progress banner
    await waitFor(() => {
      expect(screen.getByTestId('check-progress-banner')).toBeDefined();
    }, { timeout: 3000 });

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toBeDefined();

    // Succeeded state
    await waitFor(() => {
      expect(screen.getByTestId('check-summary-alert')).toBeDefined();
    }, { timeout: 3000 });

    expect(screen.getByText(/87 matched apps checked: 4 updates available/i)).toBeDefined();
    expect(onCheckSuccess).toHaveBeenCalledTimes(1);
  });

  it('displays error alert when update check fails', async () => {
    vi.spyOn(updatesApi, 'triggerUpdateCheck').mockResolvedValue({
      jobId: 'upd-job-err',
      status: 'queued',
    });

    vi.spyOn(updatesApi, 'fetchUpdateCheckJob').mockResolvedValue({
      id: 'upd-job-err',
      deviceId: 'dev-1',
      type: 'check_updates',
      status: 'failed',
      progressPercent: 20,
      progressStep: 'Failed',
      errorMessage: 'WinGet process timed out after 30 seconds.',
      appCount: 0,
      createdAt: new Date().toISOString(),
    });

    render(<CheckUpdatesController isOnline={true} />);

    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }));

    await waitFor(() => {
      expect(screen.getByTestId('check-error-alert')).toBeDefined();
    }, { timeout: 3000 });

    expect(screen.getByText('WinGet process timed out after 30 seconds.')).toBeDefined();

    // Dismiss alert
    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    expect(screen.queryByTestId('check-error-alert')).toBeNull();
  });
});
