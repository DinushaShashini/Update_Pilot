import { apiClient } from './client';
import type { UpdateItem } from './updates';

export interface OverviewMetrics {
  totalApps: number;
  managedApps: number;
  unsupportedApps: number;
  pendingUpdatesCount: number;
  lastScanStatus: string;
  lastScanAt: string | null;
  agentStatus: 'ONLINE' | 'OFFLINE' | 'REVOKED' | string;
  agentHostname: string;
  recentActivity: Array<{
    id: string;
    eventType: string;
    title: string;
    description: string;
    timestamp: string;
    status?: string;
  }>;
  quickPendingUpdates: UpdateItem[];
}

export const defaultOverviewMetrics: OverviewMetrics = {
  totalApps: 0,
  managedApps: 0,
  unsupportedApps: 0,
  pendingUpdatesCount: 0,
  lastScanStatus: 'NEVER',
  lastScanAt: null,
  agentStatus: 'OFFLINE',
  agentHostname: '—',
  recentActivity: [],
  quickPendingUpdates: [],
};

export async function fetchOverviewMetrics(deviceId?: string): Promise<OverviewMetrics> {
  const endpoint = deviceId ? `/api/devices/${deviceId}/overview` : '/api/overview';
  try {
    const res = await apiClient.get<{ success?: boolean; data?: OverviewMetrics } | OverviewMetrics>(endpoint);
    if (res && typeof res === 'object' && 'data' in res && res.data) {
      return res.data;
    }
    return (res as OverviewMetrics) || defaultOverviewMetrics;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404 && deviceId) {
      const res = await apiClient.get<{ success?: boolean; data?: OverviewMetrics }>(`/api/v1/devices/${deviceId}/overview`);
      return res.data || defaultOverviewMetrics;
    }
    throw err;
  }
}
