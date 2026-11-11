import { apiClient } from './client';

export interface HistoryEvent {
  id: string;
  eventType: 'SCAN' | 'UPDATE' | 'APPROVAL' | 'REJECTION' | 'REVOCATION' | string;
  title: string;
  description?: string;
  target: string;
  status: 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'APPROVED' | 'IN_PROGRESS' | string;
  operator: string;
  timestamp: string;
  exitCode?: number | null;
}

export interface HistoryFilterParams {
  type?: string;
  status?: string;
  search?: string;
}

export async function fetchHistory(
  deviceId?: string,
  params?: HistoryFilterParams
): Promise<HistoryEvent[]> {
  const queryParams: Record<string, string> = {};
  if (params?.type && params.type !== 'all') queryParams.type = params.type;
  if (params?.status && params.status !== 'all') queryParams.status = params.status;
  if (params?.search) queryParams.search = params.search;

  const endpoint = deviceId ? `/api/devices/${deviceId}/history` : '/api/history';

  try {
    const res = await apiClient.get<{ success?: boolean; data?: HistoryEvent[] } | HistoryEvent[]>(
      endpoint,
      { params: queryParams }
    );
    if (Array.isArray(res)) return res;
    if (res && typeof res === 'object' && 'data' in res && Array.isArray(res.data)) {
      return res.data;
    }
    return [];
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404 && deviceId) {
      const res = await apiClient.get<{ success?: boolean; data?: HistoryEvent[] }>(
        `/api/v1/devices/${deviceId}/history`,
        { params: queryParams }
      );
      return res.data || [];
    }
    throw err;
  }
}
