import { apiClient } from './client';

export type UpdateStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'IN_PROGRESS'
  | 'SUCCEEDED'
  | 'FAILED';

export interface UpdateItem {
  id: string;
  deviceId?: string;
  deviceName?: string;
  packageId: string;
  name: string;
  currentVersion: string;
  targetVersion: string;
  source?: string;
  status: UpdateStatus;
  detectedAt?: string;
  approvedAt?: string;
  rejectedAt?: string;
}

interface ApiResponseEnvelope<T> {
  success?: boolean;
  data?: T;
}

export async function fetchPendingUpdates(deviceId?: string): Promise<UpdateItem[]> {
  const endpoint = deviceId
    ? `/api/devices/${deviceId}/updates/pending`
    : '/api/updates/pending';

  try {
    const res = await apiClient.get<ApiResponseEnvelope<UpdateItem[]> | UpdateItem[]>(endpoint);
    if (Array.isArray(res)) return res;
    if (res && typeof res === 'object' && 'data' in res && Array.isArray(res.data)) {
      return res.data;
    }
    return [];
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404 && deviceId) {
      const res = await apiClient.get<ApiResponseEnvelope<UpdateItem[]>>(`/api/v1/devices/${deviceId}/updates/pending`);
      return res.data || [];
    }
    throw err;
  }
}

export async function approveUpdate(updateId: string): Promise<UpdateItem> {
  try {
    const res = await apiClient.post<ApiResponseEnvelope<UpdateItem> | UpdateItem>(
      `/api/updates/${updateId}/approve`
    );
    if (res && typeof res === 'object' && 'data' in res && res.data) {
      return res.data;
    }
    return res as UpdateItem;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
      const res = await apiClient.post<ApiResponseEnvelope<UpdateItem>>(`/api/v1/updates/${updateId}/approve`);
      return res.data as UpdateItem;
    }
    throw err;
  }
}

export async function rejectUpdate(updateId: string, reason?: string): Promise<UpdateItem> {
  try {
    const res = await apiClient.post<ApiResponseEnvelope<UpdateItem> | UpdateItem>(
      `/api/updates/${updateId}/reject`,
      { reason: reason || 'Rejected by user' }
    );
    if (res && typeof res === 'object' && 'data' in res && res.data) {
      return res.data;
    }
    return res as UpdateItem;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
      const res = await apiClient.post<ApiResponseEnvelope<UpdateItem>>(`/api/v1/updates/${updateId}/reject`, { reason });
      return res.data as UpdateItem;
    }
    throw err;
  }
}
