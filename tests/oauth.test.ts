import { test } from 'node:test';
import * as assert from 'node:assert';
import { encryptToken, decryptToken } from '../backend/src/lib/integrations/oauth-manager';

test('encrypt and decrypt token successfully', async () => {
  const secretKey = 'my-super-secret-key-that-is-long-enough';
  const plaintext = 'this-is-a-refresh-token';
  
  const encrypted = await encryptToken(plaintext, secretKey);
  assert.notStrictEqual(encrypted, plaintext);
  
  const decrypted = await decryptToken(encrypted, secretKey);
  assert.strictEqual(decrypted, plaintext);
});
