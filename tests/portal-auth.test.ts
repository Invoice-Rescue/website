import { test, describe } from "node:test";
import assert from "node:assert";
import {
  signLoginToken,
  verifyLoginToken,
  buildSessionCookie,
  clearSessionCookie,
  authenticateClient,
  verifySessionToken,
} from "../backend/src/lib/portal-auth";

describe("portal-auth", () => {
  const testSecret = "test-portal-secret-key-32-bytes-long!";

  test("signs and verifies login magic link token for a client", async () => {
    const clientId = 42;
    const token = await signLoginToken(clientId, testSecret);
    assert.strictEqual(typeof token, "string");
    assert.ok(token.includes("."));

    const verifiedId = await verifyLoginToken(token, testSecret);
    assert.strictEqual(verifiedId, clientId);
  });

  test("rejects tampered or corrupted login token", async () => {
    const token = await signLoginToken(10, testSecret);
    const [payloadB64, sig] = token.split(".");
    const tamperedToken = `${payloadB64}x.${sig}`;

    const verified = await verifyLoginToken(tamperedToken, testSecret);
    assert.strictEqual(verified, null);
  });

  test("rejects token signed with wrong secret", async () => {
    const token = await signLoginToken(10, testSecret);
    const verified = await verifyLoginToken(token, "different-wrong-secret-key-32b");
    assert.strictEqual(verified, null);
  });

  test("rejects token when secret is empty string (fail closed)", async () => {
    await assert.rejects(
      async () => {
        await signLoginToken(1, "");
      },
      { message: /portal session secret is not configured/ },
    );
  });

  test("builds and verifies portal session cookie", async () => {
    const clientId = 101;
    const cookieHeader = await buildSessionCookie(clientId, testSecret);
    assert.ok(cookieHeader.includes("portal_session="));
    assert.ok(cookieHeader.includes("HttpOnly"));
    assert.ok(cookieHeader.includes("SameSite=Lax"));

    const rawToken = cookieHeader.split("portal_session=")[1].split(";")[0];
    const verifiedId = await verifySessionToken(rawToken, testSecret);
    assert.strictEqual(verifiedId, clientId);

    const request = new Request("https://invoicerescue.co.uk/portal/dashboard", {
      headers: {
        Cookie: `other=123; portal_session=${rawToken}; foo=bar`,
      },
    });
    const authId = await authenticateClient(request, testSecret);
    assert.strictEqual(authId, clientId);
  });

  test("authenticateClient returns null when cookie is missing or invalid", async () => {
    const requestNoCookie = new Request("https://invoicerescue.co.uk/portal/dashboard");
    assert.strictEqual(await authenticateClient(requestNoCookie, testSecret), null);

    const requestBadCookie = new Request("https://invoicerescue.co.uk/portal/dashboard", {
      headers: { Cookie: "portal_session=invalid.token" },
    });
    assert.strictEqual(await authenticateClient(requestBadCookie, testSecret), null);
  });

  test("clearSessionCookie returns expired cookie instruction", () => {
    const clearHeader = clearSessionCookie();
    assert.ok(clearHeader.includes("Max-Age=0"));
    assert.ok(clearHeader.includes("portal_session="));
  });
});
