import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../backend/src/index';
import { createTestEnv, createBasicAuthHeader } from './e2e/harness';
import { signLoginToken, buildSessionCookie } from '../backend/src/lib/portal-auth';
import { consumeRateLimit } from '../backend/src/lib/rate-limit';

const ORIGIN = 'http://localhost';

function seedClient(db: ReturnType<typeof createTestEnv>['db'], id = 1, email = 'jane@acme.test') {
  db.rawSqlite.exec(
    `INSERT INTO clients (id, company_name, contact_name, contact_email) VALUES (${id}, 'Acme ${id}', 'Jane', '${email}')`
  );
}

function verifyPost(token: string): Request {
  return new Request(`${ORIGIN}/portal/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
}

function sessionToken(setCookie: string | null): string {
  const match = /portal_session=([^;]+)/.exec(setCookie ?? '');
  assert.ok(match, 'expected a portal_session cookie');
  return match[1];
}

describe('magic links are single-use and scanner-safe', () => {
  test('GET /portal/verify renders a confirm form and does not consume the token', async () => {
    const { env, db } = createTestEnv();
    seedClient(db);
    const token = await signLoginToken(1, env.PORTAL_SESSION_SECRET);

    const getResp = await worker.fetch(new Request(`${ORIGIN}/portal/verify?token=${token}`), env);
    assert.equal(getResp.status, 200);
    assert.equal(getResp.headers.get('Set-Cookie'), null);
    const html = await getResp.text();
    assert.match(html, /method="post"/i);
    assert.match(html, /action="\/portal\/verify"/);

    const postResp = await worker.fetch(verifyPost(token), env);
    assert.equal(postResp.status, 303, 'token must still be usable after the GET');
  });

  test('POST /portal/verify succeeds once, then rejects the same token', async () => {
    const { env, db } = createTestEnv();
    seedClient(db);
    const token = await signLoginToken(1, env.PORTAL_SESSION_SECRET);

    const first = await worker.fetch(verifyPost(token), env);
    assert.equal(first.status, 303);
    assert.equal(first.headers.get('Location'), '/portal/dashboard');

    const replay = await worker.fetch(verifyPost(token), env);
    assert.equal(replay.status, 400);
    assert.equal(replay.headers.get('Set-Cookie'), null);
  });

  test('rejects a garbage token and a missing body without a 500', async () => {
    const { env } = createTestEnv();
    assert.equal((await worker.fetch(verifyPost('not-a-token'), env)).status, 400);
    const empty = new Request(`${ORIGIN}/portal/verify`, { method: 'POST' });
    assert.equal((await worker.fetch(empty, env)).status, 400);
  });
});

describe('logout revokes sessions server-side', () => {
  test('a copied session cookie stops working after logout', async () => {
    const { env, db } = createTestEnv();
    seedClient(db);
    const token = await signLoginToken(1, env.PORTAL_SESSION_SECRET);
    const login = await worker.fetch(verifyPost(token), env);
    const session = sessionToken(login.headers.get('Set-Cookie'));
    const withSession = (path: string, method = 'GET') =>
      new Request(`${ORIGIN}${path}`, { method, headers: { Cookie: `portal_session=${session}` } });

    assert.equal((await worker.fetch(withSession('/portal/dashboard'), env)).status, 200);

    const logout = await worker.fetch(withSession('/portal/logout', 'POST'), env);
    assert.equal(logout.status, 303);

    const after = await worker.fetch(withSession('/portal/dashboard'), env);
    assert.equal(after.status, 303);
    assert.equal(after.headers.get('Location'), '/portal');
    const api = await worker.fetch(withSession('/api/portal/debtors'), env);
    assert.equal(api.status, 401);
  });

  test('a new login after logout issues a working session', async () => {
    const { env, db } = createTestEnv();
    seedClient(db);
    db.rawSqlite.exec(`UPDATE clients SET session_epoch = 3 WHERE id = 1`);
    const stale = await buildSessionCookie(1, env.PORTAL_SESSION_SECRET); // epoch 0
    const staleResp = await worker.fetch(
      new Request(`${ORIGIN}/portal/dashboard`, { headers: { Cookie: stale.split(';')[0] } }),
      env
    );
    assert.equal(staleResp.status, 303);

    const token = await signLoginToken(1, env.PORTAL_SESSION_SECRET);
    const login = await worker.fetch(verifyPost(token), env);
    const fresh = sessionToken(login.headers.get('Set-Cookie'));
    const ok = await worker.fetch(
      new Request(`${ORIGIN}/portal/dashboard`, { headers: { Cookie: `portal_session=${fresh}` } }),
      env
    );
    assert.equal(ok.status, 200);
  });
});

describe('rate limiting on email-sending routes', () => {
  const loginPost = (email: string, ip: string) =>
    new Request(`${ORIGIN}/portal/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip },
      body: new URLSearchParams({ email }).toString(),
    });

  test('per-address: at most 3 magic links per 15 minutes, silently', async () => {
    const { env, db, send } = createTestEnv();
    seedClient(db);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await worker.fetch(loginPost('jane@acme.test', '203.0.113.1'), env)).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200], 'response must not reveal the limit');
    assert.equal(send.sent.length, 3);
  });

  test('per-IP: the 11th login request in a window gets 429', async () => {
    const { env } = createTestEnv();
    for (let i = 0; i < 10; i++) {
      const r = await worker.fetch(loginPost(`nobody${i}@x.test`, '203.0.113.9'), env);
      assert.equal(r.status, 200);
    }
    const blocked = await worker.fetch(loginPost('nobody@x.test', '203.0.113.9'), env);
    assert.equal(blocked.status, 429);
    const otherIp = await worker.fetch(loginPost('nobody@x.test', '198.51.100.7'), env);
    assert.equal(otherIp.status, 200);
  });

  test('lead form: the 6th submission per IP per hour gets 429', async () => {
    const { env, notify } = createTestEnv();
    const lead = () =>
      new Request(`${ORIGIN}/api/lead`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'CF-Connecting-IP': '203.0.113.5',
        },
        body: JSON.stringify({ name: 'Eve', email: 'eve@x.test', overdue_band: 'not_sure' }),
      });
    for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(lead(), env)).status, 200);
    assert.equal((await worker.fetch(lead(), env)).status, 429);
    assert.equal(notify.sent.length, 5);
  });

  test('windows reset: a new window starts counting from zero', async () => {
    const { env } = createTestEnv();
    const rule = { limit: 1, windowSeconds: 60 };
    const t0 = Date.UTC(2026, 9, 12, 12, 0, 0);
    assert.equal(await consumeRateLimit(env.DB, 'b', rule, t0), true);
    assert.equal(await consumeRateLimit(env.DB, 'b', rule, t0 + 1000), false);
    assert.equal(await consumeRateLimit(env.DB, 'b', rule, t0 + 61_000), true);
  });
});

