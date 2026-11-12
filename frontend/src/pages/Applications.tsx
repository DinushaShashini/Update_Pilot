import React, { useState, useEffect, useMemo } from 'react';
import type { Application, ApplicationsFilterParams, MatchStatus } from '../api/applications';
import { fetchApplications } from '../api/applications';
import { ScanNowController } from '../components/ScanNowController';
import './Applications.css';

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function getEffectiveMatchStatus(app: Application): MatchStatus {
  if (app.matchStatus) return app.matchStatus;
  return app.isManaged ? 'matched' : 'unsupported';
}

export interface MatchDisplayInfo {
  status: MatchStatus;
  label: string;
  icon: string;
  reasonCode: string;
  message: string;
  nextStep: string;
}

export function getMatchDisplayInfo(app: Application): MatchDisplayInfo {
  const status = getEffectiveMatchStatus(app);
  const defaults: Record<MatchStatus, { label: string; icon: string; reason: string; msg: string; next: string }> = {
    matched: {
      label: 'Supported',
      icon: '✔',
      reason: 'WINGET_ID_PRESENT',
      msg: 'Matched via verified package identifier.',
      next: 'Updates can be queried and approved through WinGet.',
    },
    ambiguous: {
      label: 'Needs review',
      icon: '⚠',
      reason: 'MULTIPLE_CANDIDATES',
      msg: 'Multiple package manifests matched this application name.',
      next: 'Review candidate packages in Application Details.',
    },
    unsupported: {
      label: 'Not supported',
      icon: 'ℹ',
      reason: 'REGISTRY_ONLY',
      msg: 'Discovered locally without an automated WinGet package match.',
      next: 'Update manually using the vendor installer.',
    },
    pending: {
      label: 'Pending',
      icon: '⏳',
      reason: 'PENDING',
      msg: 'Awaiting catalog matching.',
      next: 'Matching executes automatically after scan completion.',
    },
  };

  const def = defaults[status];
  return {
    status,
    label: def.label,
    icon: def.icon,
    reasonCode: app.matchReason || def.reason,
    message: app.matchMessage || def.msg,
    nextStep: app.matchNextStep || def.next,
  };
}

