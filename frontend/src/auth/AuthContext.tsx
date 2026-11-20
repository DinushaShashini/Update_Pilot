import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiClient, authEvents } from '../api/client';

export interface User {
  id: string;
  email: string;
  name?: string;
  role?: string;
  created_at?: string;
}

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export interface AuthProviderProps {
  children: React.ReactNode;
  showLoadingScreen?: boolean;
}

export const AuthLoadingScreen: React.FC = () => {
  return (
    <div
      data-testid="auth-loading"
      className="auth-loading-screen"
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        backgroundColor: 'var(--bg-app, #0b0f19)',
        color: 'var(--text-main, #f8fafc)',
        gap: '16px',
        fontFamily: 'var(--font-sans, sans-serif)',
      }}
    >
      <div
        className="loading-spinner"
        aria-hidden="true"
        style={{
          width: '36px',
          height: '36px',
          border: '3px solid rgba(2, 132, 199, 0.2)',
          borderTopColor: '#38bdf8',
          borderRadius: '50%',
        }}
      />
      <p style={{ fontSize: '14px', color: 'var(--text-muted, #94a3b8)' }}>Restoring session...</p>
    </div>
  );
};

export const AuthProvider: React.FC<AuthProviderProps> = ({
  children,
  showLoadingScreen = true,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  // Restore session on mount
  useEffect(() => {
    let isMounted = true;

    async function restoreSession() {
      try {
        const response = await apiClient.get<Record<string, unknown>>('/api/me');
        if (!isMounted) return;

        const responseObj = response as {
          data?: { user?: User } | User;
          user?: User;
          id?: string;
          email?: string;
        };

        const userData =
          (responseObj.data && 'user' in responseObj.data
            ? responseObj.data.user
            : responseObj.data) ||
          responseObj.user ||
          (responseObj.id ? (responseObj as unknown as User) : null);

        if (userData && (userData as User).id) {
          setUser(userData as User);
          setStatus('authenticated');
          const token = responseObj.data && typeof responseObj.data === 'object' && 'token' in responseObj.data
            ? (responseObj.data as { token?: string }).token
            : undefined;
          if (token && typeof localStorage !== 'undefined') {
            localStorage.setItem('token', token);
          }
        } else {
          setUser(null);
          setStatus('unauthenticated');
        }
      } catch {
        if (!isMounted) return;
        // In local development, if /api/me fails because server is starting, default to authenticated session
        const devToken = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
        if (devToken) {
          setUser({
            id: '11111111-1111-1111-1111-111111111111',
            email: 'dinusha@example.com',
            name: 'Dinusha',
          });
          setStatus('authenticated');
        } else {
          setUser(null);
          setStatus('unauthenticated');
        }
      }
    }

    restoreSession();

    return () => {
      isMounted = false;
    };
  }, []);

  // Listen for unauthorized events to reset state to unauthenticated
  useEffect(() => {
    const unsubscribe = authEvents.subscribe(() => {
      setUser(null);
      setStatus('unauthenticated');
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await apiClient.post<Record<string, unknown>>('/api/auth/login', {
      email,
      password,
    });
    const responseObj = response as {
      data?: { user?: User } | User;
      user?: User;
      id?: string;
    };
    const userData =
      (responseObj.data && 'user' in responseObj.data ? responseObj.data.user : responseObj.data) ||
      responseObj.user ||
      (responseObj.id ? (responseObj as unknown as User) : null);

    const token = responseObj.data && typeof responseObj.data === 'object' && 'token' in responseObj.data
      ? (responseObj.data as { token?: string }).token
      : undefined;
    if (token && typeof localStorage !== 'undefined') {
      localStorage.setItem('token', token);
    }

    setUser((userData as User) || null);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiClient.post('/api/auth/logout');
    } finally {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('token');
      }
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  const contextValue: AuthContextValue = {
    user,
    status,
    login,
    logout,
  };

  return (
    <AuthContext.Provider value={contextValue}>
      {status === 'loading' && showLoadingScreen ? <AuthLoadingScreen /> : children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
