/**
 * OAuth 2.0 Manager for Xero and QuickBooks
 * Zero-external-dependency implementation using Web Crypto API and native fetch.
 */

export interface OAuthStatePayload {
  cid: number;                  // Client ID (tenant binding)
  p: 'xero' | 'quickbooks';     // Provider
  nonce: string;                // Cryptographic entropy (anti-CSRF)
  exp: number;                  // Expiration timestamp in seconds
  ret: string;                  // Return redirect path
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tenantId: string;
}

export const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
export const XERO_REVOKE_URL = "https://identity.xero.com/connect/revocation";
export const XERO_SCOPES = "offline_access accounting.transactions accounting.contacts.read accounting.settings.read openid profile email";

export const QB_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QB_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QB_SCOPES = "com.intuit.quickbooks.accounting openid email";

/** Utility: Base64URL encoding/decoding */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Encrypts a token using AES-GCM (256-bit) with a random 12-byte IV.
 */
export async function encryptToken(plaintext: string, secretKey: string): Promise<string> {
  const encoder = new TextEncoder();
  
  const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode(secretKey));
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encoder.encode(plaintext)
  );

  const encryptedBytes = new Uint8Array(encrypted);
  const result = new Uint8Array(iv.length + encryptedBytes.length);
  result.set(iv, 0);
  result.set(encryptedBytes, iv.length);
  
  return btoa(String.fromCharCode(...result));
}

/**
 * Decrypts an AES-GCM ciphertext string with 12-byte IV prepended.
 */
export async function decryptToken(ciphertextWithIv: string, secretKey: string): Promise<string> {
  const decoder = new TextDecoder();
  
  const binaryStr = atob(ciphertextWithIv);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode(secretKey));
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );

  return decoder.decode(decrypted);
}

/**
 * Generates a signed, tamper-proof state token containing tenant client ID and provider.
 */
export async function generateOAuthState(
  payload: Omit<OAuthStatePayload, 'exp' | 'nonce'>,
  secretKey: string,
  ttlSeconds = 600
): Promise<string> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;

  const fullPayload: OAuthStatePayload = { ...payload, nonce, exp };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(fullPayload)));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * Verifies and parses an OAuth state token.
 */
export async function verifyOAuthState(
  state: string,
  secretKey: string,
  expectedProvider?: 'xero' | 'quickbooks'
): Promise<OAuthStatePayload | null> {
  if (!state || typeof state !== "string") return null;
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const payloadBytes = fromBase64Url(payloadB64);
  const sigBytes = fromBase64Url(sigB64);
  if (!payloadBytes || !sigBytes) return null;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secretKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const isValid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payloadB64));
    if (!isValid) return null;

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as OAuthStatePayload;

    if (expectedProvider && payload.p !== expectedProvider) return null;
    if (typeof payload.cid !== "number" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Constructs the provider authorization redirect URL.
 */
export function buildAuthorizationUrl(
  provider: 'xero' | 'quickbooks',
  clientId: string,
  redirectUri: string,
  state: string
): string {
  if (provider === 'xero') {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: XERO_SCOPES,
      state,
    });
    return `${XERO_AUTH_URL}?${params.toString()}`;
  } else {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      scope: QB_SCOPES,
      redirect_uri: redirectUri,
      state,
    });
    return `${QB_AUTH_URL}?${params.toString()}`;
  }
}

/**
 * Exchanges authorization code for tokens and resolves tenant ID.
 */
export async function exchangeCodeForTokens(
  provider: 'xero' | 'quickbooks',
  code: string,
  redirectUri: string,
  clientCredentials: { clientId: string; clientSecret: string },
  realmId?: string | null
): Promise<TokenExchangeResult> {
  const tokenUrl = provider === 'xero' ? XERO_TOKEN_URL : QB_TOKEN_URL;
  const basicAuth = btoa(`${clientCredentials.clientId}:${clientCredentials.clientSecret}`);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${errText}`);
  }

  const tokenData = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  let tenantId = "";
  if (provider === 'quickbooks') {
    if (!realmId) throw new Error("QuickBooks realmId missing from callback");
    tenantId = realmId;
  } else {
    // Xero tenant resolution via /connections
    const connRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: {
        "Authorization": `Bearer ${tokenData.access_token}`,
        "Accept": "application/json",
      },
    });
    if (!connRes.ok) {
      throw new Error(`Xero connections fetch failed: ${await connRes.text()}`);
    }
    const connections = (await connRes.json()) as Array<{ tenantId: string; tenantType?: string }>;
    if (!connections || connections.length === 0) {
      throw new Error("No connected Xero organization found");
    }
    const org = connections.find(c => c.tenantType === "ORGANISATION") || connections[0];
    tenantId = org.tenantId;
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    tenantId,
  };
}

/**
 * Refreshes tokens for an accounting connection.
 */
export async function refreshProviderTokens(
  provider: 'xero' | 'quickbooks',
  refreshToken: string,
  clientCredentials: { clientId: string; clientSecret: string }
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const tokenUrl = provider === 'xero' ? XERO_TOKEN_URL : QB_TOKEN_URL;
  const basicAuth = btoa(`${clientCredentials.clientId}:${clientCredentials.clientSecret}`);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${errText}`);
  }

  const tokenData = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
  };
}

/**
 * Revokes a provider token (best effort).
 */
export async function revokeProviderToken(
  provider: 'xero' | 'quickbooks',
  token: string,
  clientCredentials: { clientId: string; clientSecret: string }
): Promise<void> {
  const revokeUrl = provider === 'xero' ? XERO_REVOKE_URL : QB_REVOKE_URL;
  const basicAuth = btoa(`${clientCredentials.clientId}:${clientCredentials.clientSecret}`);

  try {
    await fetch(revokeUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch (err) {
    console.warn(`Upstream token revocation failed (${provider}):`, err);
  }
}
