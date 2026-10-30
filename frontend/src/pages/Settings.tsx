import React, { useState } from 'react';

export const Settings: React.FC = () => {
  const [pairingCode, setPairingCode] = useState('UP-8492-X9L1');
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(pairingCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRegenerate = () => {
    const randomCode = `UP-${Math.floor(1000 + Math.random() * 9000)}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    setPairingCode(randomCode);
  };

  return (
    <div>
      <div className="panel-card">
        <div className="panel-header">
          <div>
            <div className="panel-title">Agent Pairing & Device Onboarding</div>
            <div style={{ fontSize: '13px', color: '#94a3b8', marginTop: '2px' }}>
              Pair new Windows machines to this UpdatePilot management tenant
            </div>
          </div>
          <button className="btn btn-outline" onClick={handleRegenerate} style={{ fontSize: '12px' }}>
            Generate New Code
          </button>
        </div>

        <div style={{ background: '#111827', padding: '24px', borderRadius: '8px', border: '1px solid #334155', maxWidth: '520px' }}>
          <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
            One-Time Pairing Code (Expires in 14m 20s)
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <span style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'monospace', color: '#38bdf8', letterSpacing: '0.1em' }}>
              {pairingCode}
            </span>
            <button className="btn btn-primary" onClick={handleCopy} style={{ fontSize: '12px', padding: '6px 14px' }}>
              {copied ? 'Copied!' : 'Copy Code'}
            </button>
          </div>
          <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '16px' }}>
            Run the following command on the target Windows machine to enroll:
          </div>
          <pre
            style={{
              marginTop: '8px',
              padding: '10px 14px',
              background: '#0b0f19',
              borderRadius: '6px',
              border: '1px solid #1e293b',
              fontSize: '12px',
              color: '#10b981',
              overflowX: 'auto',
            }}
          >
            .\updatepilot-agent.exe pair --code {pairingCode} --server https://pilot.local
          </pre>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-header">
          <div className="panel-title">Connected Devices</div>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px',
            background: '#111827',
            borderRadius: '6px',
            border: '1px solid #334155',
          }}
        >
          <div>
            <div style={{ fontWeight: 600, color: '#f8fafc' }}>DESKTOP-WIN11</div>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>
              Host: Windows 11 Pro 23H2 • IP: 192.168.1.140 • Last heartbeat: 12 seconds ago
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <span className="badge badge-success">Active</span>
            <button
              className="btn btn-outline"
              style={{ fontSize: '12px', color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.4)' }}
              onClick={() => alert('Revoke agent credentials confirmation')}
            >
              Revoke
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
