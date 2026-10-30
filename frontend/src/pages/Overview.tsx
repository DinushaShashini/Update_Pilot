import React from 'react';
import { Link } from 'react-router-dom';

export const Overview: React.FC = () => {
  return (
    <div>
      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Total Applications</div>
          <div className="stat-value">42</div>
          <div className="stat-desc">WinGet + ARP inventory detected</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Updates Available</div>
          <div className="stat-value" style={{ color: '#38bdf8' }}>4</div>
          <div className="stat-desc">Security & version patches ready</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Device Health</div>
          <div className="stat-value" style={{ color: '#10b981' }}>100%</div>
          <div className="stat-desc">1 of 1 agents connected</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Last Fleet Scan</div>
          <div className="stat-value" style={{ fontSize: '20px', marginTop: '6px' }}>25m ago</div>
          <div className="stat-desc">Job #SJ-2026-1039 (succeeded)</div>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-header">
          <div className="panel-title">Pending Updates Summary</div>
          <Link to="/updates" className="btn btn-primary" style={{ textDecoration: 'none' }}>
            Review Updates →
          </Link>
        </div>
        <p style={{ color: '#94a3b8', fontSize: '14px', marginBottom: '16px' }}>
          4 packages have newer versions discovered during the latest probe:
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[
            { id: '7zip.7zip', name: '7-Zip', current: '23.01', target: '24.09' },
            { id: 'Git.Git', name: 'Git', current: '2.43.0', target: '2.47.1' },
            { id: 'Notepad++.Notepad++', name: 'Notepad++', current: '8.6.0', target: '8.7.1' },
            { id: 'VideoLAN.VLC', name: 'VLC media player', current: '3.0.19', target: '3.0.21' },
          ].map((pkg) => (
            <div
              key={pkg.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '12px 16px',
                background: '#111827',
                borderRadius: '6px',
                border: '1px solid #334155',
              }}
            >
              <div>
                <strong style={{ color: '#f8fafc' }}>{pkg.name}</strong>
                <span style={{ color: '#64748b', fontSize: '12px', marginLeft: '10px' }}>
                  {pkg.id}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <span style={{ color: '#94a3b8', fontSize: '13px' }}>v{pkg.current}</span>
                <span style={{ color: '#38bdf8' }}>→</span>
                <span className="badge badge-warning">v{pkg.target}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
