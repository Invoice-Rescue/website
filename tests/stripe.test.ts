import { test, describe } from "node:test";
import assert from "node:assert";
import { verifyWebhookSignature } from "../backend/src/lib/stripe";

describe("stripe webhook signature verification", () => {
  const webhookSecret = "whsec_test_secret_1234567890abcdef";
  const payload = JSON.stringify({ id: "evt_123", type: "customer.subscription.updated" });

  async function generateValidHeader(body: string, secret: string, timestampSeconds: number): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampSeconds}.${body}`));
    const hex = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `t=${timestampSeconds},v1=${hex}`;
  }

  test("accepts valid webhook signature within 5 minute tolerance window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await generateValidHeader(payload, webhookSecret, now);

    const isValid = await verifyWebhookSignature(payload, header, webhookSecret);
    assert.strictEqual(isValid, true);
  });

  test("rejects webhook with expired timestamp (replay attack protection)", async () => {
    const sixMinutesAgo = Math.floor(Date.now() / 1000) - 360;
    const header = await generateValidHeader(payload, webhookSecret, sixMinutesAgo);

    const isValid = await verifyWebhookSignature(payload, header, webhookSecret);
    assert.strictEqual(isValid, false);
  });

  test("rejects corrupted payload or altered signature", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await generateValidHeader(payload, webhookSecret, now);

    const isAlteredPayloadValid = await verifyWebhookSignature(payload + " ", header, webhookSecret);
    assert.strictEqual(isAlteredPayloadValid, false);

    const badSigHeader = `t=${now},v1=0000000000000000000000000000000000000000000000000000000000000000`;
    const isBadSigValid = await verifyWebhookSignature(payload, badSigHeader, webhookSecret);
    assert.strictEqual(isBadSigValid, false);
  });

  test("fails closed when signature header or secret is missing", async () => {
    assert.strictEqual(await verifyWebhookSignature(payload, null, webhookSecret), false);
    assert.strictEqual(await verifyWebhookSignature(payload, "t=123,v1=abc", ""), false);
  });
});
