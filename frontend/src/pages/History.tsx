import React from 'react';

export const History: React.FC = () => {
  return (
    <div>
      <div className="panel-card">
        <div className="panel-header">
          <div>
            <div className="panel-title">Job Execution History</div>
            <div style={{ fontSize: '13px', color: '#94a3b8', marginTop: '2px' }}>
              Audit trail of all background scan and update operations
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-outline" style={{ fontSize: '13px' }}>
              Filter by Type
            </button>
            <button className="btn btn-outline" style={{ fontSize: '13px' }}>
              Export CSV
            </button>
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8' }}>
              <th style={{ padding: '10px 12px' }}>Job ID</th>
              <th style={{ padding: '10px 12px' }}>Type</th>
              <th style={{ padding: '10px 12px' }}>Target</th>
              <th style={{ padding: '10px 12px' }}>Versions</th>
              <th style={{ padding: '10px 12px' }}>Status</th>
              <th style={{ padding: '10px 12px' }}>Exit Code</th>
              <th style={{ padding: '10px 12px' }}>Time</th>
            </tr>
          </thead>
          <tbody>
            {[
              {
                id: 'UJ-2026-0814',
                type: 'UPDATE',
                target: 'Git.Git',
                versions: '2.42.0 → 2.43.0',
                status: 'succeeded',
                exitCode: '0',
                time: '2 hours ago',
              },
              {
                id: 'SJ-2026-1039',
                type: 'SCAN',
                target: 'DESKTOP-WIN11',
                versions: 'Full inventory',
                status: 'succeeded',
                exitCode: '0',
                time: '25 mins ago',
              },
              {
                id: 'UJ-2026-0792',
                type: 'UPDATE',
                target: 'VideoLAN.VLC',
                versions: '3.0.18 → 3.0.19',
                status: 'succeeded',
                exitCode: '0',
                time: '1 day ago',
              },
              {
                id: 'UJ-2026-0641',
                type: 'UPDATE',
                target: 'SomeApp.Broken',
                versions: '1.0.0 → 1.1.0',
                status: 'failed',
                exitCode: '1603 (Fatal)',
                time: '3 days ago',
              },
            ].map((job) => (
              <tr key={job.id} style={{ borderBottom: '1px solid #1e293b' }}>
                <td style={{ padding: '12px', fontFamily: 'monospace', color: '#38bdf8' }}>{job.id}</td>
                <td style={{ padding: '12px' }}>
                  <span className="badge badge-info">{job.type}</span>
                </td>
                <td style={{ padding: '12px', fontWeight: 500, color: '#f8fafc' }}>{job.target}</td>
                <td style={{ padding: '12px', color: '#94a3b8' }}>{job.versions}</td>
                <td style={{ padding: '12px' }}>
                  {job.status === 'succeeded' ? (
                    <span className="badge badge-success">Succeeded</span>
                  ) : (
                    <span className="badge badge-warning" style={{ color: '#ef4444' }}>Failed</span>
                  )}
                </td>
                <td style={{ padding: '12px', fontFamily: 'monospace', color: job.exitCode.includes('0') ? '#10b981' : '#ef4444' }}>
                  {job.exitCode}
                </td>
                <td style={{ padding: '12px', color: '#64748b' }}>{job.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
