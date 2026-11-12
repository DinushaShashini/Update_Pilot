import React, { useState, useEffect, useRef } from 'react';
import type { UpdateItem } from '../api/updates';
import { fetchPendingUpdates, approveUpdate, rejectUpdate } from '../api/updates';
import './Updates.css';

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export const Updates: React.FC = () => {
  const [updates, setUpdates] = useState<UpdateItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Approval Modal State
  const [selectedForApproval, setSelectedForApproval] = useState<UpdateItem | null>(null);
  const [isSubmittingApproval, setIsSubmittingApproval] = useState<boolean>(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  const loadUpdates = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchPendingUpdates();
      setUpdates(data || []);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to load pending updates.'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadUpdates();
  }, []);

  // Keyboard navigation: Escape closes approval dialog
  useEffect(() => {
    if (!selectedForApproval) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedForApproval(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    cancelBtnRef.current?.focus();
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedForApproval]);

  const handleConfirmApproval = async () => {
    if (!selectedForApproval) return;
    setIsSubmittingApproval(true);
    setApprovalError(null);
    try {
      await approveUpdate(selectedForApproval.id);
      setUpdates(prev =>
        prev.map(u => (u.id === selectedForApproval.id ? { ...u, status: 'APPROVED' } : u))
      );
      setFeedbackMessage({
        type: 'success',
        text: `Update for "${selectedForApproval.name}" successfully approved and queued for agent installation.`,
      });
      setSelectedForApproval(null);
    } catch (err: unknown) {
      setApprovalError(getErrorMessage(err, 'Failed to approve update. Please try again.'));
    } finally {
      setIsSubmittingApproval(false);
    }
  };

  const handleReject = async (update: UpdateItem) => {
    try {
      await rejectUpdate(update.id);
      setUpdates(prev =>
        prev.map(u => (u.id === update.id ? { ...u, status: 'REJECTED' } : u))
      );
      setFeedbackMessage({
        type: 'success',
        text: `Update for "${update.name}" rejected. It will not be installed.`,
      });
    } catch (err: unknown) {
      setFeedbackMessage({
        type: 'error',
        text: getErrorMessage(err, 'Failed to reject update.'),
      });
    }
  };

  // Only offer updates for matched applications (preserve backward compatibility when matchStatus is omitted)
  const eligibleUpdates = updates.filter(u => !u.matchStatus || u.matchStatus === 'matched');
  const excludedUpdates = updates.filter(u => u.matchStatus && u.matchStatus !== 'matched');
  const pendingCount = eligibleUpdates.filter(u => u.status === 'PENDING_APPROVAL').length;

  return (
    <div className="updates-page" data-testid="updates-page">
      <header className="updates-header">
        <div className="updates-title-group">
          <h1>Software Updates</h1>
          <p>
            {pendingCount} update{pendingCount === 1 ? '' : 's'} awaiting explicit user approval
          </p>
        </div>
      </header>

      {/* Explicit Approval Gate Banner */}
      <section className="approval-gate-banner" aria-label="Approval Policy">
        <span className="approval-gate-icon" aria-hidden="true">🛡️</span>
        <div className="approval-gate-text">
          <h2>Explicit User Approval Gate (Rule #1)</h2>
          <p>
            No software updates are applied automatically. You must explicitly inspect and approve each package before
            the Windows agent executes installation. Only conservatively matched applications are offered here.
          </p>
        </div>
      </section>

      {!isLoading && !error && excludedUpdates.length > 0 && (
        <div
          role="note"
          className="state-box"
          data-testid="updates-excluded-note"
          style={{ marginBottom: '16px', padding: '12px 16px', textAlign: 'left' }}
        >
          <strong>
            {excludedUpdates.length} application{excludedUpdates.length === 1 ? '' : 's'} excluded from automated updates:
          </strong>{' '}
          Ambiguous or unsupported applications cannot be safely updated automatically and are not listed for approval.
          Review their status in the Applications page.
        </div>
      )}

      {feedbackMessage && (
        <div role="status" className={`settings-alert ${feedbackMessage.type}`} aria-live="polite">
          <span>{feedbackMessage.text}</span>
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setFeedbackMessage(null)}
            aria-label="Dismiss feedback"
          >
            ×
          </button>
        </div>
      )}

      {/* Main Content Area */}
      {isLoading && (
        <div className="state-box" data-testid="updates-loading" role="status" aria-live="polite">
          <span className="spinner-sm" aria-hidden="true" />
          <p>Querying detected update packages...</p>
        </div>
      )}

      {!isLoading && error && (
        <div className="state-box error-state" data-testid="updates-error" role="alert">
          <h3>Unable to Load Updates</h3>
          <p>{error}</p>
          <button type="button" className="btn-secondary" onClick={loadUpdates}>
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && eligibleUpdates.length === 0 && (
        <div className="state-box" data-testid="updates-empty">
          <h3>All applications are up to date</h3>
          <p>The Windows agent found no pending software upgrades for matched packages on your registered devices.</p>
        </div>
      )}

      {!isLoading && !error && eligibleUpdates.length > 0 && (
        <div className="updates-table-card">
          <table className="updates-table" aria-label="Pending software updates list">
            <thead>
              <tr>
                <th scope="col">Application</th>
                <th scope="col">Package ID</th>
                <th scope="col">Version Delta</th>
                <th scope="col">Source</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {eligibleUpdates.map(update => {
                const isPending = update.status === 'PENDING_APPROVAL';
                const isApproved = update.status === 'APPROVED';
                const isRejected = update.status === 'REJECTED';

                return (
                  <tr key={update.id} data-testid={`update-row-${update.packageId || update.id}`}>
                    <td className="app-name-cell">{update.name}</td>
                    <td className="app-package-id">{update.packageId}</td>
                    <td>
                      <div className="version-diff-container">
                        <span className="version-old">{update.currentVersion}</span>
                        <span className="version-arrow" aria-hidden="true">→</span>
                        <span className="version-new">{update.targetVersion}</span>
                      </div>
                    </td>
                    <td>{update.source || 'winget'}</td>
                    <td>
                      {isPending && (
                        <span className="badge-update-avail" data-testid="status-pending">
                          Pending Approval
                        </span>
                      )}
                      {isApproved && (
                        <span className="badge-managed" data-testid="status-approved">
                          Approved
                        </span>
                      )}
                      {isRejected && (
                        <span className="badge-unsupported" data-testid="status-rejected">
                          Rejected
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="update-actions-cell">
                        <button
                          type="button"
                          className="btn-approve"
                          onClick={() => {
                            setSelectedForApproval(update);
                            setApprovalError(null);
                          }}
                          disabled={!isPending}
                          aria-label={`Approve update for ${update.name}`}
                        >
                          {isApproved ? 'Approved ✓' : 'Approve'}
                        </button>
                        <button
                          type="button"
                          className="btn-reject"
                          onClick={() => handleReject(update)}
                          disabled={!isPending}
                          aria-label={`Reject update for ${update.name}`}
                        >
                          {isRejected ? 'Rejected ✕' : 'Reject'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Accessible Approval Confirmation Modal Dialog */}
      {selectedForApproval && (
        <div
          className="modal-overlay"
          onClick={() => setSelectedForApproval(null)}
          data-testid="approval-dialog-overlay"
        >
          <div
            className="modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-dialog-title"
            aria-describedby="approval-dialog-description"
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <div className="modal-title-group">
                <h3 id="approval-dialog-title" style={{ color: 'var(--text-main)' }}>
                  Approve Software Update
                </h3>
                <p id="approval-dialog-description">
                  Explicit authorization required before agent installation
                </p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setSelectedForApproval(null)}
                disabled={isSubmittingApproval}
                aria-label="Close approval dialog"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              {approvalError && (
                <div role="alert" className="settings-alert error">
                  {approvalError}
                </div>
              )}

              <div className="approval-dialog-package-card">
                <div>
                  <span className="detail-row-label">Target Package</span>
                  <p style={{ fontWeight: 600, color: 'var(--text-main)', fontSize: '15px' }}>
                    {selectedForApproval.name}
                  </p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--info)' }}>
                    {selectedForApproval.packageId}
                  </p>
                </div>

                <div className="version-diff-container" style={{ marginTop: '6px' }}>
                  <span className="version-old">{selectedForApproval.currentVersion}</span>
                  <span className="version-arrow" aria-hidden="true">→</span>
                  <span className="version-new" style={{ fontSize: '13px' }}>
                    {selectedForApproval.targetVersion}
                  </span>
                </div>
              </div>

              <div className="warning-checklist-box">
                <h4>Safety & Execution Invariants:</h4>
                <ol className="warning-checklist">
                  <li>The agent will execute <code>winget upgrade --id {selectedForApproval.packageId} --exact</code>.</li>
                  <li>Installation proceeds only while host device is online and authenticated.</li>
                  <li>Exit code and new package version will be strictly verified post-install.</li>
                </ol>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                ref={cancelBtnRef}
                className="btn-secondary"
                onClick={() => setSelectedForApproval(null)}
                disabled={isSubmittingApproval}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleConfirmApproval}
                disabled={isSubmittingApproval}
                aria-label="Confirm approval"
              >
                {isSubmittingApproval ? 'Approving...' : 'Confirm Approval'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Updates;
