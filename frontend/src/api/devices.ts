import { apiClient } from './client';

export interface Device {
  id: string;
  name: string;
  hostname: string;
  os: string;
  agentVersion: string;
  connectionStatus?: 'Online' | 'Offline' | 'Never connected' | 'Revoked' | string;
  status?: string;
  lastSeenAt: string | null;
  pairedAt?: string;
}

export interface PairingCodeResponse {
  pairing_token?: string;
  code?: string;
  token?: string;
  expires_at?: string;
  expires_in_seconds?: number;
  pairing_command?: string;
}

interface ApiResponseEnvelope<T> {
  success?: boolean;
  data?: T;
}

export async function generatePairingCode(): Promise<PairingCodeResponse> {
  try {
    const res = await apiClient.post<ApiResponseEnvelope<PairingCodeResponse> & PairingCodeResponse>(
      '/api/devices/pairing-token'
    );
    return res.data || res;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
      const res = await apiClient.post<ApiResponseEnvelope<PairingCodeResponse> & PairingCodeResponse>(
        '/api/v1/devices/pairing-token'
      );
      return res.data || res;
    }
    throw err;
  }
}

export async function fetchDevicesList(): Promise<Device[]> {
  try {
    const res = await apiClient.get<ApiResponseEnvelope<Device[]> | Device[]>(
      '/api/devices'
    );
    if (Array.isArray(res)) return res;
    if (res && typeof res === 'object' && 'data' in res && Array.isArray(res.data)) {
      return res.data;
    }
    return [];
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
      const res = await apiClient.get<ApiResponseEnvelope<Device[]> | Device[]>(
        '/api/v1/devices'
      );
      if (Array.isArray(res)) return res;
      if (res && typeof res === 'object' && 'data' in res && Array.isArray(res.data)) {
        return res.data;
      }
    }
    throw err;
  }
}

export async function revokeDevice(deviceId: string): Promise<void> {
  try {
    await apiClient.post(`/api/devices/${deviceId}/revoke`, { confirmation: 'REVOKE' });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
      await apiClient.post(`/api/v1/devices/${deviceId}/revoke`, { confirmation: 'REVOKE' });
      return;
    }
    throw err;
  }
}
