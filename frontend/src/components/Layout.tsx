import React from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

const navItems = [
  { path: '/', label: 'Overview', icon: '📊' },
  { path: '/applications', label: 'Applications', icon: '📦' },
  { path: '/updates', label: 'Updates', icon: '⚡' },
  { path: '/history', label: 'History', icon: '📜' },
  { path: '/settings', label: 'Settings', icon: '⚙️' },
];

export const Layout: React.FC = () => {
  const location = useLocation();
  const currentNav = navItems.find((item) => item.path === location.pathname) || {
    label: 'Dashboard',
  };

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo-badge">UP</div>
          <div>
            <div className="logo-title">UpdatePilot</div>
            <div className="logo-subtitle">Fleet Agent Manager</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              className={({ isActive }) =>
                isActive ? 'nav-link active' : 'nav-link'
              }
            >
              <span style={{ fontSize: '16px' }}>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="device-status-pill">
            <span className="status-dot"></span>
            <div>
              <div style={{ fontWeight: 600, color: '#f8fafc' }}>DESKTOP-WIN11</div>
              <div style={{ fontSize: '11px', color: '#94a3b8' }}>Agent Online (12s ago)</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-wrapper">
        <header className="topbar">
          <h1 className="page-title">{currentNav.label}</h1>
          <div className="topbar-actions">
            <span className="badge badge-info">Agent v0.1.0</span>
            <button className="btn btn-outline" style={{ fontSize: '12px' }}>
              🔄 Quick Scan
            </button>
          </div>
        </header>

        <main className="content-container">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
