export interface FieldError {
  field?: string;
  issue?: string;
}

export interface ApiErrorPayload {
  success: false;
  error: {
    code: string;
    message: string;
    details?: FieldError[];
    trace_id?: string;
    timestamp?: string;
  };
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: FieldError[];
  public readonly traceId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: FieldError[],
    traceId?: string
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.traceId = traceId;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// Centralized event listener system for unauthorized responses
type AuthEventListener = () => void;

class AuthEventEmitter {
  private listeners: Set<AuthEventListener> = new Set();

  public subscribe(listener: AuthEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emitUnauthorized(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Prevent listener failures from bubbling
      }
    }
  }
}

export const authEvents = new AuthEventEmitter();

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined | null>;
}

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    const envUrl =
      typeof import.meta !== 'undefined' && import.meta.env
        ? (import.meta.env.VITE_API_URL as string | undefined)
        : undefined;
    this.baseUrl = (baseUrl ?? envUrl ?? '').replace(/\/+$/, '');
  }

  public async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { body, params, headers, ...customConfig } = options;

    let url = endpoint.startsWith('http')
      ? endpoint
      : `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null) {
          searchParams.append(key, String(val));
        }
      }
      const queryString = searchParams.toString();
      if (queryString) {
        url += `${url.includes('?') ? '&' : '?'}${queryString}`;
      }
    }

    const requestHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...((headers as Record<string, string>) || {}),
    };

    let serializedBody: string | undefined;
    if (body !== undefined && body !== null) {
      requestHeaders['Content-Type'] = 'application/json';
      serializedBody = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const config: RequestInit = {
      credentials: 'include',
      headers: requestHeaders,
      ...customConfig,
      body: serializedBody,
    };

    let response: Response;
    try {
      response = await fetch(url, config);
    } catch {
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        'Unable to connect to the server. Please check your network connection.'
      );
    }

    // Centrally emit unauthorized event on 401
    if (response.status === 401) {
      authEvents.emitUnauthorized();
    }

    let responseData: unknown = null;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      try {
        responseData = await response.json();
      } catch {
        responseData = null;
      }
    } else {
      responseData = await response.text();
    }

    if (!response.ok) {
      // Parse standard error envelope if present
      if (
        responseData &&
        typeof responseData === 'object' &&
        'error' in responseData &&
        typeof (responseData as Record<string, unknown>).error === 'object'
      ) {
        const errorObj = (responseData as ApiErrorPayload).error;
        throw new ApiError(
          response.status,
          errorObj.code || 'API_ERROR',
          errorObj.message || response.statusText || 'Request failed',
          errorObj.details,
          errorObj.trace_id
        );
      }

      throw new ApiError(
        response.status,
        response.status === 401 ? 'UNAUTHORIZED' : 'API_ERROR',
        typeof responseData === 'string' && responseData
          ? responseData
          : response.statusText || `Request failed with status ${response.status}`
      );
    }

    return responseData as T;
  }

  public get<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  public post<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'POST', body });
  }

  public put<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'PUT', body });
  }

  public delete<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }
}

export const apiClient = new ApiClient();
