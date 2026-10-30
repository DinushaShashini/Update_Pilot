import React from 'react';

export const Applications: React.FC = () => {
  return (
    <div>
      <div className="panel-card">
        <div className="panel-header">
          <div className="panel-title">Installed Applications</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              placeholder="Search by name, package ID..."
              style={{
                background: '#111827',
                border: '1px solid #334155',
                color: '#fff',
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '13px',
                width: '260px',
              }}
            />
            <button className="btn btn-outline" style={{ fontSize: '13px' }}>
              Filter
            </button>
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8' }}>
              <th style={{ padding: '10px 12px' }}>Application</th>
              <th style={{ padding: '10px 12px' }}>Package ID</th>
              <th style={{ padding: '10px 12px' }}>Installed Version</th>
              <th style={{ padding: '10px 12px' }}>Source</th>
              <th style={{ padding: '10px 12px' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {[
              { name: '7-Zip 23.01', id: '7zip.7zip', ver: '23.01', src: 'winget', update: true },
              { name: 'Git', id: 'Git.Git', ver: '2.43.0', src: 'winget', update: true },
              { name: 'Google Chrome', id: 'Google.Chrome', ver: '131.0.6778.86', src: 'winget', update: false },
              { name: 'Notepad++', id: 'Notepad++.Notepad++', ver: '8.6.0', src: 'winget', update: true },
              { name: 'Visual Studio Code', id: 'Microsoft.VisualStudioCode', ver: '1.95.3', src: 'winget', update: false },
              { name: 'VLC media player', id: 'VideoLAN.VLC', ver: '3.0.19', src: 'winget', update: true },
            ].map((app) => (
              <tr key={app.id} style={{ borderBottom: '1px solid #1e293b' }}>
                <td style={{ padding: '12px', fontWeight: 600, color: '#f8fafc' }}>{app.name}</td>
                <td style={{ padding: '12px', fontFamily: 'monospace', color: '#94a3b8' }}>{app.id}</td>
                <td style={{ padding: '12px', color: '#cbd5e1' }}>{app.ver}</td>
                <td style={{ padding: '12px' }}>
                  <span className="badge badge-info">{app.src}</span>
                </td>
                <td style={{ padding: '12px' }}>
                  {app.update ? (
                    <span className="badge badge-warning">Update Available</span>
                  ) : (
                    <span className="badge badge-success">Up to Date</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
