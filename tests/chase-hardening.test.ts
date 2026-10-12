import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, createBasicAuthHeader, type TestEnvFixture } from './e2e/harness';
import worker from '../backend/src/index';
import { runOverdueDetection } from '../backend/src/lib/chase-runner';
import {
  SECURITY_HEADERS,
  handleApproveDraft,
  handleGetDrafts,
  handleSkipDraft,
  resolvePortalClientId,
} from '../backend/src/lib/portal-api';
import { buildSessionCookie } from '../backend/src/lib/portal-auth';
import { headerSafe } from '../backend/src/lib/email';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function seed(fx: TestEnvFixture, draftStatus: 'draft' | 'sent' | 'skipped' = 'draft'): void {
  fx.db.rawSqlite.exec(`
    INSERT INTO clients (id, company_name, contact_name, contact_email)
    VALUES (1, 'Acme Ltd', 'Jane Owner', 'jane@acme.test');
    INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, due_date, status)
    VALUES (10, 1, 'Debtor Co', 'ap@debtor.test', 'INV-10', 100000, 'GBP', date('now', '-10 days'), 'overdue');
    INSERT INTO chase_log (id, invoice_id, step, channel, subject, status, body, sent_at)
    VALUES (100, 10, 1, 'email', 'Re: Invoice INV-10', '${draftStatus}', 'Original body', '2026-01-01 09:00:00');
  `);
}

async function clientCookie(fx: TestEnvFixture, clientId = 1): Promise<string> {
  const setCookie = await buildSessionCookie(clientId, fx.env.PORTAL_SESSION_SECRET);
  return setCookie.split(';')[0];
}

function chaseRow(fx: TestEnvFixture, id = 100) {
  return fx.db.rawSqlite
    .prepare(
      'SELECT status, body, sent_at, reviewed_at, reviewed_by, outcome FROM chase_log WHERE id = ?'
    )
    .get(id) as {
    status: string;
    body: string;
    sent_at: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
    outcome: string | null;
  };
}

function post(path: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', ...headers },
  });
}

