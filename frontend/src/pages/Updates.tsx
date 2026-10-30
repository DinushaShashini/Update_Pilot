import React, { useState } from 'react';

export const Updates: React.FC = () => {
  const [selected, setSelected] = useState<string[]>(['7zip.7zip', 'Git.Git']);

  const toggleSelect = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  return (
    <div>
      <div className="panel-card">
        <div className="panel-header">
          <div>
            <div className="panel-title">Available Package Updates</div>
            <div style={{ fontSize: '13px', color: '#94a3b8', marginTop: '2px' }}>
              Select packages to preview and dispatch update jobs to the agent
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn btn-primary"
              disabled={selected.length === 0}
              style={{ opacity: selected.length === 0 ? 0.5 : 1 }}
            >
              Update Selected ({selected.length})
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {[
            {
              id: '7zip.7zip',
              name: '7-Zip',
              current: '23.01',
              target: '24.09',
              source: 'winget',
              sourceUrl: 'https://www.7-zip.org/a/7z2409-x64.exe',
            },
            {
              id: 'Git.Git',
              name: 'Git',
              current: '2.43.0',
              target: '2.47.1',
              source: 'winget',
              sourceUrl: 'https://github.com/git-for-windows/git/releases',
            },
            {
              id: 'Notepad++.Notepad++',
              name: 'Notepad++',
              current: '8.6.0',
              target: '8.7.1',
              source: 'winget',
              sourceUrl: 'https://github.com/notepad-plus-plus/notepad-plus-plus/releases',
            },
            {
              id: 'VideoLAN.VLC',
              name: 'VLC media player',
              current: '3.0.19',
              target: '3.0.21',
              source: 'winget',
              sourceUrl: 'https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe',
            },
          ].map((item) => {
            const isChecked = selected.includes(item.id);
            return (
              <div
                key={item.id}
                onClick={() => toggleSelect(item.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '16px 20px',
                  background: isChecked ? 'rgba(2, 132, 199, 0.08)' : '#111827',
                  border: `1px solid ${isChecked ? '#0284c7' : '#334155'}`,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => {}} // Handled by container onClick
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: '#f8fafc', fontSize: '15px' }}>
                      {item.name}
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', fontFamily: 'monospace' }}>
                      {item.id} • Source: {item.source}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>Current → Target</div>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>
                      <span style={{ color: '#94a3b8' }}>{item.current}</span>
                      <span style={{ margin: '0 6px', color: '#38bdf8' }}>→</span>
                      <span style={{ color: '#10b981' }}>{item.target}</span>
                    </div>
                  </div>
                  <button
                    className="btn btn-outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      alert(`Preview update details for ${item.name}`);
                    }}
                    style={{ fontSize: '12px', padding: '6px 12px' }}
                  >
                    Preview
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
