import { test } from 'node:test';
import * as assert from 'node:assert';
import { verifyQuickBooksWebhook, verifyXeroWebhook } from '../backend/src/lib/integrations/webhooks';

test('QuickBooks webhook signature verification', async () => {
  const payload = JSON.stringify({ some: 'data' });
  const verifierToken = 'test-token';
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(verifierToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const validSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  
  const isValid = await verifyQuickBooksWebhook(payload, validSignature, verifierToken);
  assert.strictEqual(isValid, true);
  
  const isInvalid = await verifyQuickBooksWebhook(payload, 'invalid-signature', verifierToken);
  assert.strictEqual(isInvalid, false);
});

test('Xero webhook signature verification', async () => {
  const payload = JSON.stringify({ events: [] });
  const webhookKey = 'xero-key';
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(webhookKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const validSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  
  const isValid = await verifyXeroWebhook(payload, validSignature, webhookKey);
  assert.strictEqual(isValid, true);
  
  const isInvalid = await verifyXeroWebhook(payload, 'wrong-sig', webhookKey);
  assert.strictEqual(isInvalid, false);
});
