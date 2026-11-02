import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';
import { apiClient, authEvents, ApiError } from '../api/client';

const TestConsumer: React.FC = () => {
  const { user, status, login, logout } = useAuth();

  return (
    <div>
      <div data-testid="status">{status}</div>
      <div data-testid="user">{user ? user.email : 'none'}</div>
      <button
        data-testid="login-btn"
        onClick={() => login('admin@updatepilot.local', 'password123')}
      >
        Login
      </button>
      <button data-testid="logout-btn" onClick={() => logout()}>
        Logout
      </button>
    </div>
  );
};

describe('AuthContext & useAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('restores session when GET /api/me succeeds', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      success: true,
      data: {
        user: {
          id: 'user-123',
          email: 'admin@updatepilot.local',
          name: 'Admin User',
          role: 'ADMIN',
        },
      },
    });

    render(
      <AuthProvider showLoadingScreen={false}>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('user').textContent).toBe('admin@updatepilot.local');
    expect(apiClient.get).toHaveBeenCalledWith('/api/me');
  });

  it('sets status to unauthenticated when GET /api/me fails (no session)', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHORIZED', 'Session expired')
    );

    render(
      <AuthProvider showLoadingScreen={false}>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
    });
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  it('shows loading screen while session is being restored when showLoadingScreen is true', async () => {
    let resolveGetMe: (val: unknown) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolveGetMe = resolve;
    });

    vi.spyOn(apiClient, 'get').mockReturnValueOnce(
      pendingPromise as unknown as Promise<Record<string, unknown>>
    );

    render(
      <AuthProvider showLoadingScreen={true}>
        <TestConsumer />
      </AuthProvider>
    );

    expect(screen.getByTestId('auth-loading')).toBeDefined();
    expect(screen.getByText('Restoring session...')).toBeDefined();

    await act(async () => {
      resolveGetMe({
        success: true,
        data: { user: { id: 'user-1', email: 'test@example.com' } },
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('auth-loading')).toBeNull();
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });
  });

  it('logs in successfully and updates state to authenticated', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHORIZED', 'No session')
    );
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      success: true,
      data: {
        user: { id: 'user-456', email: 'login@example.com', role: 'USER' },
      },
    });

    render(
      <AuthProvider showLoadingScreen={false}>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
    });

    await act(async () => {
      screen.getByTestId('login-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
      expect(screen.getByTestId('user').textContent).toBe('login@example.com');
    });
    expect(apiClient.post).toHaveBeenCalledWith('/api/auth/login', {
      email: 'admin@updatepilot.local',
      password: 'password123',
    });
  });

  it('logs out successfully and resets state to unauthenticated', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      success: true,
      data: { user: { id: 'user-789', email: 'logout@example.com' } },
    });
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      success: true,
      data: { message: 'Logged out' },
    });

    render(
      <AuthProvider showLoadingScreen={false}>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await act(async () => {
      screen.getByTestId('logout-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
      expect(screen.getByTestId('user').textContent).toBe('none');
    });
    expect(apiClient.post).toHaveBeenCalledWith('/api/auth/logout');
  });

  it('resets state to unauthenticated when unauthorized event is emitted', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      success: true,
      data: { user: { id: 'user-999', email: 'active@example.com' } },
    });

    render(
      <AuthProvider showLoadingScreen={false}>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    act(() => {
      authEvents.emitUnauthorized();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
      expect(screen.getByTestId('user').textContent).toBe('none');
    });
  });
});
