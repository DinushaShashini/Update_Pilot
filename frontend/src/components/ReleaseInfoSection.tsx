import React, { useState } from 'react';
import { isValidHttpsUrl, extractHostname, formatRelativeTime } from '../utils/urlSafety';
import { refreshMetadata } from '../api/updates';
import './ReleaseInfoSection.css';

export interface ReleaseInfoSectionProps {
  targetVersion?: string | null;
  publisher?: string | null;
  officialSourceLink?: string | null;
  releaseNotesLink?: string | null;
  releaseNotesSummary?: string | null;
  fetchedAt?: string | null;
  metadataStatus?: 'available' | 'partial' | 'missing' | 'stale';
  missingMessages?: {
    officialSourceLink?: string;
    releaseNotes?: string;
    general?: string;
  };
  deviceId?: string;
  packageId?: string;
  onRefresh?: () => Promise<void> | void;
  className?: string;
}

export const ReleaseInfoSection: React.FC<ReleaseInfoSectionProps> = ({
  targetVersion,
  publisher,
  officialSourceLink,
  releaseNotesLink,
  releaseNotesSummary,
  fetchedAt,
  metadataStatus,
  missingMessages,
  deviceId,
  packageId,
  onRefresh,
  className = '',
}) => {
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [refreshFeedback, setRefreshFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const hasValidOfficialLink = isValidHttpsUrl(officialSourceLink);
  const officialHostname = hasValidOfficialLink ? extractHostname(officialSourceLink) : null;

  const hasValidNotesLink = isValidHttpsUrl(releaseNotesLink);
  const notesHostname = hasValidNotesLink ? extractHostname(releaseNotesLink) : null;

  const hasNotesSummary = Boolean(releaseNotesSummary && releaseNotesSummary.trim().length > 0);

  const relativeTimeText = formatRelativeTime(fetchedAt);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshFeedback(null);
    try {
      await refreshMetadata(deviceId, packageId);
      setRefreshFeedback({
        type: 'success',
        message: 'Refresh queued. Updated release notes will appear shortly.',
      });
      if (onRefresh) {
        await onRefresh();
      }
    } catch (err: unknown) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string'
          ? (err as { message: string }).message
          : 'Failed to refresh release info. Please try again.';
      setRefreshFeedback({
        type: 'error',
        message: msg,
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className={`release-info-section ${className}`} data-testid="release-info-section">
      <div className="release-info-header">
        <div className="release-info-title-group">
          <h4 className="release-info-title">Release Information</h4>
          <span className="metadata-updated-badge" data-testid="metadata-updated-time">
            {relativeTimeText}
          </span>
        </div>
        <button
          type="button"
          className="btn-refresh-metadata"
          onClick={handleRefresh}
          disabled={isRefreshing}
          aria-label="Refresh release information"
          data-testid="btn-refresh-metadata"
        >
          {isRefreshing ? <span className="spinner-xs" aria-hidden="true" /> : <span aria-hidden="true">↻</span>}
          <span>{isRefreshing ? 'Refreshing...' : 'Refresh'}</span>
        </button>
      </div>

      {refreshFeedback && (
        <div
          role={refreshFeedback.type === 'error' ? 'alert' : 'status'}
          className={`refresh-feedback-alert ${refreshFeedback.type}`}
          data-testid="refresh-feedback"
        >
          {refreshFeedback.message}
        </div>
      )}

      <div className="release-info-grid">
        {targetVersion && (
          <div className="release-info-field" data-testid="field-target-version">
            <span className="field-label">Target Version</span>
            <span className="field-value mono" data-testid="target-version-value">
              {targetVersion}
            </span>
          </div>
        )}

        <div className="release-info-field" data-testid="field-publisher">
          <span className="field-label">Publisher</span>
          {publisher ? (
            <span className="field-value" data-testid="publisher-value">
              {publisher}
            </span>
          ) : (
            <span className="field-missing" data-testid="publisher-missing">
              Publisher not provided
            </span>
          )}
        </div>

        <div className="release-info-field" data-testid="field-official-source">
          <span className="field-label">Official Source</span>
          {hasValidOfficialLink ? (
            <a
              href={officialSourceLink!}
              target="_blank"
              rel="noopener noreferrer"
              className="official-source-link"
              data-testid="official-source-link"
              aria-label={`Official website: ${officialHostname} (opens in new tab)`}
            >
              <span className="link-host">{officialHostname}</span>
              <span className="external-icon" aria-hidden="true">
                ↗
              </span>
            </a>
          ) : (
            <span className="field-missing" data-testid="official-source-missing">
              {missingMessages?.officialSourceLink || 'Official source link not provided by the publisher'}
            </span>
          )}
        </div>
      </div>

      <div className="release-notes-container" data-testid="release-notes-container">
        <div className="release-notes-header">
          <span className="field-label">Release Notes</span>
          {hasValidNotesLink && (
            <a
              href={releaseNotesLink!}
              target="_blank"
              rel="noopener noreferrer"
              className="notes-external-link"
              data-testid="release-notes-link"
              aria-label={`View full release notes on ${notesHostname} (opens in new tab)`}
            >
              <span>View on {notesHostname}</span>
              <span className="external-icon" aria-hidden="true">
                ↗
              </span>
            </a>
          )}
        </div>

        {hasNotesSummary ? (
          <pre
            className="release-notes-pre"
            tabIndex={0}
            role="region"
            aria-label="Release notes"
            data-testid="release-notes-text"
          >
            {releaseNotesSummary}
          </pre>
        ) : (
          <div className="release-notes-empty" data-testid="release-notes-empty" role="note">
            {missingMessages?.releaseNotes || 'Release notes not provided by the publisher'}
          </div>
        )}
      </div>

      {metadataStatus === 'stale' && (
        <div className="metadata-stale-banner" data-testid="metadata-stale-banner" role="note">
          ⚠️ Information is stale. Click Refresh to query the latest release manifests.
        </div>
      )}
    </div>
  );
};
