import React, { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const navItems: NavItem[] = [
  { path: '/', label: 'Overview', icon: '📊' },
  { path: '/applications', label: 'Applications', icon: '📦' },
  { path: '/updates', label: 'Updates', icon: '⚡' },
  { path: '/history', label: 'History', icon: '📜' },
  { path: '/settings', label: 'Settings', icon: '⚙️' },
];

export const Layout: React.FC = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const location = useLocation();
  const userMenuRef = useRef<HTMLDivElement>(null);

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
            <span className="status-dot" aria-hidden="true"></span>
            <div className="device-status-text">
              <span className="device-name">DESKTOP-WIN11</span>
              <span className="device-state">Agent Online</span>
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
              ☰
            </button>
            <div className="topbar-brand-indicator">UpdatePilot Console</div>
          </div>

          <div className="topbar-actions">
            {/* Placeholder User Menu */}
            <div className="user-menu-container" ref={userMenuRef}>
              <button
                className="user-menu-btn"
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                aria-expanded={userMenuOpen}
                aria-haspopup="true"
                aria-label="User account menu"
              >
                <div className="user-avatar" aria-hidden="true">
                  DS
                </div>
                <div className="user-meta">
                  <span className="user-name">Dinusha S.</span>
                  <span className="user-role">Administrator</span>
                </div>
                <span className="chevron-icon" aria-hidden="true">
                  ▾
                </span>
              </button>

              {userMenuOpen && (
                <div className="user-dropdown-menu" role="menu">
                  <div className="user-dropdown-header">
                    <p className="user-dropdown-name">Dinusha S.</p>
                    <p className="user-dropdown-email">dinusha@updatepilot.local</p>
                  </div>
                  <ul className="dropdown-items">
                    <li role="none">
                      <a
                        href="#profile"
                        role="menuitem"
                        className="dropdown-link"
                        onClick={(e) => {
                          e.preventDefault();
                          setUserMenuOpen(false);
                        }}
                      >
                        Profile & Account
                      </a>
                    </li>
                    <li role="none">
                      <a
                        href="#preferences"
                        role="menuitem"
                        className="dropdown-link"
                        onClick={(e) => {
                          e.preventDefault();
                          setUserMenuOpen(false);
                        }}
                      >
                        System Preferences
                      </a>
                    </li>
                    <li className="dropdown-divider" role="separator"></li>
                    <li role="none">
                      <button
                        role="menuitem"
                        className="dropdown-link logout-link"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        Sign Out
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
