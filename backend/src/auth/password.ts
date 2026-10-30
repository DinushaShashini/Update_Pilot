import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * Sensible parameters for Argon2id (RFC 9106 recommended profile):
 * - memoryCost: 19456 KiB (~19 MiB)
 * - timeCost: 2 iterations
 * - outputLen: 32 bytes
 * - parallelism: 1 lane
 * - algorithm: Argon2id
 */
const ARGON2ID_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
  algorithm: Algorithm.Argon2id,
};

/**
 * Hashes a plaintext password using Argon2id with a cryptographically secure random salt.
 * Raw password and resulting hash are never logged.
 *
 * @param password Raw password to hash
 * @returns Formatted Argon2id hash string
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  return hash(password, ARGON2ID_OPTIONS);
}

/**
 * Verifies a plaintext password against an Argon2id hash.
 * Never logs the password or hash. Returns true on valid match, false on mismatch or error.
 *
 * @param password Plaintext password candidate
 * @param passwordHash Stored Argon2id hash
 * @returns boolean indicating verification success
 */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (
    !password ||
    !passwordHash ||
    typeof password !== 'string' ||
    typeof passwordHash !== 'string'
  ) {
    return false;
  }

  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
