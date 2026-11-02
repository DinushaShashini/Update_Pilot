import React, { useState, useRef } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { z } from 'zod';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email is required')
    .email('Please enter a valid email address')
    .toLowerCase(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must not exceed 128 characters'),
});

export type LoginFormData = z.infer<typeof loginSchema>;

export const LoginPage: React.FC = () => {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const fromLocation = (location.state as { from?: { pathname?: string } })?.from?.pathname || '/';

  if (status === 'authenticated') {
    return <Navigate to={fromLocation} replace />;
  }

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setServerError(null);
    setFieldErrors({});

    // Client-side Zod validation
    const result = loginSchema.safeParse({ email, password });

    if (!result.success) {
      const formattedErrors: { email?: string; password?: string } = {};
      const issues = result.error.issues;

      for (const issue of issues) {
        const field = issue.path[0] as 'email' | 'password';
        if (field && !formattedErrors[field]) {
          formattedErrors[field] = issue.message;
        }
      }

      setFieldErrors(formattedErrors);

      // Accessibility: move focus to first error field
      if (formattedErrors.email) {
        emailInputRef.current?.focus();
      } else if (formattedErrors.password) {
        passwordInputRef.current?.focus();
      }
      return;
    }

    setIsSubmitting(true);

    try {
      await login(result.data.email, result.data.password);
      navigate(fromLocation, { replace: true });
    } catch (err: unknown) {
      setIsSubmitting(false);

      if (err instanceof ApiError) {
        if (err.status === 401) {
          // Never reveal whether an email exists - always generic
          setServerError('Invalid email or password');
        } else if (err.status === 429) {
          const detail = err.details?.find(
            (d) => d.issue?.includes('seconds') || d.field === 'retry_after'
          );
          const retryMsg = detail?.issue ? ` (${detail.issue})` : '';
          setServerError(`Too many login attempts. Please try again later${retryMsg}.`);
        } else if (err.code === 'NETWORK_ERROR' || err.status === 0) {
          setServerError('Unable to connect to the server. Please check your network connection.');
        } else {
          setServerError(err.message || 'An unexpected error occurred. Please try again.');
        }
      } else {
        setServerError('Unable to connect to the server. Please check your network connection.');
      }

      // Move focus to first field or server error area
      emailInputRef.current?.focus();
    }
  };

  return (
    <div className="login-page-container">
      <main className="login-card" aria-labelledby="login-heading">
        <header className="login-header">
          <div className="login-logo" aria-hidden="true">
            <div className="logo-badge" style={{ width: '42px', height: '42px', fontSize: '18px' }}>
              UP
            </div>
          </div>
          <h1 id="login-heading" className="login-title">
            Sign In to UpdatePilot
          </h1>
          <p className="login-subtitle">Fleet Software & WinGet Update Manager</p>
        </header>

        {serverError && (
          <div
            role="alert"
            aria-live="assertive"
            className="login-alert-error"
            data-testid="login-server-error"
          >
            {serverError}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="login-form">
          <div className="form-group">
            <label htmlFor="email" className="form-label">
              Email Address
            </label>
            <input
              id="email"
              ref={emailInputRef}
              type="email"
              autoComplete="username"
              required
              aria-required="true"
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'email-error' : undefined}
              className={`form-input ${fieldErrors.email ? 'input-error' : ''}`}
              placeholder="admin@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isSubmitting}
            />
            {fieldErrors.email && (
              <span id="email-error" role="alert" className="field-error" data-testid="email-error">
                {fieldErrors.email}
              </span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="password" className="form-label">
              Password
            </label>
            <div className="input-wrapper">
              <input
                id="password"
                ref={passwordInputRef}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                aria-required="true"
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={fieldErrors.password ? 'password-error' : undefined}
                className={`form-input ${fieldErrors.password ? 'input-error' : ''}`}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                disabled={isSubmitting}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            {fieldErrors.password && (
              <span
                id="password-error"
                role="alert"
                className="field-error"
                data-testid="password-error"
              >
                {fieldErrors.password}
              </span>
            )}
          </div>

          <button
            type="submit"
            className="btn btn-primary submit-btn"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
            data-testid="login-submit-btn"
          >
            {isSubmitting ? (
              <>
                <span className="spinner-sm" aria-hidden="true" />
                <span>Signing in...</span>
              </>
            ) : (
              <span>Sign In</span>
            )}
          </button>
        </form>
      </main>
    </div>
  );
};

export default LoginPage;
