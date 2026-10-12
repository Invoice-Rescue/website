import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import {
  createBillingPortalSession,
  createCustomer,
  parseWebhookEvent,
  verifyWebhookSignature,
} from '../backend/src/lib/stripe';

const webhookSecret = 'whsec_test_secret_1234567890abcdef';
const payload = JSON.stringify({
  id: 'evt_123',
  type: 'customer.subscription.updated',
  data: { object: {} },
});

async function sign(body: string, secret: string, timestampSeconds: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestampSeconds}.${body}`)
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const otherSig = 'a'.repeat(64);

describe('verifyWebhookSignature with multiple v1 signatures (secret rotation)', () => {
  test('accepts when the valid v1 comes first', async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = await sign(payload, webhookSecret, now);
    const header = `t=${now},v1=${valid},v1=${otherSig}`;
    assert.strictEqual(await verifyWebhookSignature(payload, header, webhookSecret), true);
  });

  test('accepts when the valid v1 comes second', async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = await sign(payload, webhookSecret, now);
    const header = `t=${now},v1=${otherSig},v1=${valid}`;
    assert.strictEqual(await verifyWebhookSignature(payload, header, webhookSecret), true);
  });

  test('accepts a signature made with the old secret during rotation', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fromNew = await sign(payload, 'whsec_new', now);
    const fromOld = await sign(payload, webhookSecret, now);
    const header = `t=${now},v1=${fromNew},v1=${fromOld},v0=${otherSig}`;
    assert.strictEqual(await verifyWebhookSignature(payload, header, webhookSecret), true);
  });

  test('rejects when every v1 is invalid', async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = `t=${now},v1=${otherSig},v1=${'b'.repeat(64)}`;
    assert.strictEqual(await verifyWebhookSignature(payload, header, webhookSecret), false);
  });

  test('still fails closed on missing secret, missing t, and stale timestamp', async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = await sign(payload, webhookSecret, now);
    assert.strictEqual(await verifyWebhookSignature(payload, `t=${now},v1=${valid}`, ''), false);
    assert.strictEqual(await verifyWebhookSignature(payload, `v1=${valid}`, webhookSecret), false);
    const stale = now - 301;
    const staleSig = await sign(payload, webhookSecret, stale);
    assert.strictEqual(
      await verifyWebhookSignature(payload, `t=${stale},v1=${staleSig}`, webhookSecret),
      false
    );
  });
});

describe('parseWebhookEvent', () => {
  test('returns null for a non-JSON body', () => {
    assert.strictEqual(parseWebhookEvent('not json at all'), null);
  });

  test('returns null for JSON of the wrong shape', () => {
    assert.strictEqual(parseWebhookEvent('null'), null);
    assert.strictEqual(parseWebhookEvent('[1,2]'), null);
    assert.strictEqual(parseWebhookEvent(JSON.stringify({ type: 'x' })), null);
    assert.strictEqual(parseWebhookEvent(JSON.stringify({ type: 1, data: { object: {} } })), null);
  });

  test('returns a typed event for a valid body, dropping wrongly typed optional fields', () => {
    const event = parseWebhookEvent(
      JSON.stringify({
        id: 'evt_1',
        type: 'customer.subscription.deleted',
        created: 1700000000,
        data: { object: { customer: 'cus_1', status: 42 } },
      })
    );
    assert.deepStrictEqual(event, {
      id: 'evt_1',
      type: 'customer.subscription.deleted',
      created: 1700000000,
      data: { object: { customer: 'cus_1', status: undefined } },
    });
  });
});

describe('Stripe fetch helpers log non-OK responses', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  test('createCustomer logs status and Stripe error type/code, never the key or body', async () => {
    mock.method(globalThis, 'fetch', async () =>
      Response.json(
        {
          error: { type: 'invalid_request_error', code: 'email_invalid', message: 'Invalid email' },
        },
        { status: 400 }
      )
    );
    const errorLog = mock.method(console, 'error', () => {});

    const result = await createCustomer('sk_test_SECRETKEY', {
      name: 'Acme',
      email: 'bad@example.com',
    });

    assert.strictEqual(result, null);
    assert.strictEqual(errorLog.mock.callCount(), 1);
    const line = String(errorLog.mock.calls[0].arguments[0]);
    assert.match(line, /status=400/);
    assert.match(line, /invalid_request_error/);
    assert.match(line, /email_invalid/);
    assert.doesNotMatch(line, /sk_test_SECRETKEY/);
    assert.doesNotMatch(line, /bad@example\.com/);
  });

  test('createBillingPortalSession logs a non-JSON error body by status alone', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () => new Response('<html>bad gateway</html>', { status: 502 })
    );
    const errorLog = mock.method(console, 'error', () => {});

    const result = await createBillingPortalSession(
      'sk_test_SECRETKEY',
      'cus_1',
      'https://example.com'
    );

    assert.strictEqual(result, null);
    assert.strictEqual(errorLog.mock.callCount(), 1);
    assert.match(String(errorLog.mock.calls[0].arguments[0]), /status=502/);
  });
});
