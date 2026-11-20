import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { History } from './History';
import * as historyApi from '../api/history';

describe('Job & Audit History Screen', () => {
  const mockHistory: historyApi.HistoryEvent[] = [
    {
      id: 'job_8f29ab01',
      eventType: 'UPDATE',
      title: 'Update: Git for Windows',
      description: 'Upgraded to v2.45.0',
      target: 'Git.Git',
      status: 'SUCCEEDED',
      operator: 'Dinusha',
      timestamp: '15m ago',
      exitCode: 0,
    },
    {
      id: 'job_8f29ab02',
      eventType: 'SCAN',
      title: 'Host Inventory Scan',
      description: 'Discovered 196 packages',
      target: 'DESKTOP-DINUSHA',
      status: 'SUCCEEDED',
      operator: 'System',
      timestamp: '1h ago',
      exitCode: 0,
    },
    {
      id: 'job_8f29ab03',
      eventType: 'REJECTION',
      title: 'Rejected Update: Discord',
      description: 'Rejected by operator',
      target: 'Discord.Discord',
      status: 'REJECTED',
      operator: 'Dinusha',
      timestamp: '2h ago',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(historyApi, 'fetchHistory').mockResolvedValue(mockHistory);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders audit history entries and ledger title', async () => {
    render(<History />);

    await waitFor(() => {
      expect(screen.getByTestId('history-row-job_8f29ab01')).toBeDefined();
    });

    expect(screen.getByRole('heading', { name: /job & audit history/i })).toBeDefined();
    expect(screen.getByText('Update: Git for Windows')).toBeDefined();
    expect(screen.getByText('Host Inventory Scan')).toBeDefined();
  });

  it('filters history events by live search query', async () => {
    render(<History />);

    await waitFor(() => {
      expect(screen.getByTestId('history-row-job_8f29ab01')).toBeDefined();
    });

    const searchInput = screen.getByRole('searchbox', { name: /search history records/i });
    fireEvent.change(searchInput, { target: { value: 'Discord' } });

    expect(screen.getByTestId('history-row-job_8f29ab03')).toBeDefined();
    expect(screen.queryByTestId('history-row-job_8f29ab01')).toBeNull();
  });

  it('triggers CSV download on "Export CSV" click', async () => {
    const createObjectURLMock = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURLMock = vi.fn();
    window.URL.createObjectURL = createObjectURLMock;
    window.URL.revokeObjectURL = revokeObjectURLMock;

    render(<History />);

    await waitFor(() => {
      expect(screen.getByTestId('history-row-job_8f29ab01')).toBeDefined();
    });

    const exportBtn = screen.getByRole('button', { name: /export history to csv/i });
    fireEvent.click(exportBtn);

    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
  });

  it('renders empty state when no audit records are found', async () => {
    vi.spyOn(historyApi, 'fetchHistory').mockResolvedValue([]);

    render(<History />);

    await waitFor(() => {
      expect(screen.getByTestId('history-empty')).toBeDefined();
    });

    expect(screen.getByText(/no audit records found/i)).toBeDefined();
  });

  it('renders error state on API failure with Retry button', async () => {
    vi.spyOn(historyApi, 'fetchHistory').mockRejectedValue(new Error('Database disconnected'));

    render(<History />);

    await waitFor(() => {
      expect(screen.getByTestId('history-error')).toBeDefined();
    });

    expect(screen.getByText('Database disconnected')).toBeDefined();
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toBeDefined();
  });
});
