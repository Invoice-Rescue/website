import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, signStripeWebhook } from './e2e/harness';
import worker from '../backend/src/index';
import { runOverdueDetection } from '../backend/src/lib/chase-runner';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubGemini(): void {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: 'Hi,\n\nReminder about your invoice.\n\nInvoice Rescue — acting on behalf of Client',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      })
    );
}

async function postWebhook(
  env: Parameters<typeof worker.fetch>[1],
  body: object
): Promise<Response> {
  const payload = JSON.stringify(body);
  const header = await signStripeWebhook(
    payload,
    env.STRIPE_WEBHOOK_SECRET,
    Math.floor(Date.now() / 1000)
  );
  return worker.fetch(
    new Request('http://localhost/api/billing/webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': header, 'Content-Type': 'application/json' },
      body: payload,
    }),
    env
  );
}

describe('Billing status gates the daily chase run', () => {
  for (const [status, expectedDrafts] of [
    ['onboarding', 1],
    ['active', 1],
    ['paused', 0],
    ['churned', 0],
  ] as const) {
    test(`a ${status} client gets ${expectedDrafts} draft(s)`, async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, status)
        VALUES (201, 'Status Test Ltd', 'owner@statustest.co.uk', '${status}');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, due_date, status)
        VALUES (2001, 201, 'Debtor Ltd', 'ap@debtor.co.uk', 'INV-ST-1', 100000, 'GBP', date('now', '-3 days'), 'overdue');
      `);
      stubGemini();

      const result = await runOverdueDetection(env);

      assert.strictEqual(result.draftsCreated, expectedDrafts);
      const drafts = await db
        .prepare("SELECT COUNT(*) AS n FROM chase_log WHERE status = 'draft'")
        .first<{ n: number }>();
      assert.strictEqual(drafts?.n, expectedDrafts);
    });
  }
});

describe('customer.subscription.created reactivates a client', () => {
  test('a churned client becomes active again when a new subscription is created', async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, status, stripe_customer_id)
      VALUES (301, 'Returning Ltd', 'owner@returning.co.uk', 'churned', 'cus_returning');
    `);

    const resp = await postWebhook(env, {
      id: 'evt_sub_created_1',
      type: 'customer.subscription.created',
      data: { object: { customer: 'cus_returning', status: 'active' } },
    });

    assert.strictEqual(resp.status, 200);
    const row = await db
      .prepare('SELECT status FROM clients WHERE id = 301')
      .first<{ status: string }>();
    assert.strictEqual(row?.status, 'active');
  });

  test('a stale created event does not override a newer deletion', async () => {
    const { env, db } = createTestEnv();
    const now = Math.floor(Date.now() / 1000);
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, status, stripe_customer_id)
      VALUES (302, 'Gone Ltd', 'owner@gone.co.uk', 'churned', 'cus_gone');
      INSERT INTO webhook_events (id, event_type, customer_id, created_at_timestamp)
      VALUES ('evt_newer_delete', 'customer.subscription.deleted', 'cus_gone', ${now + 60});
    `);

    const resp = await postWebhook(env, {
      id: 'evt_old_created',
      type: 'customer.subscription.created',
      created: now,
      data: { object: { customer: 'cus_gone', status: 'active' } },
    });

    assert.strictEqual(resp.status, 200);
    const json = (await resp.json()) as { skipped_stale?: boolean };
    assert.strictEqual(json.skipped_stale, true);
    const row = await db
      .prepare('SELECT status FROM clients WHERE id = 302')
      .first<{ status: string }>();
    assert.strictEqual(row?.status, 'churned');
  });
});
