import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient, ApiError, authEvents } from './client';

describe('ApiClient', () => {
  let client: ApiClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new ApiClient('http://localhost:3000');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('handles successful requests with credentials: "include"', async () => {
    const mockData = { success: true, data: { user: { id: '123', email: 'test@example.com' } } };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockData,
    } as unknown as Response);

    const result = await client.get('/api/me');

    expect(result).toEqual(mockData);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/me',
      expect.objectContaining({
        credentials: 'include',
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
  });

  it('turns standard API error into a typed ApiError with status, code, message, and details', async () => {
    const errorPayload = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
        details: [{ field: 'email', issue: 'Invalid email address' }],
        trace_id: 'trace_123',
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => errorPayload,
    } as unknown as Response);

    await expect(client.post('/api/auth/login', { email: 'bad' })).rejects.toThrow(ApiError);

    try {
      await client.post('/api/auth/login', { email: 'bad' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.code).toBe('VALIDATION_ERROR');
      expect(apiErr.message).toBe('Invalid request payload');
      expect(apiErr.details).toEqual([{ field: 'email', issue: 'Invalid email address' }]);
      expect(apiErr.traceId).toBe('trace_123');
    }
  });

  it('treats 401 response by emitting an unauthorized event and throwing ApiError', async () => {
    const unauthorizedListener = vi.fn();
    const unsubscribe = authEvents.subscribe(unauthorizedListener);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Session expired' },
      }),
    } as unknown as Response);

    try {
      await expect(client.get('/api/me')).rejects.toThrow(ApiError);
      expect(unauthorizedListener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('handles network failure with a friendly error and status 0', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(client.get('/api/overview')).rejects.toThrow(ApiError);

    try {
      await client.get('/api/overview');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(0);
      expect(apiErr.code).toBe('NETWORK_ERROR');
      expect(apiErr.message).toBe(
        'Unable to connect to the server. Please check your network connection.'
      );
    }
  });
});
