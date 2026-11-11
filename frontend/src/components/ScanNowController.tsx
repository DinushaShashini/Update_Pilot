import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { triggerScan } from '../api/applications';
import { fetchScanJob } from '../api/scans';
import './ScanNowController.css';

export interface ScanNowControllerProps {
  deviceId?: string;
  isOnline: boolean;
  onScanSuccess?: () => void | Promise<void>;
  buttonAriaLabel?: string;
  buttonClassName?: string;
  className?: string;
}

export type ScanStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_TIME_MS = 600000; // 10 minutes max polling time

export const ScanNowController: React.FC<ScanNowControllerProps> = ({
  deviceId,
  isOnline,
  onScanSuccess,
  buttonAriaLabel = 'Scan now for updates',
  buttonClassName = 'btn-primary',
  className = '',
}) => {
  const [status, setStatus] = useState<ScanStatus>('idle');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [progressStep, setProgressStep] = useState<string>('');
  const [appCount, setAppCount] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartTimeRef = useRef<number>(0);
  const activeJobIdRef = useRef<string | null>(null);
  activeJobIdRef.current = activeJobId;

  const isScanning = status === 'queued' || status === 'running';

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollJobStatus = useCallback(async (jobId: string) => {
    // If tab is hidden, skip this poll cycle
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }

    // Check maximum poll timeout
    const now = Date.now();
    if (now - pollStartTimeRef.current > MAX_POLL_TIME_MS) {
      stopPolling();
      setStatus('failed');
      setErrorMessage('Scan timed out waiting for response.');
      return;
    }

    try {
      const targetDeviceId = deviceId || '';
      const job = await fetchScanJob(targetDeviceId, jobId);

      if (!job) return;

      if (job.status === 'queued') {
        setStatus('queued');
        setProgressPercent(0);
        setProgressStep('Waiting for the agent...');
      } else if (job.status === 'running') {
        setStatus('running');
        setProgressPercent(Math.max(5, Math.min(99, job.progressPercent || 10)));
        setProgressStep(job.progressStep || 'Scanning host software...');
      } else if (job.status === 'succeeded') {
        stopPolling();
        setStatus('succeeded');
        setProgressPercent(100);
        setProgressStep('Completed');
        setAppCount(job.appCount || 0);
        if (onScanSuccess) {
          try {
            await onScanSuccess();
          } catch {
            // non-fatal callback failure
          }
        }
      } else if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'timed_out') {
        stopPolling();
        setStatus('failed');
        setErrorMessage(job.errorMessage || `Scan job ended with status: ${job.status}`);
      }
    } catch (err: unknown) {
      // Don't halt on single transient polling network error, continue polling
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404')) {
        stopPolling();
        setStatus('failed');
        setErrorMessage('Scan job not found or device unlinked.');
      }
    }
  }, [deviceId, onScanSuccess, stopPolling]);

  const startPolling = useCallback((jobId: string) => {
    stopPolling();
    setActiveJobId(jobId);
    pollStartTimeRef.current = Date.now();

    // Initial immediate check
    pollJobStatus(jobId);

    // Continuous 2s interval
    pollTimerRef.current = setInterval(() => {
      if (activeJobIdRef.current) {
        pollJobStatus(activeJobIdRef.current);
      }
    }, POLL_INTERVAL_MS);
  }, [pollJobStatus, stopPolling]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  // Handle visibility changes: resume immediately when tab is restored
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isScanning && activeJobIdRef.current) {
        pollJobStatus(activeJobIdRef.current);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isScanning, pollJobStatus]);

  const handleStartScan = async () => {
    if (!isOnline || isScanning) return;

    setStatus('queued');
    setProgressPercent(0);
    setProgressStep('Waiting for the agent...');
    setErrorMessage(null);

    try {
      const result = await triggerScan(deviceId);
      if (result.scanId) {
        startPolling(result.scanId);
      }
    } catch (err: unknown) {
      stopPolling();
      setStatus('failed');
      const safeMsg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'Unable to start scan. Please verify agent is online.';
      setErrorMessage(safeMsg);
    }
  };

  const getDisabledReason = (): string | null => {
    if (!isOnline) {
      return 'Agent is offline. The Windows PC running the agent must be online to perform scans.';
    }
    if (isScanning) {
      return 'A scan is currently active. Please wait for it to complete.';
    }
    return null;
  };

  const disabledReason = getDisabledReason();
  const isButtonDisabled = !isOnline || isScanning;

  return (
    <div className={`scan-controller ${className}`} data-testid="scan-controller">
      <div className="scan-action-row">
        <button
          type="button"
          className={`scan-now-btn ${buttonClassName}`}
          onClick={handleStartScan}
          disabled={isButtonDisabled}
          aria-label={buttonAriaLabel}
          title={disabledReason || 'Trigger application inventory scan'}
          data-testid="scan-now-btn"
        >
          {isScanning ? (
            <>
              <span className="spinner-sm" aria-hidden="true" />
              Scanning...
            </>
          ) : (
            'Scan now'
          )}
        </button>

        {!isOnline && (
          <span
            className="scan-offline-indicator"
            data-testid="agent-offline-badge"
            title="Agent is offline. Paired Windows host must be online to run scans."
          >
            ● Agent offline
          </span>
        )}

        {disabledReason && (
          <span className="sr-only" data-testid="scan-disabled-reason">
            {disabledReason}
          </span>
        )}
      </div>

      {/* Queued State */}
      {status === 'queued' && (
        <div
          role="status"
          className="scan-status-banner queued"
          aria-live="polite"
          data-testid="scan-queued-state"
        >
          <div className="scan-status-header">
            <span className="spinner-sm" aria-hidden="true" />
            <strong>Scan initiated successfully. Waiting for the agent...</strong>
          </div>
          <p className="scan-progress-meta">Waiting for the agent to claim the scan job...</p>
        </div>
      )}

      {/* Running State */}
      {status === 'running' && (
        <div
          role="status"
          className="scan-status-banner running"
          aria-live="polite"
          data-testid="scan-running-state"
        >
          <div className="scan-progress-container">
            <div
              className="scan-progress-bar-track"
              role="progressbar"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Scan progress"
            >
              <div
                className="scan-progress-bar-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="scan-progress-meta">
              <span data-testid="scan-progress-step">{progressStep}</span>
              <span>{progressPercent}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Succeeded State */}
      {status === 'succeeded' && (
        <div
          role="status"
          className="scan-status-banner succeeded"
          aria-live="polite"
          data-testid="scan-succeeded-state"
        >
          <div className="scan-status-header">
            <div className="scan-success-row">
              <span aria-hidden="true">✔</span>
              <span>Found {appCount} applications</span>
              <Link to="/applications" className="scan-applications-link">
                View in Applications
              </Link>
            </div>
            <button
              type="button"
              className="modal-close-btn"
              onClick={() => setStatus('idle')}
              aria-label="Dismiss scan notification"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Failed State */}
      {status === 'failed' && (
        <div
          role="alert"
          className="scan-status-banner failed"
          aria-live="assertive"
          data-testid="scan-failed-state"
        >
          <div className="scan-status-header">
            <div className="scan-failure-row">
              <span aria-hidden="true">⚠</span>
              <span>{errorMessage || 'Scan failed'}</span>
            </div>
            <button
              type="button"
              className="scan-retry-btn"
              onClick={handleStartScan}
              data-testid="scan-retry-btn"
              aria-label="Try scan again"
            >
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
