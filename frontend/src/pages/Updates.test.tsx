import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Updates } from './Updates';
import * as updatesApi from '../api/updates';

describe('Software Updates & Approval Gate Screen', () => {
  const mockUpdates: updatesApi.UpdateItem[] = [
    {
      id: 'upd-1',
      name: 'Git for Windows',
      packageId: 'Git.Git',
      currentVersion: '2.44.0',
      targetVersion: '2.45.0',
      source: 'winget',
      status: 'PENDING_APPROVAL',
    },
    {
      id: 'upd-2',
      name: 'Visual Studio Code',
      packageId: 'Microsoft.VisualStudioCode',
      currentVersion: '1.88.1',
      targetVersion: '1.89.0',
      source: 'winget',
      status: 'PENDING_APPROVAL',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(updatesApi, 'fetchPendingUpdates').mockResolvedValue(mockUpdates);
    vi.spyOn(updatesApi, 'approveUpdate').mockImplementation(async (id: string) => {
      const match = mockUpdates.find(u => u.id === id);
      return match ? { ...match, status: 'APPROVED' } : mockUpdates[0];
    });
    vi.spyOn(updatesApi, 'rejectUpdate').mockImplementation(async (id: string) => {
      const match = mockUpdates.find(u => u.id === id);
      return match ? { ...match, status: 'REJECTED' } : mockUpdates[0];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders pending software updates and explicit approval banner', async () => {
    render(<Updates />);

    await waitFor(() => {
      expect(screen.getByTestId('update-row-Git.Git')).toBeDefined();
    });

    expect(screen.getByRole('heading', { name: /software updates/i })).toBeDefined();
    expect(screen.getByText(/explicit user approval gate/i)).toBeDefined();
    expect(screen.getByText(/2 updates awaiting explicit user approval/i)).toBeDefined();
  });

  it('opens confirmation modal on Approve click and handles cancel', async () => {
    render(<Updates />);

    await waitFor(() => {
      expect(screen.getByTestId('update-row-Git.Git')).toBeDefined();
    });

    const approveBtn = screen.getByRole('button', { name: /approve update for git for windows/i });
    fireEvent.click(approveBtn);

    // Modal dialog is present with accessible attributes
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: /approve software update/i })).toBeDefined();

    // Cancel closes dialog
    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelBtn);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms approval, calls API, updates status to APPROVED, and shows feedback', async () => {
    render(<Updates />);

    await waitFor(() => {
      expect(screen.getByTestId('update-row-Git.Git')).toBeDefined();
    });

    const approveBtn = screen.getByRole('button', { name: /approve update for git for windows/i });
    fireEvent.click(approveBtn);

    const confirmBtn = screen.getByRole('button', { name: /confirm approval/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(updatesApi.approveUpdate).toHaveBeenCalledWith('upd-1');
    });

    // Dialog closed
    expect(screen.queryByRole('dialog')).toBeNull();

    // Status changed to Approved
    expect(screen.getByText('Approved')).toBeDefined();
    expect(screen.getByRole('status').textContent).toMatch(/successfully approved/i);
  });

  it('rejects update on Reject click and marks status as REJECTED', async () => {
    render(<Updates />);

    await waitFor(() => {
      expect(screen.getByTestId('update-row-Git.Git')).toBeDefined();
    });

    const rejectBtn = screen.getByRole('button', { name: /reject update for git for windows/i });
    fireEvent.click(rejectBtn);

    await waitFor(() => {
      expect(updatesApi.rejectUpdate).toHaveBeenCalledWith('upd-1');
    });

    expect(screen.getByText('Rejected')).toBeDefined();
    expect(screen.getByRole('status').textContent).toMatch(/rejected/i);
  });

  it('renders empty state when no updates are pending', async () => {
    vi.spyOn(updatesApi, 'fetchPendingUpdates').mockResolvedValue([]);

    render(<Updates />);

    await waitFor(() => {
      expect(screen.getByTestId('updates-empty')).toBeDefined();
    });

    expect(screen.getByText(/all applications are up to date/i)).toBeDefined();
  });

  it('renders error state on API failure with Retry button', async () => {
    vi.spyOn(updatesApi, 'fetchPendingUpdates').mockRejectedValue(new Error('Network error querying updates'));

    render(<Updates />);

    await waitFor(() => {
      expect(screen.getByTestId('updates-error')).toBeDefined();
    });

    expect(screen.getByText('Network error querying updates')).toBeDefined();
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toBeDefined();
  });

  it('offers only matched apps for update and explains why ambiguous/unsupported apps are excluded', async () => {
    vi.spyOn(updatesApi, 'fetchPendingUpdates').mockResolvedValue([
      {
        id: 'upd-matched',
        packageId: 'Git.Git',
        name: 'Git',
        currentVersion: '2.50.0',
        targetVersion: '2.56.0',
        source: 'winget',
        status: 'PENDING_APPROVAL',
        matchStatus: 'matched',
      },
      {
        id: 'upd-ambiguous',
        packageId: 'Oracle.JDK',
        name: 'Java SE Development Kit',
        currentVersion: '23.0.0',
        targetVersion: '25.0.0',
        source: 'winget',
        status: 'PENDING_APPROVAL',
        matchStatus: 'ambiguous',
      },
      {
        id: 'upd-unsupported',
        packageId: 'MSIX\\Foo',
        name: 'Store App',
        currentVersion: '1.0.0',
        targetVersion: '2.0.0',
        source: 'msstore',
        status: 'PENDING_APPROVAL',
        matchStatus: 'unsupported',
      },
    ]);

    render(<Updates />);

    await waitFor(() => {
      expect(screen.getByTestId('updates-excluded-note')).toBeDefined();
    });

    // Matched app is offered
    expect(screen.getByText('Git')).toBeDefined();
    // Ambiguous and unsupported apps are NOT offered
    expect(screen.queryByText('Java SE Development Kit')).toBeNull();
    expect(screen.queryByText('Store App')).toBeNull();
    // Note explains why
    expect(screen.getByTestId('updates-excluded-note').textContent).toContain('2 applications excluded');
  });
});