describe('Chase hardening (2026-10-12)', () => {
  test('headerSafe strips CR/LF runs from subject values', () => {
    assert.equal(headerSafe('INV-1\r\nBcc: x@evil.test'), 'INV-1 Bcc: x@evil.test');
    assert.equal(headerSafe('plain'), 'plain');
  });

  test('overlapping detect-overdue runs insert one draft; the loser counts it as skipped', async () => {
    const fx = createTestEnv();
    fx.db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Acme Ltd', 'jane@acme.test');
      INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, due_date, status)
      VALUES (10, 1, 'Debtor Co', 'ap@debtor.test', 'INV-10' || char(13) || char(10) || 'Bcc: x@evil.test', 100000, 'GBP', date('now', '-10 days'), 'overdue');
    `);

    // Hold both Gemini calls until both runs have passed the pending-draft check.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let geminiCalls = 0;
    globalThis.fetch = async () => {
      geminiCalls++;
      if (geminiCalls === 2) release();
      await gate;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Drafted body' }] }, finishReason: 'STOP' }],
        })
      );
    };

    const [a, b] = await Promise.all([runOverdueDetection(fx.env), runOverdueDetection(fx.env)]);

    assert.equal(geminiCalls, 2, 'both runs raced past the app-level check');
    assert.equal(a.draftsCreated + b.draftsCreated, 1);
    assert.equal(a.skippedDrafts + b.skippedDrafts, 1);
    const drafts = fx.db.rawSqlite
      .prepare("SELECT subject FROM chase_log WHERE invoice_id = 10 AND status = 'draft'")
      .all() as { subject: string }[];
    assert.equal(drafts.length, 1);
    assert.ok(!/[\r\n]/.test(drafts[0].subject), 'subject must carry no CR/LF');
  });

  test('approve claims the row first: a second approval gets 404 and only one email is sent', async () => {
    const fx = createTestEnv();
    seed(fx);
    const auth = { Authorization: createBasicAuthHeader() };

    const [r1, r2] = await Promise.all([
      handleApproveDraft(post('/api/admin/drafts/100/approve', auth), fx.env, '100'),
      handleApproveDraft(post('/api/admin/drafts/100/approve', auth), fx.env, '100'),
    ]);

    assert.deepEqual([r1.status, r2.status].sort(), [200, 404]);
    assert.equal(fx.send.sent.length, 1);
    assert.equal(chaseRow(fx).status, 'sent');
    assert.equal(chaseRow(fx).reviewed_by, 'Tibor Rames', 'admin approval keeps OPERATOR_NAME');
  });

  test('approve reverts the claim to an untouched draft when the send fails', async () => {
    const fx = createTestEnv();
    seed(fx);
    fx.send.send = async () => {
      throw new Error('SMTP down');
    };

    const res = await handleApproveDraft(
      new Request('http://localhost/api/admin/drafts/100/approve', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: createBasicAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'Edited body' }),
      }),
      fx.env,
      '100'
    );

    assert.equal(res.status, 500);
    const row = chaseRow(fx);
    assert.equal(row.status, 'draft');
    assert.equal(row.body, 'Original body');
    assert.equal(row.sent_at, '2026-01-01 09:00:00');
    assert.equal(row.reviewed_at, null);
    assert.equal(row.reviewed_by, null);
    assert.equal(row.outcome, null);
  });

  test('client-session approve and skip are attributed to the client, not OPERATOR_NAME', async () => {
    const fx = createTestEnv();
    seed(fx);
    const cookie = await clientCookie(fx);

    const res = await handleApproveDraft(
      post('/api/chase/100/approve', { Cookie: cookie }),
      fx.env,
      '100'
    );
    assert.equal(res.status, 200);
    assert.equal(chaseRow(fx).reviewed_by, 'Jane Owner (client)');

    fx.db.rawSqlite.exec(`
      UPDATE clients SET contact_name = NULL WHERE id = 1;
      INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, due_date, status)
      VALUES (11, 1, 'Debtor Two', 'ap@two.test', 'INV-11', 5000, 'GBP', date('now', '-10 days'), 'overdue');
      INSERT INTO chase_log (id, invoice_id, step, status, body) VALUES (101, 11, 1, 'draft', 'b');
    `);
    const skip = await handleSkipDraft(
      post('/api/chase/101/skip', { Cookie: cookie }),
      fx.env,
      '101'
    );
    assert.equal(skip.status, 200);
    assert.equal(chaseRow(fx, 101).reviewed_by, 'Acme Ltd (client)');
  });

  test('skipping an already-sent or already-skipped draft returns 409 and leaves the row alone', async () => {
    for (const status of ['sent', 'skipped'] as const) {
      const fx = createTestEnv();
      seed(fx, status);
      const res = await handleSkipDraft(
        post('/api/admin/drafts/100/skip', { Authorization: createBasicAuthHeader() }),
        fx.env,
        '100'
      );
      assert.equal(res.status, 409, `skip on ${status}`);
      assert.deepEqual(await res.json(), { ok: false, error: 'Draft already reviewed.' });
      assert.equal(chaseRow(fx).status, status);
      assert.equal(chaseRow(fx).reviewed_by, null);
    }
  });

  test('malformed base64 in a Basic header is 401, not a thrown 500', async () => {
    const fx = createTestEnv();
    const res = await handleGetDrafts(
      new Request('http://localhost/api/admin/drafts', {
        headers: { Authorization: 'Basic %%%not-base64%%%' },
      }),
      fx.env
    );
    assert.equal(res.status, 401);
  });

  test('a wrong admin password of the same length is still 401', async () => {
    const fx = createTestEnv();
    const res = await handleGetDrafts(
      new Request('http://localhost/api/admin/drafts', {
        headers: { Authorization: createBasicAuthHeader('admin-test-secret-12346') },
      }),
      fx.env
    );
    assert.equal(res.status, 401);
  });

  test('?client_id=abc is 400 for admin drafts and for portal client resolution', async () => {
    const fx = createTestEnv();
    seed(fx);

    const drafts = await handleGetDrafts(
      new Request('http://localhost/api/admin/drafts?client_id=abc', {
        headers: { Authorization: createBasicAuthHeader() },
      }),
      fx.env
    );
    assert.equal(drafts.status, 400);

    const ok = await handleGetDrafts(
      new Request('http://localhost/api/admin/drafts?client_id=1', {
        headers: { Authorization: createBasicAuthHeader() },
      }),
      fx.env
    );
    assert.equal(ok.status, 200);
    assert.equal((await ok.json<{ count: number }>()).count, 1);

    const portal = await resolvePortalClientId(
      new Request('http://localhost/api/portal/dashboard?client_id=abc', {
        headers: { Cookie: await clientCookie(fx) },
      }),
      fx.env
    );
    assert.equal(portal.errorResponse?.status, 400);
  });

  test('SECURITY_HEADERS carry HSTS and a locked-down CSP', () => {
    assert.equal(
      SECURITY_HEADERS['Strict-Transport-Security'],
      'max-age=31536000; includeSubDomains'
    );
    assert.match(SECURITY_HEADERS['Content-Security-Policy'], /default-src 'none'/);
    assert.match(SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
  });
});

describe('approve keeps the draft recoverable until delivery succeeds', () => {
  test("an in-flight (leased) draft stays 'draft' and blocks a second approval; an expired lease does not", async () => {
    const { env, db } = createTestEnv();
    db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Lease Co', 'lease@test.com');
      INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
      VALUES (10, 1, 'Debtor', 'debtor@test.com', 'INV-L', 1000, '2026-01-01', 'overdue');
      INSERT INTO chase_log (id, invoice_id, step, channel, status, body) VALUES (100, 10, 1, 'email', 'draft', 'Body');
    `);
    const now = Math.floor(Date.now() / 1000);
    db.rawSqlite.exec(`UPDATE chase_log SET dispatch_lease_until = ${now + 120} WHERE id = 100`);
    const approve = () =>
      worker.fetch(
        new Request('http://localhost/api/chase/100/approve', {
          method: 'POST',
          headers: {
            Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
            Accept: 'application/json',
          },
        }),
        env
      );
    assert.equal((await approve()).status, 404, 'another approval holds the lease');
    const row = await db
      .prepare('SELECT status FROM chase_log WHERE id = 100')
      .first<{ status: string }>();
    assert.equal(row?.status, 'draft', 'never marked sent before delivery');

    db.rawSqlite.exec(`UPDATE chase_log SET dispatch_lease_until = ${now - 1} WHERE id = 100`);
    assert.equal((await approve()).status, 200, 'an expired lease (dead attempt) is reclaimable');
    const sent = await db
      .prepare('SELECT status, dispatch_lease_until FROM chase_log WHERE id = 100')
      .first<{ status: string; dispatch_lease_until: number | null }>();
    assert.equal(sent?.status, 'sent');
    assert.equal(sent?.dispatch_lease_until, null);
  });
});
