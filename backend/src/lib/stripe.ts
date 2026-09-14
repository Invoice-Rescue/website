/**
 * Minimal Stripe REST client — plain fetch() calls, no stripe-node dependency.
 * Covers exactly what the client portal needs: create a customer at
 * onboarding, mint a billing-portal session, and verify webhook signatures.
 */

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** Best-effort: returns the new customer id, or null if Stripe rejects/errors (caller must not block on this). */
export async function createCustomer(
  secretKey: string,
  input: { name: string; email: string },
): Promise<string | null> {
  const res = await fetch(`${STRIPE_API_BASE}/customers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ name: input.name, email: input.email }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id?: string };
  return data.id ?? null;
}

/** Returns the hosted billing-portal URL to redirect the client to, or null on failure. */
export async function createBillingPortalSession(
  secretKey: string,
  customerId: string,
  returnUrl: string,
): Promise<string | null> {
  const res = await fetch(`${STRIPE_API_BASE}/billing_portal/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ customer: customerId, return_url: returnUrl }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { url?: string };
  return data.url ?? null;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Verifies a Stripe webhook per https://docs.stripe.com/webhooks#verify-manually — checks the
 * HMAC-SHA256 signature AND rejects timestamps older than 5 minutes (replay protection). */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  // Fail closed if STRIPE_WEBHOOK_SECRET is unset, same reasoning as portal-auth.ts's hmacKey.
  if (!webhookSecret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    }),
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const toleranceSeconds = 300;
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || age > toleranceSeconds || age < -toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, hexToBytes(v1), new TextEncoder().encode(`${timestamp}.${rawBody}`));
}

export interface StripeSubscriptionEvent {
  type: string;
  data: { object: { customer: string; status?: string } };
}
