import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.js';

describe('Argon2id Password Hashing & Verification', () => {
  it('correct password verifies', async () => {
    const password = 'CorrectHorseBatteryStaple123!';
    const hash = await hashPassword(password);

    assert.ok(hash.startsWith('$argon2id$'), 'Hash format must use $argon2id$ variant');
    const isValid = await verifyPassword(password, hash);
    assert.strictEqual(isValid, true, 'Correct password should verify successfully');
  });

  it('wrong password fails', async () => {
    const password = 'MySecretPassword!';
    const hash = await hashPassword(password);

    const isWrongValid = await verifyPassword('IncorrectPassword123!', hash);
    assert.strictEqual(isWrongValid, false, 'Wrong password must fail verification');

    const isEmptyValid = await verifyPassword('', hash);
    assert.strictEqual(isEmptyValid, false, 'Empty password must fail verification');
  });

  it('same password produces different hashes', async () => {
    const password = 'IdenticalPasswordTest#2026';
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);

    assert.notStrictEqual(
      hash1,
      hash2,
      'Argon2id must generate unique random salts producing distinct hashes for identical inputs'
    );

    // Both unique hashes must independently verify the password
    assert.strictEqual(await verifyPassword(password, hash1), true);
    assert.strictEqual(await verifyPassword(password, hash2), true);
  });
});
