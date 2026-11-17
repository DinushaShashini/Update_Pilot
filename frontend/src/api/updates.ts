import { apiClient } from './client';
import type { ScanJob } from './scans';

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
  matchStatus?: 'matched' | 'ambiguous' | 'unsupported' | 'pending';
  matchReason?: string | null;
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

export async function triggerUpdateCheck(deviceId?: string): Promise<{ jobId: string; status: string; isExisting?: boolean }> {
  const endpoint = deviceId ? `/api/devices/${deviceId}/update-checks` : '/api/update-checks';
  try {
    const res = await apiClient.post<{
      success: boolean;
      data?: {
        job?: { id?: string; status?: string };
        id?: string;
      };
    }>(endpoint);

    const job = res.data?.job;
    const jobId = job?.id || res.data?.id || '';
    return {
      jobId,
      status: job?.status || 'queued',
      isExisting: false,
    };
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null) {
      const e = err as {
        status?: number;
        code?: string;
        existingJobId?: string;
        details?: Array<{ existingJobId?: string; status?: string }>;
        data?: { error?: { existingJobId?: string; status?: string } };
        response?: { data?: { error?: { existingJobId?: string; status?: string } } };
      };

      if (e.status === 409 || e.code === 'ACTIVE_JOB_EXISTS') {
        const existingJobId =
          e.existingJobId ||
          e.details?.[0]?.existingJobId ||
          e.data?.error?.existingJobId ||
          e.response?.data?.error?.existingJobId;
        const status =
          e.details?.[0]?.status ||
          e.data?.error?.status ||
          e.response?.data?.error?.status ||
          'running';
        if (existingJobId) {
          return {
            jobId: existingJobId,
            status,
            isExisting: true,
          };
        }
      }
    }
    throw err;
  }
}

export async function fetchUpdateCheckJob(deviceId: string, jobId: string): Promise<ScanJob> {
  const res = await apiClient.get<{ success: boolean; data: { job: ScanJob } }>(
    `/api/devices/${deviceId}/update-checks/${jobId}`
  );
  return res.data?.job;
}

export async function fetchLatestUpdateCheckJob(deviceId: string): Promise<ScanJob | null> {
  try {
    const res = await apiClient.get<{ success: boolean; data: { job: ScanJob } }>(
      `/api/devices/${deviceId}/update-checks/latest`
    );
    return res.data?.job || null;
  } catch {
    return null;
  }
}

