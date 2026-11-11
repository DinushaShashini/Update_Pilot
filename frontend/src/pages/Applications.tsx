import React, { useState, useEffect, useMemo } from 'react';
import type { Application, ApplicationsFilterParams } from '../api/applications';
import { fetchApplications, triggerScan } from '../api/applications';
import './Applications.css';

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export const Applications: React.FC = () => {
  const [applications, setApplications] = useState<Application[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');

  // Pagination
  const [currentPage, setCurrentPage] = useState<number>(1);
  const pageSize = 15;

  // Scan triggering
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

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

  const handleScanNow = async () => {
    setIsScanning(true);
    setScanMessage(null);
    try {
      await triggerScan();
      setScanMessage('Scan initiated successfully. Refreshing inventory...');
      await loadData();
    } catch (err: unknown) {
      setScanMessage(getErrorMessage(err, 'Unable to start scan. Please verify agent is online.'));
    } finally {
      setIsScanning(false);
    }
  };

  // Keyboard navigation: Escape key closes the slide-over details panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedApp) {
        setSelectedApp(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedApp]);

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

      const matchesSource =
        sourceFilter === 'all' ||
        (app.source && app.source.toLowerCase() === sourceFilter.toLowerCase());

      return matchesSearch && matchesStatus && matchesSource;
    });
  }, [applications, searchQuery, statusFilter, sourceFilter]);

  // Metrics summary
  const totalCount = applications.length;
  const managedCount = applications.filter(a => a.isManaged).length;
  const updatesCount = applications.filter(a => Boolean(a.availableVersion)).length;

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
        <button
          type="button"
          className="btn-primary"
          onClick={handleScanNow}
          disabled={isScanning}
          aria-label="Trigger scan now"
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
      </header>

      {scanMessage && (
        <div role="status" className="settings-alert success" aria-live="polite">
          <span>{scanMessage}</span>
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setScanMessage(null)}
            aria-label="Dismiss message"
          >
            ×
          </button>
        </div>
      )}

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
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {paginatedApps.map(app => (
                <tr
                  key={app.id || app.packageId || app.name}
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
                  <td>{app.source || 'Local'}</td>
                </tr>
              ))}
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Applications;
