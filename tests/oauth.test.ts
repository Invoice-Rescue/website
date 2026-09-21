import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import {
  encryptToken,
  decryptToken,
  exchangeCodeForTokens,
  refreshProviderTokens,
  OAuthError,
  OAuthTokenExchangeError,
  OAuthTokenRefreshError,
  OAuthConnectionError,
  OAuthValidationError,
} from '../backend/src/lib/integrations/oauth-manager';

void test('encrypt and decrypt token successfully', async () => {
  const secretKey = 'my-super-secret-key-that-is-long-enough';
  const plaintext = 'this-is-a-refresh-token';

  const encrypted = await encryptToken(plaintext, secretKey);
  assert.notStrictEqual(encrypted, plaintext);

  const decrypted = await decryptToken(encrypted, secretKey);
  assert.strictEqual(decrypted, plaintext);
});

void describe('OAuth Error Handling & Boundary Validation', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  void test('OAuthError hierarchy preserves prototype chain and error properties', () => {
    const err = new OAuthTokenExchangeError('Token exchange failed', 502, { raw: 'fail' });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof OAuthError);
    assert.ok(err instanceof OAuthTokenExchangeError);
    assert.strictEqual(err.name, 'OAuthTokenExchangeError');
    assert.strictEqual(err.code, 'OAUTH_TOKEN_EXCHANGE_FAILED');
    assert.strictEqual(err.statusCode, 502);
    assert.deepStrictEqual(err.details, { raw: 'fail' });

    const refreshErr = new OAuthTokenRefreshError('Refresh failed');
    assert.ok(refreshErr instanceof OAuthError);
    assert.strictEqual(refreshErr.code, 'OAUTH_TOKEN_REFRESH_FAILED');

    const connErr = new OAuthConnectionError('Connection missing', 404);
    assert.ok(connErr instanceof OAuthError);
    assert.strictEqual(connErr.code, 'OAUTH_CONNECTION_ERROR');
    assert.strictEqual(connErr.statusCode, 404);

    const valErr = new OAuthValidationError('Missing realmId');
    assert.ok(valErr instanceof OAuthError);
    assert.strictEqual(valErr.code, 'OAUTH_VALIDATION_ERROR');
    assert.strictEqual(valErr.statusCode, 400);
  });

  void test('exchangeCodeForTokens throws OAuthValidationError when QuickBooks realmId is missing', async () => {
    await assert.rejects(
      async () => {
        await exchangeCodeForTokens(
          'quickbooks',
          'mock_code',
          'http://localhost/callback',
          { clientId: 'id', clientSecret: 'secret' },
          null
        );
      },
      (err: unknown) => {
        return (
          err instanceof OAuthValidationError &&
          err.message.includes('QuickBooks realmId missing from callback') &&
          err.statusCode === 400
        );
      }
    );
  });

  void test('exchangeCodeForTokens throws OAuthTokenExchangeError on upstream HTTP error', async () => {
    globalThis.fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));

    await assert.rejects(
      async () => {
        await exchangeCodeForTokens('xero', 'bad_code', 'http://localhost/callback', {
          clientId: 'id',
          clientSecret: 'secret',
        });
      },
      (err: unknown) => {
        return (
          err instanceof OAuthTokenExchangeError &&
          err.message.includes('Token exchange failed (400)') &&
          err.statusCode === 400
        );
      }
    );
  });

  void test('exchangeCodeForTokens throws OAuthTokenExchangeError on invalid JSON response', async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response('<html>502 Bad Gateway</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

    await assert.rejects(
      async () => {
        await exchangeCodeForTokens('xero', 'code', 'http://localhost/callback', {
          clientId: 'id',
          clientSecret: 'secret',
        });
      },
      (err: unknown) => {
        return (
          err instanceof OAuthTokenExchangeError && err.message.includes('invalid JSON response')
        );
      }
    );
  });

  void test('exchangeCodeForTokens throws OAuthConnectionError when Xero connections is empty', async () => {
    globalThis.fetch = (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('connections')) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'acc_token',
            refresh_token: 'ref_token',
            expires_in: 3600,
          }),
          { status: 200 }
        )
      );
    };

    await assert.rejects(
      async () => {
        await exchangeCodeForTokens('xero', 'code', 'http://localhost/callback', {
          clientId: 'id',
          clientSecret: 'secret',
        });
      },
      (err: unknown) => {
        return (
          err instanceof OAuthConnectionError &&
          err.message.includes('No connected Xero organization found') &&
          err.statusCode === 404
        );
      }
    );
  });

  void test('refreshProviderTokens throws OAuthTokenRefreshError on upstream refresh failure', async () => {
    globalThis.fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));

    await assert.rejects(
      async () => {
        await refreshProviderTokens('xero', 'bad_token', {
          clientId: 'id',
          clientSecret: 'secret',
        });
      },
      (err: unknown) => {
        return (
          err instanceof OAuthTokenRefreshError &&
          err.message.includes('Token refresh failed (400)') &&
          err.statusCode === 400
        );
      }
    );
  });

  void test('refreshProviderTokens throws OAuthTokenRefreshError when required fields are missing', async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: 'only_access' }), { status: 200 })
      );

    await assert.rejects(
      async () => {
        await refreshProviderTokens('xero', 'token', {
          clientId: 'id',
          clientSecret: 'secret',
        });
      },
      (err: unknown) => {
        return (
          err instanceof OAuthTokenRefreshError &&
          err.message.includes('missing required token fields')
        );
      }
    );
  });
});
