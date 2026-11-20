import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from './LoginPage';
import * as AuthContextModule from '../auth/AuthContext';
import { ApiError } from '../api/client';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ state: { from: { pathname: '/applications' } } }),
  };
});

describe('LoginPage Component', () => {
  const mockLogin = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockNavigate.mockReset();
    mockLogin.mockReset();

    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      user: null,
      status: 'unauthenticated',
      login: mockLogin,
      logout: vi.fn(),
    });
  });

  const renderLoginPage = () => {
    return render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
  };

  it('renders email and password inputs, labels, and submit button', () => {
    renderLoginPage();

    expect(screen.getByLabelText(/^Email Address$/i)).toBeDefined();
    expect(screen.getByLabelText(/^Password$/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Sign In$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Show password/i })).toBeDefined();
  });

  it('toggles password visibility with accessible button', () => {
    renderLoginPage();

    const passwordInput = screen.getByLabelText(/^Password$/i) as HTMLInputElement;
    const toggleBtn = screen.getByRole('button', { name: /Show password/i });

    expect(passwordInput.type).toBe('password');

    fireEvent.click(toggleBtn);
    expect(passwordInput.type).toBe('text');
    expect(screen.getByRole('button', { name: /Hide password/i })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Hide password/i }));
    expect(passwordInput.type).toBe('password');
  });

  it('validates client-side input with Zod and focuses the first error field', async () => {
    renderLoginPage();

    const submitBtn = screen.getByTestId('login-submit-btn');
    const emailInput = screen.getByLabelText(/^Email Address$/i);

    // Submit empty
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByTestId('email-error')).toBeDefined();
    });
    expect(document.activeElement).toBe(emailInput);
    expect(mockLogin).not.toHaveBeenCalled();

    // Invalid email
    fireEvent.change(emailInput, { target: { value: 'invalid-email' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Please enter a valid email address/i)).toBeDefined();
    });

    // Valid email, short password (< 8 chars)
    fireEvent.change(emailInput, { target: { value: 'valid@example.com' } });
    const passwordInput = screen.getByLabelText(/^Password$/i);
    fireEvent.change(passwordInput, { target: { value: 'short' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Password must be at least 8 characters/i)).toBeDefined();
    });
    expect(document.activeElement).toBe(passwordInput);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('submits valid data, enters loading state, and navigates upon success', async () => {
    mockLogin.mockResolvedValueOnce(undefined);
    renderLoginPage();

    const emailInput = screen.getByLabelText(/^Email Address$/i);
    const passwordInput = screen.getByLabelText(/^Password$/i);
    const submitBtn = screen.getByTestId('login-submit-btn');

    fireEvent.change(emailInput, { target: { value: 'admin@updatepilot.local' } });
    fireEvent.change(passwordInput, { target: { value: 'ValidPassword123!' } });

    fireEvent.click(submitBtn);

    expect(submitBtn.getAttribute('aria-busy')).toBe('true');
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Signing in.../i)).toBeDefined();

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('admin@updatepilot.local', 'ValidPassword123!');
      expect(mockNavigate).toHaveBeenCalledWith('/applications', { replace: true });
    });
  });

  it('shows generic "Invalid email or password" on 401 response without leaking email existence', async () => {
    mockLogin.mockRejectedValueOnce(new ApiError(401, 'INVALID_CREDENTIALS', 'Unauthorized'));
    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/^Email Address$/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^Password$/i), { target: { value: 'Password123!' } });

    fireEvent.click(screen.getByTestId('login-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('login-server-error').textContent).toBe(
        'Invalid email or password'
      );
    });

    expect(screen.getByTestId('login-submit-btn').hasAttribute('disabled')).toBe(false);
  });

  it('shows rate limit error on 429 response', async () => {
    mockLogin.mockRejectedValueOnce(
      new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Too Many Requests', [
        { field: 'retry_after', issue: 'retry in 60 seconds' },
      ])
    );
    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/^Email Address$/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^Password$/i), { target: { value: 'Password123!' } });

    fireEvent.click(screen.getByTestId('login-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('login-server-error').textContent).toContain(
        'Too many login attempts'
      );
      expect(screen.getByTestId('login-server-error').textContent).toContain('retry in 60 seconds');
    });
  });

  it('shows friendly error on network failure', async () => {
    mockLogin.mockRejectedValueOnce(
      new ApiError(
        0,
        'NETWORK_ERROR',
        'Unable to connect to the server. Please check your network connection.'
      )
    );
    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/^Email Address$/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^Password$/i), { target: { value: 'Password123!' } });

    fireEvent.click(screen.getByTestId('login-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('login-server-error').textContent).toContain(
        'Unable to connect to the server. Please check your network connection.'
      );
    });
  });
});
