import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Device, PairingCodeResponse } from '../api/devices';
import { generatePairingCode, fetchDevicesList, revokeDevice } from '../api/devices';
import './Settings.css';

export function getDeviceStatus(device: Device): 'Online' | 'Offline' | 'Never connected' | 'Revoked' {
  const rawStatus = (device.connectionStatus || device.status || '').toUpperCase();
  if (rawStatus === 'REVOKED') return 'Revoked';
  if (!device.lastSeenAt || rawStatus === 'NEVER CONNECTED' || rawStatus === 'NEVER_CONNECTED') {
    return 'Never connected';
  }
  if (rawStatus === 'ONLINE') return 'Online';
  if (rawStatus === 'OFFLINE') return 'Offline';

  if (device.connectionStatus === 'Online' || device.connectionStatus === 'Offline' ||
      device.connectionStatus === 'Never connected' || device.connectionStatus === 'Revoked') {
    return device.connectionStatus;
  }
  return 'Offline';
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function formatLastSeen(lastSeenAt: string | null | undefined): string {
  if (!lastSeenAt) return 'Never';
  try {
    const date = new Date(lastSeenAt);
    if (isNaN(date.getTime())) return lastSeenAt;
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return lastSeenAt;
  }
}

export const Settings: React.FC = () => {
  // Pairing State (strictly stored in component state only, never in localStorage/sessionStorage/cookies)
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(0);
  const [isGeneratingCode, setIsGeneratingCode] = useState<boolean>(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  // Devices State
  const [devices, setDevices] = useState<Device[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState<boolean>(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Revoke Modal State
  const [deviceToRevoke, setDeviceToRevoke] = useState<Device | null>(null);
  const [isRevoking, setIsRevoking] = useState<boolean>(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // 1. Pairing Code Generation
  const handleGenerateCode = async () => {
    setIsGeneratingCode(true);
    setPairingError(null);
    setCopied(false);
    try {
      const res: PairingCodeResponse = await generatePairingCode();
      const code = res.code || res.pairing_token || res.token || '';
      const expSeconds = res.expires_in_seconds || 900;
      const expTime = res.expires_at ? new Date(res.expires_at).getTime() : Date.now() + expSeconds * 1000;

      setPairingCode(code);
      setExpiresAt(expTime);
      setSecondsRemaining(Math.max(0, Math.floor((expTime - Date.now()) / 1000)));
    } catch (err: unknown) {
      setPairingError(getErrorMessage(err, 'Failed to generate pairing code. Please try again.'));
    } finally {
      setIsGeneratingCode(false);
    }
  };

  // 2. Countdown Timer
  useEffect(() => {
    if (!expiresAt) return;

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setSecondsRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  const formatCountdown = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const handleCopyCode = async () => {
    if (!pairingCode) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(pairingCode);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // 3. Devices Fetching & 15s Polling (pauses when tab is hidden)
  const loadDevices = useCallback(async (isInitial = false) => {
    if (isInitial) setIsLoadingDevices(true);
    setDevicesError(null);
    try {
      const list = await fetchDevicesList();
      setDevices(list || []);
    } catch (err: unknown) {
      if (isInitial) {
        setDevicesError(getErrorMessage(err, 'Failed to load paired devices.'));
      }
    } finally {
      if (isInitial) setIsLoadingDevices(false);
    }
  }, []);

  useEffect(() => {
    let timerId: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (timerId) clearInterval(timerId);
      timerId = setInterval(() => {
        if (!document.hidden) {
          loadDevices(false);
        }
      }, 15000);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (timerId) {
          clearInterval(timerId);
          timerId = null;
        }
      } else {
        loadDevices(false);
        startPolling();
      }
    };

    loadDevices(true);
    startPolling();

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      if (timerId) clearInterval(timerId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadDevices]);

  // 4. Revocation Flow
  const openRevokeModal = (device: Device) => {
    setDeviceToRevoke(device);
    setRevokeError(null);
  };

  const closeRevokeModal = () => {
    if (isRevoking) return;
    setDeviceToRevoke(null);
    setRevokeError(null);
  };

  const handleConfirmRevoke = async () => {
    if (!deviceToRevoke) return;
    setIsRevoking(true);
    setRevokeError(null);
    try {
      await revokeDevice(deviceToRevoke.id);
      // Update device status in state
      setDevices(prev =>
        prev.map(d => (d.id === deviceToRevoke.id ? { ...d, status: 'REVOKED', connectionStatus: 'Revoked' } : d))
      );
      setActionMessage({
        type: 'success',
        text: `Device "${deviceToRevoke.name || deviceToRevoke.hostname}" pairing was successfully revoked.`,
      });
      setDeviceToRevoke(null);
    } catch (err: unknown) {
      setRevokeError(getErrorMessage(err, 'Failed to revoke device pairing. Please try again.'));
    } finally {
      setIsRevoking(false);
    }
  };

  // Keyboard navigation for accessible modal
  useEffect(() => {
    if (!deviceToRevoke) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRevokeModal();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    cancelBtnRef.current?.focus();
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deviceToRevoke]);

  const isExpired = expiresAt !== null && secondsRemaining <= 0;

  return (
    <div className="settings-page" data-testid="settings-page">
      <header className="settings-header">
        <h1>Agent Configuration & Device Settings</h1>
        <p>Manage host pairing credentials, live agent telemetry, and connected devices</p>
      </header>

      {actionMessage && (
        <div
          role="status"
          className={`settings-alert ${actionMessage.type}`}
          aria-live="polite"
        >
          <span>{actionMessage.text}</span>
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setActionMessage(null)}
            aria-label="Dismiss message"
          >
            ×
          </button>
        </div>
      )}

      {/* SECTION 1: Pair a new device */}
      <section className="settings-section-card" aria-labelledby="pair-device-heading">
        <div className="section-card-header">
          <div className="section-title-group">
            <h2 id="pair-device-heading">Pair a new device</h2>
            <p>One-time cryptographic token to onboard a Windows host</p>
          </div>
          {!pairingCode && (
            <button
              type="button"
              className="btn-primary"
              onClick={handleGenerateCode}
              disabled={isGeneratingCode}
              aria-label="Generate pairing code"
            >
              {isGeneratingCode ? (
                <>
                  <span className="spinner-sm" aria-hidden="true" />
                  Generating...
                </>
              ) : (
                'Generate code'
              )}
            </button>
          )}
        </div>

        {pairingError && (
          <div role="alert" className="settings-alert error">
            {pairingError}
          </div>
        )}

        {pairingCode && (
          <div className="pairing-container">
            <div className="pairing-active-box">
              <div className="pairing-meta-bar">
                <span className="pairing-label">Active Pairing Code:</span>
                <span
                  className={`countdown-badge ${isExpired ? 'expired' : ''}`}
                  data-testid="countdown-badge"
                  aria-live="polite"
                >
                  {isExpired ? 'Code expired' : `Expires in ${formatCountdown(secondsRemaining)}`}
                </span>
              </div>

              <div className="pairing-code-row">
                <div
                  className="pairing-code-display"
                  data-testid="pairing-code"
                  aria-label={`Pairing code: ${pairingCode}`}
                >
                  {pairingCode}
                </div>
                <button
                  type="button"
                  className={`copy-code-btn ${copied ? 'copied' : ''}`}
                  onClick={handleCopyCode}
                  aria-label="Copy pairing code"
                >
                  {copied ? 'Copied!' : 'Copy code'}
                </button>
              </div>

              <div className="pairing-command-hint">
                <span>PowerShell / CMD Invocation Command:</span>
                <code>python -m agent pair --code {pairingCode}</code>
              </div>
            </div>

            {isExpired && (
              <div className="expired-action-box" data-testid="expired-box" role="alert">
                <p>This pairing code has expired and can no longer be used.</p>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleGenerateCode}
                  disabled={isGeneratingCode}
                  aria-label="Regenerate pairing code"
                >
                  {isGeneratingCode ? 'Regenerating...' : 'Regenerate code'}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* SECTION 2: Devices list */}
      <section className="settings-section-card" aria-labelledby="devices-heading">
        <div className="section-card-header">
          <div className="section-title-group">
            <h2 id="devices-heading">Devices</h2>
            <p>Monitored Windows PCs and workstations running the UpdatePilot agent</p>
          </div>
        </div>

        {/* Loading State */}
        {isLoadingDevices && (
          <div className="state-box" data-testid="devices-loading" role="status" aria-live="polite">
            <span className="spinner-sm" aria-hidden="true" />
            <p>Loading devices...</p>
          </div>
        )}

        {/* Error State */}
        {!isLoadingDevices && devicesError && (
          <div className="state-box error-state" data-testid="devices-error" role="alert">
            <h3>Unable to load devices</h3>
            <p>{devicesError}</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => loadDevices(true)}
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty State */}
        {!isLoadingDevices && !devicesError && devices.length === 0 && (
          <div className="state-box" data-testid="devices-empty">
            <h3>No devices paired yet</h3>
            <p>Generate a pairing code above and run the UpdatePilot agent on your Windows machine to get started.</p>
          </div>
        )}

        {/* Devices Table */}
        {!isLoadingDevices && !devicesError && devices.length > 0 && (
          <div className="devices-table-wrapper">
            <table className="devices-table" aria-label="Paired devices list">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Hostname</th>
                  <th scope="col">OS</th>
                  <th scope="col">Agent Version</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last Seen</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map(device => {
                  const status = getDeviceStatus(device);
                  const isRevoked = status === 'Revoked';
                  const badgeClass = status.toLowerCase().replace(/\s+/g, '-');

                  return (
                    <tr key={device.id} data-testid={`device-row-${device.id}`}>
                      <td className="device-name-cell">{device.name || device.hostname || 'Unknown Device'}</td>
                      <td className="device-hostname-cell">{device.hostname || '—'}</td>
                      <td>{device.os || '—'}</td>
                      <td>{device.agentVersion || '—'}</td>
                      <td>
                        <span
                          className={`status-badge ${badgeClass}`}
                          data-testid={`status-badge-${device.id}`}
                        >
                          {status}
                        </span>
                      </td>
                      <td>{formatLastSeen(device.lastSeenAt)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn-revoke"
                          onClick={() => openRevokeModal(device)}
                          disabled={isRevoked}
                          aria-label={`Revoke device ${device.name || device.hostname}`}
                        >
                          {isRevoked ? 'Revoked' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Accessible Revoke Confirmation Dialog */}
      {deviceToRevoke && (
        <div
          className="modal-overlay"
          onClick={closeRevokeModal}
          data-testid="revoke-dialog-overlay"
        >
          <div
            className="modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="revoke-dialog-title"
            aria-describedby="revoke-dialog-description"
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <div className="modal-title-group">
                <h3 id="revoke-dialog-title">Revoke Device Pairing</h3>
                <p id="revoke-dialog-description">
                  Permanent disconnection of Windows host {deviceToRevoke.name || deviceToRevoke.hostname}
                </p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={closeRevokeModal}
                disabled={isRevoking}
                aria-label="Close dialog"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              {revokeError && (
                <div role="alert" className="settings-alert error">
                  {revokeError}
                </div>
              )}

              <div className="warning-checklist-box">
                <h4>What will happen:</h4>
                <ol className="warning-checklist">
                  <li>All active authentication tokens on this machine will be permanently invalidated.</li>
                  <li>Any queued or in-progress updates will be stopped immediately.</li>
                  <li>The agent will enter an unpaired state and cannot reconnect until re-paired.</li>
                </ol>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                ref={cancelBtnRef}
                className="btn-secondary"
                onClick={closeRevokeModal}
                disabled={isRevoking}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={handleConfirmRevoke}
                disabled={isRevoking}
                aria-label="Confirm revoke device pairing"
              >
                {isRevoking ? 'Revoking...' : 'Revoke Device'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Settings;
