import React, { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { fetchDevicesList, type Device } from '../api/devices';

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  {
    path: '/',
    label: 'Overview',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7"></rect>
        <rect x="14" y="3" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect>
        <rect x="3" y="14" width="7" height="7"></rect>
      </svg>
    ),
  },
  {
    path: '/applications',
    label: 'Applications',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
        <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
        <line x1="12" y1="22.08" x2="12" y2="12"></line>
      </svg>
    ),
  },
  {
    path: '/updates',
    label: 'Updates',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
      </svg>
    ),
  },
  {
    path: '/history',
    label: 'History',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      </svg>
    ),
  },
  {
    path: '/settings',
    label: 'Settings',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    ),
  },
];

export const Layout: React.FC = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [device, setDevice] = useState<Device | null>(null);
  const { user, logout } = useAuth();
  const location = useLocation();
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Fetch registered device dynamically
  useEffect(() => {
    let isMounted = true;
    const loadDevice = async () => {
      try {
        const list = await fetchDevicesList();
        if (isMounted && list && list.length > 0) {
          setDevice(list[0]);
        }
      } catch {
        // Fallback gracefully
      }
    };
    loadDevice();
    const interval = setInterval(loadDevice, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  // Close user dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  return (
    <div className="app-layout">
      {/* Mobile Backdrop Overlay */}
      {mobileMenuOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Semantic Sidebar */}
      <aside
        className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`}
        aria-label="Primary Navigation"
      >
        <div className="sidebar-header">
          <div className="logo-badge" aria-hidden="true">
            UP
          </div>
          <div className="logo-text">
            <span className="logo-title">UpdatePilot</span>
            <span className="logo-subtitle">Fleet Manager</span>
          </div>
          <button
            className="mobile-close-btn"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close navigation menu"
          >
            ✕
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Main Menu">
          <ul className="nav-list">
            {navItems.map((item) => (
              <li key={item.path} className="nav-list-item">
                <NavLink
                  to={item.path}
                  end={item.path === '/'}
                  className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
                >
                  <span className="nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <footer className="sidebar-footer">
          <div className="device-status-pill">
            <span
              className="status-dot"
              aria-hidden="true"
              style={{
                backgroundColor:
                  device?.status === 'ONLINE'
                    ? 'var(--success)'
                    : device?.status === 'REVOKED'
                    ? 'var(--danger)'
                    : 'var(--text-subtle)',
              }}
            ></span>
            <div className="device-status-text">
              <span className="device-name">{device?.hostname || device?.name || 'No Device'}</span>
              <span className="device-state">
                {device?.status === 'ONLINE'
                  ? 'Agent Online'
                  : device?.status === 'REVOKED'
                  ? 'Revoked'
                  : device
                  ? 'Agent Offline'
                  : 'Not Connected'}
              </span>
            </div>
          </div>
        </footer>
      </aside>

      {/* Main Wrapper */}
      <div className="main-wrapper">
        {/* Semantic Header */}
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="menu-toggle-btn"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Open navigation menu"
              aria-expanded={mobileMenuOpen}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </button>
            <div className="topbar-brand-indicator">UpdatePilot Console</div>
          </div>

          <div className="topbar-actions">
            {/* Dynamic User Menu */}
            <div className="user-menu-container" ref={userMenuRef}>
              <button
                className="user-menu-btn"
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                aria-expanded={userMenuOpen}
                aria-haspopup="true"
                aria-label="User account menu"
              >
                <div className="user-avatar" aria-hidden="true">
                  {(user?.name || user?.email || 'Admin').substring(0, 2).toUpperCase()}
                </div>
                <div className="user-meta">
                  <span className="user-name">{user?.name || user?.email?.split('@')[0] || 'Administrator'}</span>
                  <span className="user-role">{user?.role || 'Administrator'}</span>
                </div>
                <span className="chevron-icon" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </span>
              </button>

              {userMenuOpen && (
                <div className="user-dropdown-menu" role="menu">
                  <div className="user-dropdown-header">
                    <p className="user-dropdown-name">{user?.name || 'Administrator'}</p>
                    <p className="user-dropdown-email">{user?.email || 'admin@updatepilot.local'}</p>
                  </div>
                  <ul className="dropdown-items">
                    <li role="none">
                      <a
                        href="/settings"
                        role="menuitem"
                        className="dropdown-link"
                        onClick={(e) => {
                          e.preventDefault();
                          setUserMenuOpen(false);
                          window.location.href = '/settings';
                        }}
                      >
                        Device Settings
                      </a>
                    </li>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="dropdown-link logout-btn"
                        style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer' }}
                        onClick={async () => {
                          setUserMenuOpen(false);
                          await logout();
                        }}
                      >
                        Sign out
                      </button>
                    </li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Semantic Content Area */}
        <main className="content-container" id="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
