import React, { useState, useEffect, useRef, useCallback } from 'react';
import { triggerUpdateCheck, fetchUpdateCheckJob } from '../api/updates';
import './CheckUpdatesController.css';

export interface CheckUpdatesControllerProps {
  deviceId?: string;
  isOnline: boolean;
  onCheckSuccess?: () => void | Promise<void>;
  buttonAriaLabel?: string;
  buttonClassName?: string;
  className?: string;
}

export type CheckStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_TIME_MS = 300000; // 5 minutes max

export const CheckUpdatesController: React.FC<CheckUpdatesControllerProps> = ({
  deviceId,
  isOnline,
  onCheckSuccess,
  buttonAriaLabel = 'Check for updates',
  buttonClassName = 'btn-secondary',
  className = '',
}) => {
  const [status, setStatus] = useState<CheckStatus>('idle');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [progressStep, setProgressStep] = useState<string>('');
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [summaryMessage, setSummaryMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartTimeRef = useRef<number>(0);
  const isChecking = status === 'queued' || status === 'running';

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollJobStatus = useCallback(
    async (jobId: string) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      const now = Date.now();
      if (now - pollStartTimeRef.current > MAX_POLL_TIME_MS) {
        stopPolling();
        setStatus('failed');
        setErrorMessage('Update check timed out waiting for response.');
        return;
      }

      try {
        const targetDeviceId = deviceId || '';
        const job = await fetchUpdateCheckJob(targetDeviceId, jobId);
        if (!job) return;

        if (job.status === 'queued') {
          setStatus('queued');
          setProgressPercent(0);
          setProgressStep('Waiting for the agent...');
          setProgressMessage(job.progressMessage || null);
        } else if (job.status === 'running') {
          setStatus('running');
          setProgressPercent((prev) => Math.max(prev, Math.min(99, job.progressPercent ?? 0)));
          setProgressStep(job.progressStep || 'Querying WinGet for updates...');
          setProgressMessage(job.progressMessage || null);
        } else if (job.status === 'succeeded') {
          stopPolling();
          setStatus('succeeded');
          setProgressPercent(100);
          setProgressStep('Completed');
          const summary =
            job.progressMessage ||
            `Check complete: ${job.appCount || 0} updates available.`;
          setSummaryMessage(summary);

          if (onCheckSuccess) {
            try {
              await onCheckSuccess();
            } catch {
              // Ignore failure in caller refresh
            }
          }
        } else if (
          job.status === 'failed' ||
          job.status === 'cancelled' ||
          job.status === 'timed_out'
        ) {
          stopPolling();
          setStatus('failed');
          setErrorMessage(job.errorMessage || 'Update check failed on the device.');
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to query check status.';
        if (msg.includes('404')) {
          stopPolling();
          setStatus('failed');
          setErrorMessage('Update-check job not found.');
        }
      }
    },
    [deviceId, onCheckSuccess, stopPolling]
  );

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      setActiveJobId(jobId);
      pollStartTimeRef.current = Date.now();
      void pollJobStatus(jobId);
      pollTimerRef.current = setInterval(() => {
        void pollJobStatus(jobId);
      }, POLL_INTERVAL_MS);
    },
    [pollJobStatus, stopPolling]
  );

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const handleStartCheck = async () => {
    if (!isOnline || isChecking) return;

    setStatus('queued');
    setProgressPercent(0);
    setProgressStep('Queuing update check...');
    setProgressMessage(null);
    setSummaryMessage(null);
    setErrorMessage(null);

    try {
      const result = await triggerUpdateCheck(deviceId);
      if (result.jobId) {
        startPolling(result.jobId);
      } else {
        setStatus('idle');
      }
    } catch (err: unknown) {
      setStatus('failed');
      const msg = err instanceof Error ? err.message : 'Failed to queue update check.';
      setErrorMessage(msg);
    }
  };

  const handleDismiss = () => {
    setStatus('idle');
    setSummaryMessage(null);
    setErrorMessage(null);
    setProgressPercent(0);
  };

  return (
    <div
      className={`check-updates-controller ${className}`}
      data-testid="check-updates-controller"
      data-active-job-id={activeJobId || undefined}
    >
      <div className="check-updates-actions">
        <button
          type="button"
          className={buttonClassName}
          onClick={handleStartCheck}
          disabled={!isOnline || isChecking}
          aria-label={buttonAriaLabel}
          data-testid="check-updates-btn"
        >
          {isChecking ? (
            <>
              <span className="spinner-sm" aria-hidden="true" />
              <span>Checking for updates...</span>
            </>
          ) : (
            <>
              <span aria-hidden="true">🔄</span>
              <span>Check for updates</span>
            </>
          )}
        </button>
      </div>

      {/* Live Progress Bar & Status */}
      {isChecking && (
        <div
          className="check-progress-banner"
          data-testid="check-progress-banner"
          role="status"
          aria-live="polite"
        >
          <div className="check-progress-header">
            <span className="check-progress-label">
              <span className="spinner-sm" aria-hidden="true" />
              <strong>{progressStep}</strong>
            </span>
            <span className="check-progress-percent">{progressPercent}%</span>
          </div>

          <div
            className="check-progress-bar-track"
            role="progressbar"
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Update check progress"
          >
            <div
              className="check-progress-bar-fill"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {progressMessage && (
            <div className="check-progress-msg" data-testid="check-progress-msg">
              {progressMessage}
            </div>
          )}
        </div>
      )}

      {/* Completion Summary */}
      {status === 'succeeded' && summaryMessage && (
        <div
          className="check-summary-alert success"
          data-testid="check-summary-alert"
          role="status"
          aria-live="polite"
        >
          <span className="alert-icon" aria-hidden="true">
            ✔
          </span>
          <span className="alert-text">{summaryMessage}</span>
          <button
            type="button"
            className="alert-dismiss-btn"
            onClick={handleDismiss}
            aria-label="Dismiss summary"
          >
            ×
          </button>
        </div>
      )}

      {/* Error Banner */}
      {status === 'failed' && errorMessage && (
        <div
          className="check-summary-alert error"
          data-testid="check-error-alert"
          role="alert"
        >
          <span className="alert-icon" aria-hidden="true">
            ⚠
          </span>
          <span className="alert-text">{errorMessage}</span>
          <button
            type="button"
            className="alert-dismiss-btn"
            onClick={handleDismiss}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
};
