import { apiClient } from './client';

export interface Application {
  id: string;
  deviceId?: string;
  name: string;
  packageId?: string | null;
  installedVersion: string;
  availableVersion?: string | null;
  source?: string | null;
  isManaged: boolean;
  lastScannedAt?: string | null;
  description?: string | null;
  publisher?: string | null;
}

export interface ApplicationsFilterParams {
  search?: string;
  status?: 'all' | 'update_available' | 'managed' | 'unsupported';
  source?: 'all' | 'winget' | 'msstore' | 'local';
  page?: number;
  limit?: number;
}

export interface ApplicationsResponse {
  success: boolean;
  data: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    applications: Application[];
  };
}

export async function fetchApplications(
  deviceId?: string,
  params?: ApplicationsFilterParams
): Promise<ApplicationsResponse['data']> {
  const queryParams: Record<string, string | number> = {};
  if (params?.search) queryParams.search = params.search;
  if (params?.status && params.status !== 'all') queryParams.status = params.status;
  if (params?.source && params.source !== 'all') queryParams.source = params.source;
  if (params?.page) queryParams.page = params.page;
  if (params?.limit) queryParams.limit = params.limit;

  const endpoint = deviceId
    ? `/api/devices/${deviceId}/applications`
    : '/api/applications';

  try {
    const res = await apiClient.get<ApplicationsResponse | { data: Application[] } | Application[]>(
      endpoint,
      { params: queryParams }
    );

    if (Array.isArray(res)) {
      return {
        total: res.length,
        page: 1,
        limit: res.length || 10,
        totalPages: 1,
        applications: res,
      };
    }

    if (res && typeof res === 'object') {
      if ('data' in res && res.data && 'applications' in (res.data as Record<string, unknown>)) {
        return (res as ApplicationsResponse).data;
      }
      if ('data' in res && Array.isArray((res as { data: Application[] }).data)) {
        const arr = (res as { data: Application[] }).data;
        return {
          total: arr.length,
          page: 1,
          limit: arr.length || 10,
          totalPages: 1,
          applications: arr,
        };
      }
    }

    return {
      total: 0,
      page: 1,
      limit: 10,
      totalPages: 1,
      applications: [],
    };
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404 && deviceId) {
      // Fallback for v1 route
      const fallbackEndpoint = `/api/v1/devices/${deviceId}/applications`;
      const res = await apiClient.get<ApplicationsResponse>(fallbackEndpoint, { params: queryParams });
      return res.data;
    }
    throw err;
  }
}

export async function triggerScan(deviceId?: string): Promise<{ success: boolean; scanId?: string }> {
  const endpoint = deviceId ? `/api/devices/${deviceId}/scans` : '/api/scans';
  try {
    const res = await apiClient.post<{ success: boolean; data?: { id?: string; scan_id?: string } }>(endpoint);
    return {
      success: true,
      scanId: res.data?.id || res.data?.scan_id,
    };
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404 && deviceId) {
      const res = await apiClient.post<{ success: boolean; data?: { id?: string } }>(`/api/v1/devices/${deviceId}/scans`);
      return { success: true, scanId: res.data?.id };
    }
    throw err;
  }
}
