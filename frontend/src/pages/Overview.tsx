import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { OverviewMetrics } from '../api/overview';
import { fetchOverviewMetrics, defaultOverviewMetrics } from '../api/overview';
import { ScanNowController } from '../components/ScanNowController';
import './Overview.css';

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export const Overview: React.FC = () => {
  const [metrics, setMetrics] = useState<OverviewMetrics>(defaultOverviewMetrics);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const loadMetrics = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchOverviewMetrics();
      setMetrics(data);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to load dashboard metrics.'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadMetrics();
  }, []);

  const isOnline = metrics.agentStatus.toUpperCase() === 'ONLINE';

  return (
    <div className="overview-page" data-testid="overview-page">
      <header className="overview-header">
        <div className="overview-title-group">
          <h1>Dashboard Overview</h1>
          <p>Host software inventory and update approval center</p>
        </div>
        <ScanNowController
          isOnline={isOnline}
          onScanSuccess={loadMetrics}
          buttonAriaLabel="Scan now for updates"
        />
      </header>

      {isLoading && (
        <div className="state-box" data-testid="overview-loading" role="status" aria-live="polite">
          <span className="spinner-sm" aria-hidden="true" />
          <p>Loading system metrics and telemetry...</p>
        </div>
      )}

      {!isLoading && error && (
        <div className="state-box error-state" data-testid="overview-error" role="alert">
          <h3>Unable to Load Dashboard</h3>
          <p>{error}</p>
          <button type="button" className="btn-secondary" onClick={loadMetrics}>
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && (
        <>
          {/* 5 Metrics Cards Grid */}
          <section className="metrics-grid" aria-label="Key Performance Metrics">
            <Link to="/applications" className="metric-card" data-testid="metric-total-apps">
              <div className="metric-card-header">
                <span className="metric-card-title">Total Apps</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ opacity: 0.7 }}>
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                  <line x1="12" y1="22.08" x2="12" y2="12"></line>
                </svg>
              </div>
              <div className="metric-value">{metrics.totalApps}</div>
              <div className="metric-subtext">{metrics.managedApps} managed via WinGet</div>
            </Link>

            <Link to="/updates" className="metric-card accent-updates" data-testid="metric-updates">
              <div className="metric-card-header">
                <span className="metric-card-title" style={{ color: 'var(--warning)' }}>
                  Updates Available
                </span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--warning)' }}>
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                </svg>
              </div>
              <div className="metric-value">{metrics.pendingUpdatesCount}</div>
              <div className="metric-subtext">Explicit approval required</div>
            </Link>

            <Link to="/applications?matchStatus=unsupported" className="metric-card" data-testid="metric-unsupported">
              <div className="metric-card-header">
                <span className="metric-card-title">Unsupported</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ opacity: 0.7 }}>
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
              </div>
              <div className="metric-value">{metrics.unsupportedApps}</div>
              <div className="metric-subtext">Manual vendor installers</div>
            </Link>

            <Link to="/history" className="metric-card" data-testid="metric-last-scan">
              <div className="metric-card-header">
                <span className="metric-card-title">Last Scan</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ opacity: 0.7 }}>
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              </div>
              <div className="metric-value" style={{ fontSize: '20px' }}>
                {metrics.lastScanAt ? 'Recent' : 'Never'}
              </div>
              <div className="metric-subtext">Status: {metrics.lastScanStatus}</div>
            </Link>

            <Link to="/settings" className="metric-card" data-testid="metric-agent-status">
              <div className="metric-card-header">
                <span className="metric-card-title">Agent Status</span>
                <span
                  className={`status-badge ${isOnline ? 'online' : 'offline'}`}
                  style={{ padding: '2px 8px', fontSize: '10px' }}
                >
                  {metrics.agentStatus}
                </span>
              </div>
              <div className="metric-value" style={{ fontSize: '18px' }}>
                {metrics.agentHostname || 'DESKTOP'}
              </div>
              <div className="metric-subtext">
                {isOnline ? 'Live heartbeat connected' : 'Agent offline or disconnected'}
              </div>
            </Link>
          </section>

          {/* Two-Column Workspaces */}
          <section className="overview-sections-grid">
            {/* Left: Quick Approvals */}
            <div className="overview-panel-card">
              <div className="panel-card-header">
                <h2>Action Required: Pending Updates</h2>
                <Link to="/updates" className="view-all-link">
                  View All Updates →
                </Link>
              </div>

              {metrics.quickPendingUpdates.length === 0 ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  <p>No updates currently awaiting approval.</p>
                </div>
              ) : (
                <div className="devices-table-wrapper">
                  <table className="devices-table" aria-label="Action Required Updates">
                    <thead>
                      <tr>
                        <th scope="col">Software</th>
                        <th scope="col">Version Bump</th>
                        <th scope="col">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.quickPendingUpdates.slice(0, 5).map(item => (
                        <tr key={item.id}>
                          <td className="device-name-cell">{item.name}</td>
                          <td>
                            <span className="version-new">
                              {item.currentVersion} → {item.targetVersion}
                            </span>
                          </td>
                          <td>
                            <Link to="/updates" className="btn-approve" style={{ textDecoration: 'none' }}>
                              Review & Approve
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Right: Activity Stream */}
            <div className="overview-panel-card">
              <div className="panel-card-header">
                <h2>Recent Activity</h2>
                <Link to="/history" className="view-all-link">
                  Full History →
                </Link>
              </div>

              {metrics.recentActivity.length === 0 ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  <p>No recent activity logged yet.</p>
                </div>
              ) : (
                <div className="activity-feed-list">
                  {metrics.recentActivity.slice(0, 6).map(act => (
                    <div key={act.id} className="activity-feed-item">
                      <div className="activity-item-icon" aria-hidden="true">
                        {act.eventType === 'UPDATE' ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                          </svg>
                        ) : act.eventType === 'SCAN' ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="8"></circle>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                          </svg>
                        )}
                      </div>
                      <div className="activity-item-content">
                        <span className="activity-item-title">{act.title}</span>
                        <span className="activity-item-desc">{act.description}</span>
                        <span className="activity-item-time">{act.timestamp}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
};

export default Overview;
