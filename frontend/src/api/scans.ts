import { apiClient } from './client';

export interface ScanJob {
  id: string;
  deviceId: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | string;
  progressPercent: number;
  progressStep: string | null;
  progressMessage?: string | null;
  skippedSteps?: string[];
  appCount: number;
  matchedCount?: number;
  ambiguousCount?: number;
  unsupportedCount?: number;
  errorCode?: number | null;
  errorMessage?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface TriggerScanResult {
  jobId: string;
  status: string;
  isExisting?: boolean;
}

export async function triggerScanJob(deviceId?: string): Promise<TriggerScanResult> {
  const endpoint = deviceId ? `/api/devices/${deviceId}/scans` : '/api/scans';
  try {
    const res = await apiClient.post<{
      success: boolean;
      data?: {
        job?: { id?: string; status?: string };
        id?: string;
        scan_id?: string;
      };
    }>(endpoint);

    const job = res.data?.job;
    const jobId = job?.id || res.data?.id || res.data?.scan_id || '';
    return {
      jobId,
      status: job?.status || 'queued',
      isExisting: false,
    };
  } catch (err: unknown) {
    // Handle 409 Conflict with active job
    if (typeof err === 'object' && err !== null) {
      const e = err as {
        status?: number;
        code?: string;
        details?: Array<{ existingJobId?: string; status?: string }>;
        existingJobId?: string;
        data?: { error?: { existingJobId?: string; status?: string } };
        response?: { data?: { error?: { existingJobId?: string; status?: string } } };
      };

      if (e.status === 409 || e.code === 'ACTIVE_SCAN_EXISTS') {
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

export async function fetchScanJob(deviceId: string, jobId: string): Promise<ScanJob> {
  const res = await apiClient.get<{ success: boolean; data: { job: ScanJob } }>(
    `/api/devices/${deviceId}/scans/${jobId}`
  );
  return res.data?.job;
}

export async function fetchLatestScanJob(deviceId: string): Promise<ScanJob | null> {
  try {
    const res = await apiClient.get<{ success: boolean; data: { job: ScanJob } }>(
      `/api/devices/${deviceId}/scans/latest`
    );
    return res.data?.job || null;
  } catch {
    return null;
  }
}
