/**
 * Minimal Stripe REST client — plain fetch() calls, no stripe-node dependency.
 * Covers exactly what the client portal needs: create a customer at
 * onboarding, mint a billing-portal session, and verify webhook signatures.
 */

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/** Logs a non-OK Stripe response: status plus Stripe's error type/code only — never the key or request body. */
async function logStripeError(operation: string, res: Response): Promise<void> {
  let type: string | undefined;
  let code: string | undefined;
  try {
    const body = await res.json<{ error?: { type?: unknown; code?: unknown } }>();
    if (typeof body.error?.type === 'string') type = body.error.type;
    if (typeof body.error?.code === 'string') code = body.error.code;
  } catch {
    // Non-JSON error body (e.g. upstream proxy page) — status alone is still logged below.
  }
  console.error(
    `[stripe] ${operation} failed: status=${res.status} type=${type ?? 'unknown'} code=${code ?? 'none'}`
  );
}

/** Best-effort: returns the new customer id, or null if Stripe rejects/errors (caller must not block on this). */
export async function createCustomer(
  secretKey: string,
  input: { name: string; email: string }
): Promise<string | null> {
  const res = await fetch(`${STRIPE_API_BASE}/customers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ name: input.name, email: input.email }),
  });
  if (!res.ok) {
    await logStripeError('createCustomer', res);
    return null;
  }
  const data = await res.json<{ id?: unknown }>();
  return typeof data.id === 'string' ? data.id : null;
}

/** Returns the hosted billing-portal URL to redirect the client to, or null on failure. */
export async function createBillingPortalSession(
  secretKey: string,
  customerId: string,
  returnUrl: string
): Promise<string | null> {
  const res = await fetch(`${STRIPE_API_BASE}/billing_portal/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ customer: customerId, return_url: returnUrl }),
  });
  if (!res.ok) {
    await logStripeError('createBillingPortalSession', res);
    return null;
  }
  const data = await res.json<{ url?: unknown }>();
  return typeof data.url === 'string' ? data.url : null;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Verifies a Stripe webhook per https://docs.stripe.com/webhooks#verify-manually — checks the
 * HMAC-SHA256 signature AND rejects timestamps older than 5 minutes (replay protection).
 * The header may carry several v1 signatures (one per active secret while rolling the endpoint
 * secret); per Stripe's docs the event is valid if ANY one of them matches. */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string
): Promise<boolean> {
  if (!signatureHeader) return false;
  // Fail closed if STRIPE_WEBHOOK_SECRET is unset, same reasoning as portal-auth.ts's hmacKey.
  if (!webhookSecret) return false;

  let timestamp: string | undefined;
  const v1Signatures: string[] = [];
  for (const pair of signatureHeader.split(',')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1' && HEX_SHA256.test(value)) v1Signatures.push(value);
  }
  if (!timestamp || v1Signatures.length === 0) return false;

  const toleranceSeconds = 300;
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || age > toleranceSeconds || age < -toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const signedPayload = new TextEncoder().encode(`${timestamp}.${rawBody}`);
  // crypto.subtle.verify is a constant-time comparison per candidate.
  for (const candidate of v1Signatures) {
    if (await crypto.subtle.verify('HMAC', key, hexToBytes(candidate), signedPayload)) return true;
  }
  return false;
}

export interface StripeEvent {
  id?: string;
  type: string;
  created?: number;
  data: { object: { customer?: string; status?: string } };
}

/** Parses an already signature-verified webhook body. Returns null for non-JSON or a body missing
 * `type`/`data.object`, so the caller can answer 400 instead of throwing a 500 (which Stripe retries). */
export function parseWebhookEvent(rawBody: string): StripeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as {
    id?: unknown;
    type?: unknown;
    created?: unknown;
    data?: { object?: unknown };
  };
  if (typeof candidate.type !== 'string') return null;
  const object = candidate.data?.object;
  if (typeof object !== 'object' || object === null) return null;
  const { customer, status } = object as { customer?: unknown; status?: unknown };

  return {
    id: typeof candidate.id === 'string' ? candidate.id : undefined,
    type: candidate.type,
    created: typeof candidate.created === 'number' ? candidate.created : undefined,
    data: {
      object: {
        customer: typeof customer === 'string' ? customer : undefined,
        status: typeof status === 'string' ? status : undefined,
      },
    },
  };
}

export interface StripeSubscriptionEvent {
  type: string;
  data: { object: { customer: string; status?: string } };
}
