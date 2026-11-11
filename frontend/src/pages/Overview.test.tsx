import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Overview } from './Overview';
import * as overviewApi from '../api/overview';
import * as appsApi from '../api/applications';

describe('Dashboard Overview Screen', () => {
  const mockMetrics: overviewApi.OverviewMetrics = {
    totalApps: 196,
    managedApps: 112,
    unsupportedApps: 84,
    pendingUpdatesCount: 33,
    lastScanStatus: 'COMPLETED',
    lastScanAt: '2026-11-11T12:00:00Z',
    agentStatus: 'ONLINE',
    agentHostname: 'DESKTOP-DINUSHA',
    recentActivity: [
      {
        id: 'act-1',
        eventType: 'UPDATE',
        title: 'Update Installed: Git for Windows',
        description: 'Upgraded to v2.45.0 (Exit Code: 0)',
        timestamp: '10m ago',
      },
      {
        id: 'act-2',
        eventType: 'SCAN',
        title: 'Inventory Scan Completed',
        description: 'Discovered 196 packages',
        timestamp: '25m ago',
      },
    ],
    quickPendingUpdates: [
      {
        id: 'upd-1',
        name: 'Git for Windows',
        packageId: 'Git.Git',
        currentVersion: '2.44.0',
        targetVersion: '2.45.0',
        status: 'PENDING_APPROVAL',
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(overviewApi, 'fetchOverviewMetrics').mockResolvedValue(mockMetrics);
    vi.spyOn(appsApi, 'triggerScan').mockResolvedValue({ success: true, scanId: 'scan-1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderOverview = () => {
    return render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    );
  };

  it('renders all 5 metric cards with telemetry numbers', async () => {
    renderOverview();

    await waitFor(() => {
      expect(screen.getByTestId('metric-total-apps')).toBeDefined();
    });

    expect(screen.getByText('196')).toBeDefined();
    expect(screen.getByText('33')).toBeDefined();
    expect(screen.getByText('84')).toBeDefined();
    expect(screen.getByText('DESKTOP-DINUSHA')).toBeDefined();
    expect(screen.getByText('Status: COMPLETED')).toBeDefined();
  });

  it('renders action-required pending updates table and recent activity stream', async () => {
    renderOverview();

    await waitFor(() => {
      expect(screen.getByText(/action required: pending updates/i)).toBeDefined();
    });

    expect(screen.getByText('Git for Windows')).toBeDefined();
    expect(screen.getByText('Update Installed: Git for Windows')).toBeDefined();
    expect(screen.getByText('Inventory Scan Completed')).toBeDefined();
  });

  it('triggers scan on "Scan now" button click and updates banner', async () => {
    renderOverview();

    await waitFor(() => {
      expect(screen.getByTestId('metric-total-apps')).toBeDefined();
    });

    const scanBtn = screen.getByRole('button', { name: /scan now for updates/i });
    fireEvent.click(scanBtn);

    await waitFor(() => {
      expect(appsApi.triggerScan).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByRole('status').textContent).toMatch(/scan initiated successfully/i);
  });

  it('renders error state on API failure with Retry button', async () => {
    vi.spyOn(overviewApi, 'fetchOverviewMetrics').mockRejectedValue(new Error('Connection failure'));

    renderOverview();

    await waitFor(() => {
      expect(screen.getByTestId('overview-error')).toBeDefined();
    });

    expect(screen.getByText('Connection failure')).toBeDefined();
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toBeDefined();
  });
});
