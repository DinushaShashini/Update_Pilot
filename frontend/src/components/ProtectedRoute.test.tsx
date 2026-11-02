import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import * as AuthContextModule from '../auth/AuthContext';

describe('ProtectedRoute & Route Redirects', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading screen while session status is loading', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      user: null,
      status: 'loading',
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<div>Protected Dashboard</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('auth-loading')).toBeDefined();
    expect(screen.getByText(/Restoring session.../i)).toBeDefined();
    expect(screen.queryByText('Protected Dashboard')).toBeNull();
  });

  it('redirects unauthenticated users to /login remembering target path in router state', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      user: null,
      status: 'unauthenticated',
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/applications']}>
        <Routes>
          <Route path="/login" element={<div>Login Page Form</div>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/applications" element={<div>Applications View</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText('Login Page Form')).toBeDefined();
    expect(screen.queryByText('Applications View')).toBeNull();
  });

  it('renders protected page when authenticated', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      user: { id: 'u1', email: 'admin@updatepilot.local' },
      status: 'authenticated',
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/updates']}>
        <Routes>
          <Route path="/login" element={<div>Login Page Form</div>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/updates" element={<div>Updates Content Area</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText('Updates Content Area')).toBeDefined();
    expect(screen.queryByText('Login Page Form')).toBeNull();
  });

  it('redirects authenticated user opening /login to remembered path or Overview', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      user: { id: 'u1', email: 'admin@updatepilot.local' },
      status: 'authenticated',
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <MemoryRouter
        initialEntries={[{ pathname: '/login', state: { from: { pathname: '/history' } } }]}
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/history" element={<div>History View</div>} />
          <Route path="/" element={<div>Overview View</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText('History View')).toBeDefined();
    expect(screen.queryByRole('heading', { name: /Sign In to UpdatePilot/i })).toBeNull();
  });

  it('renders NotFoundPage when route does not match any known paths', () => {
    render(
      <MemoryRouter initialEntries={['/non-existent-route']}>
        <Routes>
          <Route path="/" element={<div>Overview</div>} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('not-found-page')).toBeDefined();
    expect(screen.getByText('404')).toBeDefined();
    expect(screen.getByText('Page Not Found')).toBeDefined();
    expect(screen.getByRole('link', { name: /Return to Overview/i })).toBeDefined();
  });
});
