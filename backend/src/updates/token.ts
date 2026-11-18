import crypto from 'node:crypto';
import type { UpdatePreview } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export const TOKEN_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes

export interface GeneratedToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function generateConfirmationToken(lifetimeMs: number = TOKEN_LIFETIME_MS): GeneratedToken {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + lifetimeMs);
  return { token, tokenHash, expiresAt };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface VerifyTokenParams {
  token: string;
  userId?: string;
  deviceId?: string;
  packageId?: string;
  targetVersion?: string;
}

export type TokenErrorCode =
  | 'TOKEN_NOT_FOUND'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'USER_MISMATCH'
  | 'DEVICE_MISMATCH'
  | 'PACKAGE_MISMATCH'
  | 'VERSION_MISMATCH';

export interface VerifyTokenResult {
  valid: boolean;
  code?: TokenErrorCode;
  reason?: string;
  preview?: UpdatePreview;
}

/**
 * Verifies a confirmation token against stored hash, expiry, usage status, user, device, and package.
 * IMPORTANT: Does NOT mark the token as used (consumption happens at approval / job creation).
 */
export async function verifyConfirmationToken(params: VerifyTokenParams): Promise<VerifyTokenResult> {
  const { token, userId, deviceId, packageId, targetVersion } = params;

  if (!token || typeof token !== 'string') {
    return {
      valid: false,
      code: 'TOKEN_NOT_FOUND',
      reason: 'A confirmation token is required',
    };
  }

  const tokenHash = hashToken(token);

  let preview: UpdatePreview | null = null;
  try {
    if (prisma.updatePreview) {
      preview = await prisma.updatePreview.findFirst({
        where: { tokenHash },
      });
    }
  } catch {
    preview = null;
  }

  if (!preview) {
    return {
      valid: false,
      code: 'TOKEN_NOT_FOUND',
      reason: 'Confirmation token is invalid or does not exist',
    };
  }

  // 1. Check usage status (must be unused)
  if (preview.usedAt !== null) {
    return {
      valid: false,
      code: 'TOKEN_ALREADY_USED',
      reason: 'Confirmation token has already been used',
      preview,
    };
  }

  // 2. Check expiry (must be unexpired)
  const now = new Date();
  if (new Date(preview.expiresAt) <= now) {
    return {
      valid: false,
      code: 'TOKEN_EXPIRED',
      reason: 'Confirmation token has expired',
      preview,
    };
  }

  // 3. Check user binding
  if (userId && preview.userId !== userId) {
    return {
      valid: false,
      code: 'USER_MISMATCH',
      reason: 'Confirmation token belongs to a different user',
      preview,
    };
  }

  // 4. Check device binding
  if (deviceId && preview.deviceId !== deviceId) {
    return {
      valid: false,
      code: 'DEVICE_MISMATCH',
      reason: 'Confirmation token was issued for a different device',
      preview,
    };
  }

  // 5. Check package binding
  if (packageId && preview.packageId.toLowerCase() !== packageId.toLowerCase()) {
    return {
      valid: false,
      code: 'PACKAGE_MISMATCH',
      reason: 'Confirmation token was issued for a different package',
      preview,
    };
  }

  // 6. Check version binding
  if (targetVersion && preview.targetVersion !== targetVersion) {
    return {
      valid: false,
      code: 'VERSION_MISMATCH',
      reason: 'Confirmation token was issued for a different target version',
      preview,
    };
  }

  // All checks pass - token is valid; NOT marked used here
  return {
    valid: true,
    preview,
  };
}
