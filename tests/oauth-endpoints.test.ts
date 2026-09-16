import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from './e2e/harness';
import worker from '../backend/src/index';
import {
  generateOAuthState,
  verifyOAuthState,
  encryptToken,
  decryptToken,
  buildAuthorizationUrl,
} from '../backend/src/lib/integrations/oauth-manager';
import { buildSessionCookie } from '../backend/src/lib/portal-auth';

describe('OAuth 2.0 Connection Lifecycle & Endpoints', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function setupMockProviderFetch() {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();

      // Xero Token Exchange
      if (url === 'https://identity.xero.com/connect/token') {
        const body = init?.body?.toString() ?? '';
        if (body.includes('code=invalid_code')) {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        }
        if (body.includes('grant_type=refresh_token')) {
          if (body.includes('refresh_token=revoked_refresh_token')) {
            return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
          }
          return new Response(
            JSON.stringify({
              access_token: 'new-xero-access-token-999',
              refresh_token: 'new-xero-refresh-token-999',
              token_type: 'Bearer',
              expires_in: 1800,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            access_token: 'mock-xero-access-token-123',
            refresh_token: 'mock-xero-refresh-token-123',
            token_type: 'Bearer',
            expires_in: 1800,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Xero Connections
      if (url === 'https://api.xero.com/connections') {
        return new Response(
          JSON.stringify([
            {
              id: 'conn-1',
              tenantId: 'xero-tenant-guid-123',
              tenantType: 'ORGANISATION',
              tenantName: 'Acme UK Ltd',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // QuickBooks Token Exchange
      if (url === 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer') {
        const body = init?.body?.toString() ?? '';
        if (body.includes('grant_type=refresh_token')) {
          return new Response(
            JSON.stringify({
              access_token: 'new-qb-access-token-999',
              refresh_token: 'new-qb-refresh-token-999',
              token_type: 'bearer',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            access_token: 'mock-qb-access-token-456',
            refresh_token: 'mock-qb-refresh-token-456',
            token_type: 'bearer',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Fallback
      return originalFetch(input, init);
    };
  }

  test('HMAC state generation and cryptographic verification', async () => {
    const secret = 'secret-key-32-chars-long-test-123!';
    const state = await generateOAuthState({ cid: 42, p: 'xero', ret: '/portal/dashboard' }, secret, 600);
    assert.ok(state.includes('.'));

    const verified = await verifyOAuthState(state, secret, 'xero');
    assert.ok(verified);
    assert.strictEqual(verified.cid, 42);
    assert.strictEqual(verified.p, 'xero');
    assert.strictEqual(verified.ret, '/portal/dashboard');

    // Tampered payload
    const parts = state.split('.');
    const tampered = `eyJuZSI6InRhbXBlcmVkIn0.${parts[1]}`;
    const verifiedTampered = await verifyOAuthState(tampered, secret, 'xero');
    assert.strictEqual(verifiedTampered, null);

    // Wrong secret
    const verifiedWrongKey = await verifyOAuthState(state, 'wrong-secret-key-that-is-long!!', 'xero');
    assert.strictEqual(verifiedWrongKey, null);

    // Mismatched provider
    const verifiedWrongProvider = await verifyOAuthState(state, secret, 'quickbooks');
    assert.strictEqual(verifiedWrongProvider, null);
  });

  test('GET /api/oauth/:provider/connect returns 401 when unauthenticated', async () => {
    const { env } = createTestEnv();
    const req = new Request('http://localhost/api/oauth/xero/connect');
    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 401);
  });

  test('GET /api/oauth/:provider/connect redirects with signed state for authenticated client', async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES (1, 'Client Connect Test', 'cct@test.com', 'engine', 'active');
    `);

    const sessionCookie = await buildSessionCookie(1, env.PORTAL_SESSION_SECRET);

    // Xero connect
    const reqXero = new Request('http://localhost/api/oauth/xero/connect', {
      headers: { Cookie: sessionCookie },
    });
    const resXero = await worker.fetch(reqXero, env);
    assert.strictEqual(resXero.status, 302);
    const locationXero = resXero.headers.get('Location') ?? '';
    assert.ok(locationXero.startsWith('https://login.xero.com/identity/connect/authorize'));
    assert.ok(locationXero.includes('state='));
    assert.ok(locationXero.includes('redirect_uri='));

    // QuickBooks connect
    const reqQB = new Request('http://localhost/api/oauth/quickbooks/connect', {
      headers: { Cookie: sessionCookie },
    });
    const resQB = await worker.fetch(reqQB, env);
    assert.strictEqual(resQB.status, 302);
    const locationQB = resQB.headers.get('Location') ?? '';
    assert.ok(locationQB.startsWith('https://appcenter.intuit.com/connect/oauth2'));
    assert.ok(locationQB.includes('state='));
  });

  test('GET /api/oauth/:provider/callback exchanges code, encrypts tokens, and stores connection', async () => {
    setupMockProviderFetch();
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES (1, 'Callback Client', 'cb@test.com', 'engine', 'active');
    `);

    const secret = env.PORTAL_SESSION_SECRET;
    const state = await generateOAuthState({ cid: 1, p: 'xero', ret: '/portal/dashboard' }, secret, 600);

    const callbackUrl = `http://localhost/api/oauth/xero/callback?code=mock_code_123&state=${encodeURIComponent(state)}`;
    const req = new Request(callbackUrl, {
      headers: { Accept: 'application/json' },
    });

    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as any;
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.connected, true);

    // Verify stored connection in D1
    const conn = await db.prepare(
      'SELECT client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, status FROM accounting_connections WHERE client_id = 1'
    ).first<any>();

    assert.ok(conn);
    assert.strictEqual(conn.provider, 'xero');
    assert.strictEqual(conn.tenant_id, 'xero-tenant-guid-123');
    assert.strictEqual(conn.status, 'active');

    // Verify token encryption: Stored values must NOT be plaintext!
    assert.notStrictEqual(conn.access_token_encrypted, 'mock-xero-access-token-123');
    assert.notStrictEqual(conn.refresh_token_encrypted, 'mock-xero-refresh-token-123');

    // Verify successful decryption
    const decryptedAccess = await decryptToken(conn.access_token_encrypted, secret);
    assert.strictEqual(decryptedAccess, 'mock-xero-access-token-123');

    // Verify client accounting_source was updated
    const client = await db.prepare('SELECT accounting_source FROM clients WHERE id = 1').first<any>();
    assert.strictEqual(client.accounting_source, 'xero');
  });

  test('GET /api/oauth/quickbooks/callback extracts realmId and stores QuickBooks connection', async () => {
    setupMockProviderFetch();
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES (2, 'QB Client', 'qb@test.com', 'engine', 'active');
    `);

    const secret = env.PORTAL_SESSION_SECRET;
    const state = await generateOAuthState({ cid: 2, p: 'quickbooks', ret: '/portal/dashboard' }, secret, 600);

    const callbackUrl = `http://localhost/api/oauth/quickbooks/callback?code=mock_qb_code&realmId=123456789012&state=${encodeURIComponent(state)}`;
    const req = new Request(callbackUrl, {
      headers: { Accept: 'application/json' },
    });

    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 200);

    const conn = await db.prepare(
      'SELECT provider, tenant_id, status FROM accounting_connections WHERE client_id = 2'
    ).first<any>();

    assert.ok(conn);
    assert.strictEqual(conn.provider, 'quickbooks');
    assert.strictEqual(conn.tenant_id, '123456789012');
  });

  test('GET /api/oauth/:provider/callback rejects invalid or tampered state', async () => {
    const { env } = createTestEnv();
    const req = new Request('http://localhost/api/oauth/xero/callback?code=abc&state=completely-invalid-state');
    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 400);
    const json = (await res.json()) as any;
    assert.strictEqual(json.ok, false);
  });

  test('POST /api/oauth/:provider/refresh refreshes tokens and updates expires_at', async () => {
    setupMockProviderFetch();
    const { env, db } = createTestEnv();
    const secret = env.PORTAL_SESSION_SECRET;

    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES (1, 'Refresh Client', 'ref@test.com', 'engine', 'active');
    `);

    const encAccess = await encryptToken('old-access-token', secret);
    const encRefresh = await encryptToken('old-refresh-token', secret);

    await db.prepare(`
      INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (1, 'xero', 'tenant-123', ?1, ?2, '2026-09-16T00:00:00Z', 'active')
    `).bind(encAccess, encRefresh).run();

    const sessionCookie = await buildSessionCookie(1, secret);
    const req = new Request('http://localhost/api/oauth/xero/refresh', {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as any;
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.refreshed, true);

    const updatedConn = await db.prepare(
      'SELECT access_token_encrypted, refresh_token_encrypted, status FROM accounting_connections WHERE client_id = 1'
    ).first<any>();

    const newDecryptedAccess = await decryptToken(updatedConn.access_token_encrypted, secret);
    assert.strictEqual(newDecryptedAccess, 'new-xero-access-token-999');
  });

  test('POST /api/oauth/:provider/refresh marks status revoked on invalid_grant', async () => {
    setupMockProviderFetch();
    const { env, db } = createTestEnv();
    const secret = env.PORTAL_SESSION_SECRET;

    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES (1, 'Revoke Test Client', 'rev@test.com', 'engine', 'active');
    `);

    const encAccess = await encryptToken('access-token', secret);
    const encRefresh = await encryptToken('revoked_refresh_token', secret);

    await db.prepare(`
      INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (1, 'xero', 'tenant-123', ?1, ?2, '2026-09-16T00:00:00Z', 'active')
    `).bind(encAccess, encRefresh).run();

    const sessionCookie = await buildSessionCookie(1, secret);
    const req = new Request('http://localhost/api/oauth/xero/refresh', {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 401);

    const updatedConn = await db.prepare('SELECT status FROM accounting_connections WHERE client_id = 1').first<any>();
    assert.strictEqual(updatedConn.status, 'revoked');
  });

  test('GET /api/oauth/:provider/status returns safe connection metadata without exposing tokens', async () => {
    const { env, db } = createTestEnv();
    const secret = env.PORTAL_SESSION_SECRET;

    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES (1, 'Status Client', 'status@test.com', 'engine', 'active');
    `);

    const encAccess = await encryptToken('top-secret-access', secret);
    const encRefresh = await encryptToken('top-secret-refresh', secret);

    await db.prepare(`
      INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (1, 'xero', 'tenant-org-777', ?1, ?2, '2026-09-16T12:00:00Z', 'active')
    `).bind(encAccess, encRefresh).run();

    const sessionCookie = await buildSessionCookie(1, secret);
    const req = new Request('http://localhost/api/oauth/xero/status', {
      headers: { Cookie: sessionCookie },
    });

    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as any;
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.connected, true);
    assert.strictEqual(json.provider, 'xero');
    assert.strictEqual(json.tenant_id, 'tenant-org-777');
    assert.strictEqual(json.status, 'active');

    // STRICT INVARIANT: Tokens must NEVER be present in status output
    assert.strictEqual(json.access_token_encrypted, undefined);
    assert.strictEqual(json.refresh_token_encrypted, undefined);
    assert.strictEqual(json.accessToken, undefined);
    assert.strictEqual(json.refreshToken, undefined);
  });

  test('POST /api/oauth/:provider/disconnect cleans up connection and client state', async () => {
    const { env, db } = createTestEnv();
    const secret = env.PORTAL_SESSION_SECRET;

    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
      VALUES (1, 'Disconnect Client', 'disc@test.com', 'engine', 'active', 'xero');
    `);

    const encAccess = await encryptToken('acc', secret);
    const encRefresh = await encryptToken('ref', secret);

    await db.prepare(`
      INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (1, 'xero', 'tenant-123', ?1, ?2, '2026-09-16T12:00:00Z', 'active')
    `).bind(encAccess, encRefresh).run();

    const sessionCookie = await buildSessionCookie(1, secret);
    const req = new Request('http://localhost/api/oauth/xero/disconnect', {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 200);

    // Database check
    const conn = await db.prepare('SELECT id FROM accounting_connections WHERE client_id = 1').first<any>();
    assert.strictEqual(conn, null);

    const client = await db.prepare('SELECT accounting_source FROM clients WHERE id = 1').first<any>();
    assert.strictEqual(client.accounting_source, null);
  });

  test('POST /api/oauth/:provider/disconnect returns 401 when unauthenticated', async () => {
    const { env, db } = createTestEnv();
    const secret = env.PORTAL_SESSION_SECRET;

    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
      VALUES (2, 'Unauth Disconnect Client', 'udc@test.com', 'engine', 'active', 'xero');
    `);

    const encAccess = await encryptToken('acc', secret);
    const encRefresh = await encryptToken('ref', secret);

    await db.prepare(`
      INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (2, 'xero', 'tenant-2', ?1, ?2, '2026-09-16T12:00:00Z', 'active')
    `).bind(encAccess, encRefresh).run();

    const req = new Request('http://localhost/api/oauth/xero/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 2 }),
    });

    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 401);
    const json = (await res.json()) as any;
    assert.strictEqual(json.error, 'Unauthorized');

    // Connection MUST NOT be deleted
    const conn = await db.prepare('SELECT id FROM accounting_connections WHERE client_id = 2').first<any>();
    assert.ok(conn, 'Connection must remain intact');
  });

  test('POST /api/oauth/:provider/refresh returns 401 when unauthenticated', async () => {
    const { env } = createTestEnv();
    const req = new Request('http://localhost/api/oauth/xero/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 2 }),
    });

    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 401);
    const json = (await res.json()) as any;
    assert.strictEqual(json.error, 'Unauthorized');
  });

  test('GET /api/oauth/:provider/status returns 401 when unauthenticated', async () => {
    const { env } = createTestEnv();
    const req = new Request('http://localhost/api/oauth/xero/status?client_id=2');

    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 401);
    const json = (await res.json()) as any;
    assert.strictEqual(json.error, 'Unauthorized');
  });

  test('Admin authentication allows managing client connections via client_id', async () => {
    const { env, db } = createTestEnv();
    const secret = env.PORTAL_SESSION_SECRET;

    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
      VALUES (5, 'Admin Managed Client', 'amc@test.com', 'engine', 'active', 'xero');
    `);

    const encAccess = await encryptToken('admin-acc', secret);
    const encRefresh = await encryptToken('admin-ref', secret);

    await db.prepare(`
      INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (5, 'xero', 'tenant-admin-5', ?1, ?2, '2026-10-01T00:00:00Z', 'active')
    `).bind(encAccess, encRefresh).run();

    const authHeader = `Basic ${btoa(`admin:${env.ADMIN_SECRET}`)}`;

    // Admin queries status
    const statusReq = new Request('http://localhost/api/oauth/xero/status?client_id=5', {
      headers: { Authorization: authHeader },
    });
    const statusRes = await worker.fetch(statusReq, env);
    assert.strictEqual(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as any;
    assert.strictEqual(statusJson.connected, true);
    assert.strictEqual(statusJson.tenant_id, 'tenant-admin-5');

    // Admin disconnects
    const discReq = new Request('http://localhost/api/oauth/xero/disconnect', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 5 }),
    });
    const discRes = await worker.fetch(discReq, env);
    assert.strictEqual(discRes.status, 200);

    const postConn = await db.prepare('SELECT id FROM accounting_connections WHERE client_id = 5').first();
    assert.strictEqual(postConn, null);
  });
});
