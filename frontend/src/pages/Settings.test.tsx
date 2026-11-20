import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Settings } from './Settings';
import * as devicesApi from '../api/devices';

describe('Settings & Agent Configuration Screen', () => {
  const mockDevices: devicesApi.Device[] = [
    {
      id: 'dev-1',
      name: 'DESKTOP-DINUSHA',
      hostname: 'DESKTOP-DINUSHA',
      os: 'Windows 11 Home (Build 26200)',
      agentVersion: '1.0.0',
      status: 'ONLINE',
      connectionStatus: 'Online',
      lastSeenAt: '2026-11-11T12:00:00Z',
      pairedAt: '2026-10-30T10:00:00Z',
    },
    {
      id: 'dev-2',
      name: 'OFFICE-PC',
      hostname: 'OFFICE-PC',
      os: 'Windows 10 Pro',
      agentVersion: '1.0.0',
      status: 'OFFLINE',
      connectionStatus: 'Offline',
      lastSeenAt: '2026-11-10T08:00:00Z',
      pairedAt: '2026-10-25T10:00:00Z',
    },
    {
      id: 'dev-3',
      name: 'NEW-MACHINE',
      hostname: 'NEW-MACHINE',
      os: 'Windows 11 Pro',
      agentVersion: '1.0.0',
      status: 'NEVER_CONNECTED',
      connectionStatus: 'Never connected',
      lastSeenAt: null,
      pairedAt: '2026-11-11T11:00:00Z',
    },
    {
      id: 'dev-4',
      name: 'REVOKED-LAPTOP',
      hostname: 'REVOKED-LAPTOP',
      os: 'Windows 11 Home',
      agentVersion: '0.9.0',
      status: 'REVOKED',
      connectionStatus: 'Revoked',
      lastSeenAt: '2026-10-20T10:00:00Z',
      pairedAt: '2026-10-15T10:00:00Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(devicesApi, 'fetchDevicesList').mockResolvedValue(mockDevices);
    vi.spyOn(devicesApi, 'generatePairingCode').mockResolvedValue({
      pairing_token: 'tok_test12345678',
      expires_in_seconds: 900,
    });
    vi.spyOn(devicesApi, 'revokeDevice').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- 1. Pairing Code Generation & Copy Tests ---

  it('renders "Pair a new device" section with Generate code button', async () => {
    render(<Settings />);

    expect(screen.getByRole('heading', { name: /pair a new device/i })).toBeDefined();
    const generateBtn = screen.getByRole('button', { name: /generate pairing code/i });
    expect(generateBtn).toBeDefined();

    await waitFor(() => {
      expect(screen.getByTestId('device-row-dev-1')).toBeDefined();
    });
  });

  it('generates and displays pairing code with live countdown', async () => {
    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByTestId('device-row-dev-1')).toBeDefined();
    });

    const generateBtn = screen.getByRole('button', { name: /generate pairing code/i });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(devicesApi.generatePairingCode).toHaveBeenCalledTimes(1);
    });

    // Displays code in large readable format
    const codeDisplay = await screen.findByTestId('pairing-code');
    expect(codeDisplay.textContent).toContain('tok_test12345678');

    // Displays countdown badge
    const countdownBadge = screen.getByTestId('countdown-badge');
    expect(countdownBadge.textContent).toMatch(/expires in/i);
  });

  it('copies pairing code to clipboard and shows "Copied!" feedback', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByTestId('device-row-dev-1')).toBeDefined();
    });

    const generateBtn = screen.getByRole('button', { name: /generate pairing code/i });
    fireEvent.click(generateBtn);

    const copyBtn = await screen.findByRole('button', { name: /copy pairing code/i });
    expect(copyBtn.textContent).toContain('Copy code');

    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('tok_test12345678');
      expect(copyBtn.textContent).toContain('Copied!');
    });
  });

  // --- 2. Countdown Expiry Tests ---

  it('shows expired state and regenerate button when countdown expires', async () => {
    vi.useFakeTimers();

    // Mock code expiring in 5 seconds
    vi.spyOn(devicesApi, 'generatePairingCode').mockResolvedValue({
      pairing_token: 'tok_short_lived',
      expires_in_seconds: 5,
    });

    render(<Settings />);

    const generateBtn = screen.getByRole('button', { name: /generate pairing code/i });
    await act(async () => {
      fireEvent.click(generateBtn);
    });

    expect(screen.getByTestId('pairing-code').textContent).toContain('tok_short_lived');
    expect(screen.getByTestId('countdown-badge').textContent).toMatch(/expires in/i);

    // Fast forward 6 seconds
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });

    // Verify expired badge and regenerate button
    expect(screen.getByTestId('countdown-badge').textContent).toContain('Code expired');
    const regenBtn = screen.getByRole('button', { name: /regenerate pairing code/i });
    expect(regenBtn).toBeDefined();

    // Clicking regenerate calls API again
    await act(async () => {
      fireEvent.click(regenBtn);
    });

    expect(devicesApi.generatePairingCode).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  // --- 3. Status Badges Tests ---

  it('displays devices list with all four status badges: Online, Offline, Never connected, Revoked', async () => {
    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByTestId('device-row-dev-1')).toBeDefined();
    });

    // Check Online
    const onlineBadge = screen.getByTestId('status-badge-dev-1');
    expect(onlineBadge.textContent).toContain('Online');
    expect(onlineBadge.className).toContain('online');

    // Check Offline
    const offlineBadge = screen.getByTestId('status-badge-dev-2');
    expect(offlineBadge.textContent).toContain('Offline');
    expect(offlineBadge.className).toContain('offline');

    // Check Never connected
    const neverBadge = screen.getByTestId('status-badge-dev-3');
    expect(neverBadge.textContent).toContain('Never connected');
    expect(neverBadge.className).toContain('never-connected');

    // Check Revoked
    const revokedBadge = screen.getByTestId('status-badge-dev-4');
    expect(revokedBadge.textContent).toContain('Revoked');
    expect(revokedBadge.className).toContain('revoked');

    // Revoked row's action button is disabled and indicates Revoked
    const revokedBtn = screen.getByRole('button', { name: /revoke device revoked-laptop/i });
    expect(revokedBtn.hasAttribute('disabled')).toBe(true);
    expect(revokedBtn.textContent).toContain('Revoked');
  });

  // --- 4. Revocation Flow Tests ---

  it('opens accessible confirmation dialog on Revoke click', async () => {
    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByTestId('device-row-dev-1')).toBeDefined();
    });

    const revokeBtn = screen.getByRole('button', { name: /revoke device desktop-dinusha/i });
    fireEvent.click(revokeBtn);

    // Modal dialog is present with accessible attributes
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText(/revoke device pairing/i)).toBeDefined();
    expect(screen.getByText(/permanent disconnection of windows host/i)).toBeDefined();
    expect(screen.getByText(/all active authentication tokens on this machine will be permanently invalidated/i)).toBeDefined();
  });

  it('closes dialog on Cancel or Escape key', async () => {
    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByTestId('device-row-dev-1')).toBeDefined();
    });

    const revokeBtn = screen.getByRole('button', { name: /revoke device desktop-dinusha/i });
    fireEvent.click(revokeBtn);

    expect(screen.getByRole('dialog')).toBeDefined();

    // Cancel closes dialog
    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelBtn);
    expect(screen.queryByRole('dialog')).toBeNull();

    // Reopen and test Escape key
    fireEvent.click(revokeBtn);
    expect(screen.getByRole('dialog')).toBeDefined();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('executes revocation, updates device status to Revoked, and shows success message', async () => {
    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByTestId('device-row-dev-1')).toBeDefined();
    });

    const revokeBtn = screen.getByRole('button', { name: /revoke device desktop-dinusha/i });
    fireEvent.click(revokeBtn);

    const confirmBtn = screen.getByRole('button', { name: /confirm revoke device pairing/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(devicesApi.revokeDevice).toHaveBeenCalledWith('dev-1');
    });

    // Dialog closed
    expect(screen.queryByRole('dialog')).toBeNull();

    // Device status updated to Revoked
    const badge = screen.getByTestId('status-badge-dev-1');
    expect(badge.textContent).toContain('Revoked');
    expect(badge.className).toContain('revoked');

    // Success alert message shown
    expect(screen.getByRole('status').textContent).toMatch(/pairing was successfully revoked/i);
  });

  it('shows error message inside dialog if revocation fails', async () => {
    vi.spyOn(devicesApi, 'revokeDevice').mockRejectedValue(new Error('Network error revoking device'));

    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByTestId('device-row-dev-1')).toBeDefined();
    });

    const revokeBtn = screen.getByRole('button', { name: /revoke device desktop-dinusha/i });
    fireEvent.click(revokeBtn);

    const confirmBtn = screen.getByRole('button', { name: /confirm revoke device pairing/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Network error revoking device');
    });

    // Modal stays open so user can retry or cancel
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  // --- 5. Empty and Error States Tests ---

  it('shows empty state when no devices are paired', async () => {
    vi.spyOn(devicesApi, 'fetchDevicesList').mockResolvedValue([]);

    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByTestId('devices-empty')).toBeDefined();
    });

    expect(screen.getByText(/no devices paired yet/i)).toBeDefined();
  });

  it('shows error state when fetching devices fails, with Retry button', async () => {
    vi.spyOn(devicesApi, 'fetchDevicesList').mockRejectedValue(new Error('Internal Server Error'));

    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByTestId('devices-error')).toBeDefined();
    });

    expect(screen.getByText(/unable to load devices/i)).toBeDefined();
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toBeDefined();

    // Clicking retry refetches
    vi.spyOn(devicesApi, 'fetchDevicesList').mockResolvedValue(mockDevices);
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByTestId('device-row-dev-1')).toBeDefined();
    });
  });

  // --- 6. Polling & Visibility Tests ---

  it('polls devices endpoint every 15 seconds and pauses when tab is hidden', async () => {
    vi.useFakeTimers();

    render(<Settings />);

    expect(devicesApi.fetchDevicesList).toHaveBeenCalledTimes(1);

    // Advance 15 seconds -> polling triggers
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    expect(devicesApi.fetchDevicesList).toHaveBeenCalledTimes(2);

    // Simulate tab hidden
    Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
    fireEvent(document, new Event('visibilitychange'));

    // Advance 30 seconds while hidden -> no fetches occur
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(devicesApi.fetchDevicesList).toHaveBeenCalledTimes(2);

    // Simulate tab visible again -> immediate fetch and resume polling
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
    fireEvent(document, new Event('visibilitychange'));

    expect(devicesApi.fetchDevicesList).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });
});