describe('input hardening', () => {
  test('CR/LF in lead name never reaches the notification subject', async () => {
    const { env, notify } = createTestEnv();
    const resp = await worker.fetch(
      new Request(`${ORIGIN}/api/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name: 'Eve\r\nBcc: attacker@evil.test',
          email: 'eve@x.test',
          overdue_band: 'not_sure',
        }),
      }),
      env
    );
    assert.equal(resp.status, 200);
    assert.equal(notify.sent.length, 1);
    assert.doesNotMatch(notify.sent[0].subject, /[\r\n]/);
  });

  test('malformed bodies on /api/lead and /portal/login return 4xx, not 500', async () => {
    const { env } = createTestEnv();
    const cases: [string, Record<string, string>, string][] = [
      ['/api/lead', { 'Content-Type': 'application/json' }, '{bad'],
      ['/api/lead', { 'Content-Type': 'application/json' }, 'null'],
      ['/api/lead', { 'Content-Type': 'text/plain' }, 'hello'],
    ];
    for (const [path, headers, body] of cases) {
      const r = await worker.fetch(
        new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body }),
        env
      );
      assert.equal(r.status, 400, `${path} ${headers['Content-Type']} ${body}`);
    }
    const login = await worker.fetch(
      new Request(`${ORIGIN}/portal/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'x',
      }),
      env
    );
    assert.equal(login.status, 200, 'login keeps its uniform response');
  });

  test('invalid base64 in Basic auth is a 401, not a 500', async () => {
    const { env } = createTestEnv();
    const r = await worker.fetch(
      new Request(`${ORIGIN}/api/clients`, {
        method: 'POST',
        headers: { Authorization: 'Basic !!!notb64', 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env
    );
    assert.equal(r.status, 401);
  });

  test('duplicate client contact_email is rejected with 409', async () => {
    const { env, db } = createTestEnv();
    seedClient(db);
    const r = await worker.fetch(
      new Request(`${ORIGIN}/api/clients`, {
        method: 'POST',
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ company_name: 'Acme Dup', contact_email: 'JANE@acme.test' }),
      }),
      env
    );
    assert.equal(r.status, 409);
  });
});

