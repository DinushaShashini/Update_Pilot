import React, { useState, useEffect, useMemo } from 'react';
import type { HistoryEvent } from '../api/history';
import { fetchHistory } from '../api/history';
import './History.css';

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export const History: React.FC = () => {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const loadHistory = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchHistory(undefined, {
        type: typeFilter,
        status: statusFilter,
        search: searchQuery,
      });
      setEvents(data || []);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to load audit and job history.'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, [typeFilter, statusFilter]);

  const filteredEvents = useMemo(() => {
    return events.filter(evt => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        evt.title.toLowerCase().includes(q) ||
        evt.target.toLowerCase().includes(q) ||
        evt.id.toLowerCase().includes(q);

      const matchesType =
        typeFilter === 'all' || evt.eventType.toLowerCase() === typeFilter.toLowerCase();

      const matchesStatus =
        statusFilter === 'all' || evt.status.toLowerCase() === statusFilter.toLowerCase();

      return matchesSearch && matchesType && matchesStatus;
    });
  }, [events, searchQuery, typeFilter, statusFilter]);

  const handleExportCsv = () => {
    if (filteredEvents.length === 0) return;
    const headers = ['ID', 'Event Type', 'Title', 'Target', 'Status', 'Operator', 'Timestamp'];
    const rows = filteredEvents.map(e => [
      `"${e.id}"`,
      `"${e.eventType}"`,
      `"${e.title.replace(/"/g, '""')}"`,
      `"${e.target.replace(/"/g, '""')}"`,
      `"${e.status}"`,
      `"${e.operator}"`,
      `"${e.timestamp}"`,
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `updatepilot-history-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="history-page" data-testid="history-page">
      <header className="history-header">
        <div className="history-title-group">
          <h1>Job & Audit History</h1>
          <p>Immutable chronological ledger of scans, approvals, rejections, and execution results</p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleExportCsv}
          disabled={filteredEvents.length === 0}
          aria-label="Export history to CSV"
        >
          ⬇ Export CSV
        </button>
      </header>

      {/* Controls & Filter Bar */}
      <section className="history-controls" aria-label="History Filters">
        <div className="search-box-wrapper">
          <span className="search-icon" aria-hidden="true">🔍</span>
          <input
            type="search"
            className="search-input"
            placeholder="Search package, job, or event ID..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            aria-label="Search history records"
          />
        </div>

        <div className="filter-group">
          <select
            className="filter-select"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            aria-label="Filter by event type"
          >
            <option value="all">Type: All Events</option>
            <option value="update">Update Executions</option>
            <option value="scan">Host Scans</option>
            <option value="approval">Approvals</option>
            <option value="rejection">Rejections</option>
            <option value="revocation">Revocations</option>
          </select>

          <select
            className="filter-select"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            aria-label="Filter by event status"
          >
            <option value="all">Status: All Statuses</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
      </section>

      {/* Content Area */}
      {isLoading && (
        <div className="state-box" data-testid="history-loading" role="status" aria-live="polite">
          <span className="spinner-sm" aria-hidden="true" />
          <p>Loading chronological audit ledger...</p>
        </div>
      )}

      {!isLoading && error && (
        <div className="state-box error-state" data-testid="history-error" role="alert">
          <h3>Failed to Load History</h3>
          <p>{error}</p>
          <button type="button" className="btn-secondary" onClick={loadHistory}>
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && filteredEvents.length === 0 && (
        <div className="state-box" data-testid="history-empty">
          <h3>No audit records found</h3>
          <p>
            {searchQuery
              ? `No logs matched your query "${searchQuery}".`
              : 'Audit events will appear here as scans and updates are executed.'}
          </p>
        </div>
      )}

      {!isLoading && !error && filteredEvents.length > 0 && (
        <div className="history-table-card">
          <table className="history-table" aria-label="Audit history records table">
            <thead>
              <tr>
                <th scope="col">Job / Event</th>
                <th scope="col">Target</th>
                <th scope="col">Status</th>
                <th scope="col">Operator</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map(evt => {
                const statusLower = evt.status.toLowerCase();
                const badgeClass =
                  statusLower === 'succeeded' || statusLower === 'approved'
                    ? 'succeeded'
                    : statusLower === 'failed'
                    ? 'failed'
                    : 'rejected';

                return (
                  <tr key={evt.id} data-testid={`history-row-${evt.id}`}>
                    <td>
                      <div className="event-title-cell">{evt.title}</div>
                      <div className="event-type-tag">
                        {evt.eventType} • {evt.id}
                      </div>
                    </td>
                    <td className="event-target-cell">{evt.target}</td>
                    <td>
                      <span className={`status-badge ${badgeClass}`} data-testid={`status-${evt.id}`}>
                        {evt.status} {evt.exitCode !== undefined && evt.exitCode !== null ? `(${evt.exitCode})` : ''}
                      </span>
                    </td>
                    <td>{evt.operator}</td>
                    <td style={{ color: 'var(--text-subtle)', fontSize: '12px' }}>{evt.timestamp}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default History;