export const Applications: React.FC = () => {
  const [applications, setApplications] = useState<Application[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [matchStatusFilter, setMatchStatusFilter] = useState<'all' | MatchStatus>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');

  // Keyboard-reachable tooltip/popover state
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null);

  // Pagination
  const [currentPage, setCurrentPage] = useState<number>(1);
  const pageSize = 15;

  // Slide-over Details Panel
  const [selectedApp, setSelectedApp] = useState<Application | null>(null);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchApplications(undefined, {
        search: searchQuery,
        status: statusFilter as ApplicationsFilterParams['status'],
        source: sourceFilter as ApplicationsFilterParams['source'],
      });
      setApplications(data.applications || []);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to load installed applications.'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [statusFilter, sourceFilter]);

  // Keyboard navigation: Escape key closes popover or slide-over details panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (openPopoverId) {
          setOpenPopoverId(null);
        } else if (selectedApp) {
          setSelectedApp(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedApp, openPopoverId]);

  // Client-side search and filtering
  const filteredApps = useMemo(() => {
    return applications.filter(app => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        app.name.toLowerCase().includes(q) ||
        (app.packageId && app.packageId.toLowerCase().includes(q));

      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'managed' && app.isManaged) ||
        (statusFilter === 'unsupported' && !app.isManaged) ||
        (statusFilter === 'update_available' && Boolean(app.availableVersion));

      const effectiveMatch = getEffectiveMatchStatus(app);
      const matchesSupport =
        matchStatusFilter === 'all' || effectiveMatch === matchStatusFilter;

      const matchesSource =
        sourceFilter === 'all' ||
        (app.source && app.source.toLowerCase() === sourceFilter.toLowerCase());

      return matchesSearch && matchesStatus && matchesSupport && matchesSource;
    });
  }, [applications, searchQuery, statusFilter, matchStatusFilter, sourceFilter]);

  // Metrics summary
  const totalCount = applications.length;
  const managedCount = applications.filter(a => a.isManaged).length;
  const updatesCount = applications.filter(a => Boolean(a.availableVersion)).length;

  const matchedCount = applications.filter(a => getEffectiveMatchStatus(a) === 'matched').length;
  const ambiguousCount = applications.filter(a => getEffectiveMatchStatus(a) === 'ambiguous').length;
  const unsupportedMatchCount = applications.filter(a => getEffectiveMatchStatus(a) === 'unsupported').length;

  // Pagination slice
  const totalPages = Math.max(1, Math.ceil(filteredApps.length / pageSize));
  const paginatedApps = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredApps.slice(start, start + pageSize);
  }, [filteredApps, currentPage, pageSize]);

  return (
    <div className="applications-page" data-testid="applications-page">
      {/* Header */}
      <header className="applications-header">
        <div className="applications-title-group">
          <h1>Installed Applications</h1>
          <p>
            {totalCount} discovered applications • {managedCount} supported via WinGet • {updatesCount} updates available
          </p>
        </div>
        <ScanNowController
          isOnline={true}
          onScanSuccess={loadData}
          buttonAriaLabel="Trigger scan now"
        />
      </header>

      {/* Search and Filters Controls */}
      <section className="applications-controls" aria-label="Application Filters">
        <div className="search-box-wrapper">
          <span className="search-icon" aria-hidden="true">🔍</span>
          <input
            type="search"
            className="search-input"
            placeholder="Search name, package ID..."
            value={searchQuery}
            onChange={e => {
              setSearchQuery(e.target.value);
              setCurrentPage(1);
            }}
            aria-label="Search applications"
          />
        </div>

        <div className="filter-group">
          <select
            className="filter-select"
            value={statusFilter}
            onChange={e => {
              setStatusFilter(e.target.value);
              setCurrentPage(1);
            }}
            aria-label="Filter by status"
          >
            <option value="all">Status: All ({totalCount})</option>
            <option value="managed">Supported / WinGet ({managedCount})</option>
            <option value="unsupported">Unsupported ({totalCount - managedCount})</option>
            <option value="update_available">Updates Available ({updatesCount})</option>
          </select>

          <select
            className="filter-select"
            value={matchStatusFilter}
            onChange={e => {
              setMatchStatusFilter(e.target.value as 'all' | MatchStatus);
              setCurrentPage(1);
            }}
            aria-label="Filter by update support"
          >
            <option value="all">Support: All ({totalCount})</option>
            <option value="matched">Supported ({matchedCount})</option>
            <option value="ambiguous">Needs review ({ambiguousCount})</option>
            <option value="unsupported">Not supported ({unsupportedMatchCount})</option>
          </select>

          <select
            className="filter-select"
            value={sourceFilter}
            onChange={e => {
              setSourceFilter(e.target.value);
              setCurrentPage(1);
            }}
            aria-label="Filter by source"
          >
            <option value="all">Source: All</option>
            <option value="winget">WinGet</option>
            <option value="msstore">Microsoft Store</option>
            <option value="local">Local</option>
          </select>
        </div>
      </section>

      {/* Match Support Summary Bar with Clickable Filter Chips */}
      {!isLoading && !error && (
        <section className="match-summary-bar" aria-label="Update support summary" data-testid="match-summary-bar">
          <button
            type="button"
            className={`summary-chip ${matchStatusFilter === 'all' ? 'active' : ''}`}
            onClick={() => {
              setMatchStatusFilter('all');
              setCurrentPage(1);
            }}
            aria-pressed={matchStatusFilter === 'all'}
            data-testid="filter-chip-all"
          >
            All ({totalCount})
          </button>
          <button
            type="button"
            className={`summary-chip chip-matched ${matchStatusFilter === 'matched' ? 'active' : ''}`}
            onClick={() => {
              setMatchStatusFilter('matched');
              setCurrentPage(1);
            }}
            aria-pressed={matchStatusFilter === 'matched'}
            data-testid="filter-chip-matched"
          >
            <span aria-hidden="true">✔</span> Supported ({matchedCount})
          </button>
          <button
            type="button"
            className={`summary-chip chip-ambiguous ${matchStatusFilter === 'ambiguous' ? 'active' : ''}`}
            onClick={() => {
              setMatchStatusFilter('ambiguous');
              setCurrentPage(1);
            }}
            aria-pressed={matchStatusFilter === 'ambiguous'}
            data-testid="filter-chip-ambiguous"
          >
            <span aria-hidden="true">⚠</span> Needs review ({ambiguousCount})
          </button>
          <button
            type="button"
            className={`summary-chip chip-unsupported ${matchStatusFilter === 'unsupported' ? 'active' : ''}`}
            onClick={() => {
              setMatchStatusFilter('unsupported');
              setCurrentPage(1);
            }}
            aria-pressed={matchStatusFilter === 'unsupported'}
            data-testid="filter-chip-unsupported"
          >
            <span aria-hidden="true">ℹ</span> Not supported ({unsupportedMatchCount})
          </button>
        </section>
      )}

      {/* Main Content Area */}
      {isLoading && (
        <div className="state-box" data-testid="apps-loading" role="status" aria-live="polite">
          <span className="spinner-sm" aria-hidden="true" />
          <p>Discovering installed applications from WinGet inventory...</p>
        </div>
      )}

      {!isLoading && error && (
        <div className="state-box error-state" data-testid="apps-error" role="alert">
          <h3>Failed to Load Inventory</h3>
          <p>{error}</p>
          <button type="button" className="btn-secondary" onClick={loadData}>
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && filteredApps.length === 0 && (
        <div className="state-box" data-testid="apps-empty">
          <h3>No applications found</h3>
          <p>
            {searchQuery
              ? `No software matched "${searchQuery}". Try clearing search filters.`
              : 'No applications discovered yet. Click "Scan now" to query your Windows host.'}
          </p>
        </div>
      )}

      {!isLoading && !error && filteredApps.length > 0 && (
        <div className="apps-table-container">
          <table className="apps-table" aria-label="Installed applications list">
            <thead>
              <tr>
                <th scope="col">Application</th>
                <th scope="col">Package ID</th>
                <th scope="col">Version</th>
                <th scope="col">Status</th>
                <th scope="col">Update support</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {paginatedApps.map(app => {
                const rowKey = app.id || app.packageId || app.name;
                const matchInfo = getMatchDisplayInfo(app);
                const isPopoverOpen = openPopoverId === rowKey;
                const popoverId = `match-popover-${rowKey}`;

                return (
                  <tr
                    key={rowKey}
                    className="clickable-row"
                    onClick={() => setSelectedApp(app)}
                    data-testid={`app-row-${app.packageId || app.name}`}
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter') setSelectedApp(app);
                    }}
                    role="button"
                    aria-label={`View details for ${app.name}`}
                  >
                    <td className="app-name-cell">{app.name}</td>
                    <td className="app-package-id">{app.packageId || '—'}</td>
                    <td>{app.installedVersion}</td>
                    <td>
                      {app.availableVersion ? (
                        <span className="badge-update-avail" data-testid="status-update-available">
                          Update Available ({app.availableVersion})
                        </span>
                      ) : app.isManaged ? (
                        <span className="badge-managed" data-testid="status-supported">
                          Supported
                        </span>
                      ) : (
                        <span className="badge-unsupported" data-testid="status-unsupported">
                          Unsupported
                        </span>
                      )}
                    </td>
                    <td className="match-support-cell">
                      <div className="match-badge-wrapper">
                        <button
                          type="button"
                          className={`match-badge match-badge-${matchInfo.status}`}
                          data-testid={`match-badge-${matchInfo.status}`}
                          aria-expanded={isPopoverOpen}
                          aria-describedby={isPopoverOpen ? popoverId : undefined}
                          onClick={e => {
                            e.stopPropagation();
                            setOpenPopoverId(isPopoverOpen ? null : rowKey);
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                            }
                          }}
                        >
                          <span aria-hidden="true">{matchInfo.icon}</span>
                          <span>{matchInfo.label}</span>
                        </button>

                        {isPopoverOpen && (
                          <div
                            id={popoverId}
                            role="tooltip"
                            className="match-reason-popover"
                            data-testid="match-reason-popover"
                            onClick={e => e.stopPropagation()}
                          >
                            <div className="popover-reason-code">{matchInfo.reasonCode}</div>
                            <p className="popover-message">{matchInfo.message}</p>
                            <p className="popover-next-step">
                              <strong>Next step:</strong> {matchInfo.nextStep}
                            </p>
                          </div>
                        )}
                      </div>
                    </td>
                    <td>{app.source || 'Local'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="pagination-bar">
              <span>
                Page {currentPage} of {totalPages} ({filteredApps.length} total)
              </span>
              <div className="filter-group">
                <button
                  type="button"
                  className="pagination-btn"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  aria-label="Previous page"
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="pagination-btn"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                  aria-label="Next page"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Slide-Over Details Panel */}
      {selectedApp && (
        <div
          className="details-panel-overlay"
          onClick={() => setSelectedApp(null)}
          data-testid="app-details-overlay"
        >
          <div
            className="details-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="panel-app-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="panel-header">
              <div>
                <h3 id="panel-app-title" style={{ fontSize: '18px', color: 'var(--text-main)', fontWeight: 700 }}>
                  {selectedApp.name}
                </h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  Application Details & WinGet Metadata
                </p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setSelectedApp(null)}
                aria-label="Close details panel"
              >
                ×
              </button>
            </div>

            <div className="panel-body">
              <div className="detail-row">
                <span className="detail-row-label">Package Identifier</span>
                <span className="detail-row-value" style={{ fontFamily: 'var(--font-mono)' }}>
                  {selectedApp.packageId || 'None (Unmanaged local software)'}
                </span>
              </div>

              <div className="detail-row">
                <span className="detail-row-label">Installed Version</span>
                <span className="detail-row-value">{selectedApp.installedVersion}</span>
              </div>

              <div className="detail-row">
                <span className="detail-row-label">Available Version</span>
                <span className="detail-row-value">
                  {selectedApp.availableVersion ? (
                    <span style={{ color: 'var(--warning)', fontWeight: 600 }}>
                      {selectedApp.availableVersion} (Upgrade Available)
                    </span>
                  ) : (
                    'Latest version installed'
                  )}
                </span>
              </div>

              <div className="detail-row">
                <span className="detail-row-label">Catalog Source</span>
                <span className="detail-row-value">{selectedApp.source || 'Local Installer'}</span>
              </div>

              <div className="detail-row">
                <span className="detail-row-label">WinGet Management Status</span>
                <span className="detail-row-value">
                  {selectedApp.isManaged ? (
                    <span style={{ color: 'var(--success)' }}>
                      Managed — updates can be automated through UpdatePilot
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>
                      Manual — vendor does not publish to public WinGet catalog
                    </span>
                  )}
                </span>
              </div>

              {(() => {
                const info = getMatchDisplayInfo(selectedApp);
                const confidenceText =
                  typeof selectedApp.matchConfidence === 'number'
                    ? `${Math.round(selectedApp.matchConfidence * 100)}%`
                    : '—';
                const candidates = Array.isArray(selectedApp.candidates) ? selectedApp.candidates : [];

                return (
                  <div className="match-details-section" data-testid="app-match-details">
                    <div className="detail-row">
                      <span className="detail-row-label">Update Support</span>
                      <span className="detail-row-value">
                        <span className={`match-badge match-badge-${info.status}`}>
                          <span aria-hidden="true">{info.icon}</span>
                          <span>{info.label}</span>
                        </span>
                      </span>
                    </div>

                    <div className="detail-row">
                      <span className="detail-row-label">Match Method</span>
                      <span className="detail-row-value" data-testid="detail-match-method">
                        {selectedApp.matchMethod || 'none'}
                      </span>
                    </div>

                    <div className="detail-row">
                      <span className="detail-row-label">Match Confidence</span>
                      <span className="detail-row-value" data-testid="detail-match-confidence">
                        {confidenceText}
                      </span>
                    </div>

                    <div className="detail-row">
                      <span className="detail-row-label">Matched Package ID</span>
                      <span
                        className="detail-row-value"
                        style={{ fontFamily: 'var(--font-mono)' }}
                        data-testid="detail-matched-package-id"
                      >
                        {selectedApp.matchedPackageId || '—'}
                      </span>
                    </div>

                    <div className="detail-row">
                      <span className="detail-row-label">Match Reason</span>
                      <div className="detail-row-value" data-testid="detail-match-reason">
                        <div className="popover-reason-code">{info.reasonCode}</div>
                        <p style={{ margin: '4px 0', fontSize: '13px' }}>{info.message}</p>
                        <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)' }}>
                          {info.nextStep}
                        </p>
                      </div>
                    </div>

                    {info.status === 'ambiguous' && (
                      <div className="detail-row" data-testid="ambiguous-candidates-section">
                        <span className="detail-row-label">Candidate Packages (Read-Only)</span>
                        {candidates.length > 0 ? (
                          <ul className="candidates-readonly-list" data-testid="ambiguous-candidates-list">
                            {candidates.map(cand => (
                              <li key={cand.packageId} className="candidate-readonly-item">
                                <div className="candidate-name">{cand.name}</div>
                                <div className="candidate-meta">
                                  <code>{cand.packageId}</code>
                                  {cand.publisher ? ` • ${cand.publisher}` : ''}
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="detail-row-value">No candidate metadata recorded.</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Applications;