describe('CSRF guard', () => {
  test('cross-origin POST with valid admin auth is rejected', async () => {
    const { env } = createTestEnv();
    const r = await worker.fetch(
      new Request(`${ORIGIN}/api/chase/1/approve`, {
        method: 'POST',
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Origin: 'https://evil.test',
        },
      }),
      env
    );
    assert.equal(r.status, 403);
  });

  test('Sec-Fetch-Site: cross-site is rejected; same-origin passes through', async () => {
    const { env } = createTestEnv();
    const cross = await worker.fetch(
      new Request(`${ORIGIN}/portal/logout`, {
        method: 'POST',
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      }),
      env
    );
    assert.equal(cross.status, 403);
    const same = await worker.fetch(
      new Request(`${ORIGIN}/portal/logout`, { method: 'POST', headers: { Origin: ORIGIN } }),
      env
    );
    assert.equal(same.status, 303);
  });

  test('Stripe webhook is exempt (server-to-server)', async () => {
    const { env } = createTestEnv();
    const r = await worker.fetch(
      new Request(`${ORIGIN}/api/billing/webhook`, {
        method: 'POST',
        headers: { Origin: 'https://stripe.com' },
        body: '{}',
      }),
      env
    );
    assert.equal(r.status, 400, 'reaches the handler and fails signature verification');
  });
});

describe('CSV import robustness', () => {
  const importCsv = (env: Env, csv: string) =>
    worker.fetch(
      new Request(`${ORIGIN}/api/clients/1/invoices/import`, {
        method: 'POST',
        headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET) },
        body: csv,
      }),
      env
    );
  const header = 'debtor_name,debtor_email,invoice_number,amount,currency,issued_date,due_date';

  test('a bad row is reported per-row instead of 500ing the import', async () => {
    const { env, db } = createTestEnv();
    seedClient(db);
    const r = await importCsv(
      env,
      `${header}\nGood Ltd,,A1,10,GBP,,2026-09-01\nBad Ltd,,A2,10,GBP,,01/09/2026\nX,,A3,10,GBP,,2026-09-01`
    );
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.imported, 1);
    assert.equal(json.errors.length, 2);
  });

  test('thousands separators are accepted', async () => {
    const { env, db } = createTestEnv();
    seedClient(db);
    const r = await importCsv(env, `${header}\nGood Ltd,,A1,"1,250.00",GBP,,2026-09-01`);
    const json = await r.json();
    assert.equal(json.imported, 1);
    const row = await db
      .prepare("SELECT amount_pence FROM invoices WHERE invoice_number = 'A1'")
      .first<{ amount_pence: number }>();
    assert.equal(row?.amount_pence, 125000);
  });

  test('oversized imports are refused up front with 413', async () => {
    const { env, db } = createTestEnv();
    seedClient(db);
    const rows = Array.from({ length: 401 }, (_, i) => `Debtor ${i},,INV-${i},10,GBP,,2026-09-01`);
    const r = await importCsv(env, `${header}\n${rows.join('\n')}`);
    assert.equal(r.status, 413);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM invoices').first<{ n: number }>();
    assert.equal(count?.n, 0);
  });

  test('re-import does not reset a disputed invoice back to overdue', async () => {
    const { env, db } = createTestEnv();
    seedClient(db);
    await importCsv(env, `${header}\nGood Ltd,,A1,10,GBP,,2026-09-01`);
    db.rawSqlite.exec(`UPDATE invoices SET status = 'disputed' WHERE invoice_number = 'A1'`);
    await importCsv(env, `${header}\nGood Ltd,,A1,10,GBP,,2026-09-01`);
    const row = await db
      .prepare("SELECT status FROM invoices WHERE invoice_number = 'A1'")
      .first<{ status: string }>();
    assert.equal(row?.status, 'disputed');
  });
});

describe('dashboard security headers', () => {
  test('/dashboard/* assets get CSP, HSTS and no-store when authenticated', async () => {
    const { env, db } = createTestEnv({
      ASSETS: {
        fetch: async () =>
          new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
      } as unknown as Fetcher,
    });
    seedClient(db);
    const cookie = (await buildSessionCookie(1, env.PORTAL_SESSION_SECRET)).split(';')[0];
    const r = await worker.fetch(
      new Request(`${ORIGIN}/dashboard/`, { headers: { Cookie: cookie } }),
      env
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get('Content-Security-Policy') ?? '', /connect-src 'self'/);
    assert.match(r.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
    assert.ok(r.headers.get('Strict-Transport-Security'));
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  });
});
