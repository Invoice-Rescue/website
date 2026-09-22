/**
 * OAuth 2.0 Manager for Xero and QuickBooks
 * Zero-external-dependency implementation using Web Crypto API and native fetch.
 */

export interface OAuthStatePayload {
  cid: number; // Client ID (tenant binding)
  p: 'xero' | 'quickbooks'; // Provider
  nonce: string; // Cryptographic entropy (anti-CSRF)
  exp: number; // Expiration timestamp in seconds
  ret: string; // Return redirect path
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tenantId: string;
}

/**
 * Error hierarchy for OAuth operations adhering to error-handling skill patterns.
 */
export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OAuthTokenExchangeError extends OAuthError {
  constructor(message: string, statusCode = 502, details?: unknown) {
    super(message, 'OAUTH_TOKEN_EXCHANGE_FAILED', statusCode, details);
  }
}

export class OAuthTokenRefreshError extends OAuthError {
  constructor(message: string, statusCode = 502, details?: unknown) {
    super(message, 'OAUTH_TOKEN_REFRESH_FAILED', statusCode, details);
  }
}

export class OAuthConnectionError extends OAuthError {
  constructor(message: string, statusCode = 502, details?: unknown) {
    super(message, 'OAUTH_CONNECTION_ERROR', statusCode, details);
  }
}

export class OAuthValidationError extends OAuthError {
  constructor(message: string, details?: unknown) {
    super(message, 'OAUTH_VALIDATION_ERROR', 400, details);
  }
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
}

export interface XeroConnectionResponse {
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName?: string;
  createdDateUtc?: string;
  updatedDateUtc?: string;
}

function parseTokenPayload(
  data: unknown,
  provider: string,
  isRefresh: boolean
): OAuthTokenResponse {
  if (typeof data !== 'object' || data === null) {
    const message = isRefresh
      ? `Token refresh failed (${provider}): response is not a valid JSON object`
      : `Token exchange failed (${provider}): response is not a valid JSON object`;
    throw isRefresh
      ? new OAuthTokenRefreshError(message, 502, data)
      : new OAuthTokenExchangeError(message, 502, data);
  }

  const candidate = data as Record<string, unknown>;
  const accessToken = typeof candidate.access_token === 'string' ? candidate.access_token : null;
  const refreshToken = typeof candidate.refresh_token === 'string' ? candidate.refresh_token : null;

  let expiresIn: number | null = null;
  if (typeof candidate.expires_in === 'number' && Number.isFinite(candidate.expires_in)) {
    expiresIn = candidate.expires_in;
  } else if (typeof candidate.expires_in === 'string') {
    const parsed = Number(candidate.expires_in);
    if (Number.isFinite(parsed)) {
      expiresIn = parsed;
    }
  }

  if (!accessToken || !refreshToken || expiresIn === null) {
    const message = isRefresh
      ? `Token refresh failed (${provider}): missing required token fields`
      : `Token exchange failed (${provider}): missing required token fields`;
    throw isRefresh
      ? new OAuthTokenRefreshError(message, 502, data)
      : new OAuthTokenExchangeError(message, 502, data);
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    ...(typeof candidate.token_type === 'string' ? { token_type: candidate.token_type } : {}),
    ...(typeof candidate.scope === 'string' ? { scope: candidate.scope } : {}),
    ...(typeof candidate.id_token === 'string' ? { id_token: candidate.id_token } : {}),
  };
}

function parseXeroConnections(data: unknown): XeroConnectionResponse[] {
  if (!Array.isArray(data)) {
    throw new OAuthConnectionError(
      'Xero connections fetch failed: response is not an array',
      502,
      data
    );
  }

  const connections: XeroConnectionResponse[] = [];
  for (const item of data) {
    if (typeof item === 'object' && item !== null) {
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.id === 'string' &&
        typeof candidate.tenantId === 'string' &&
        typeof candidate.tenantType === 'string'
      ) {
        connections.push({
          id: candidate.id,
          tenantId: candidate.tenantId,
          tenantType: candidate.tenantType,
          ...(typeof candidate.tenantName === 'string' ? { tenantName: candidate.tenantName } : {}),
          ...(typeof candidate.createdDateUtc === 'string'
            ? { createdDateUtc: candidate.createdDateUtc }
            : {}),
          ...(typeof candidate.updatedDateUtc === 'string'
            ? { updatedDateUtc: candidate.updatedDateUtc }
            : {}),
        });
      }
    }
  }

  return connections;
}

export const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
export const XERO_REVOKE_URL = 'https://identity.xero.com/connect/revocation';
export const XERO_SCOPES =
  'offline_access accounting.transactions accounting.contacts.read accounting.settings.read openid profile email';

export const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QB_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const QB_SCOPES = 'com.intuit.quickbooks.accounting openid email';

/** Utility: Base64URL encoding/decoding */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array | null {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Resolves the key material for OAuth token encryption. Uses a dedicated
 * TOKEN_ENCRYPTION_SECRET when configured; otherwise derives a key from
 * PORTAL_SESSION_SECRET via HMAC-SHA256 with a fixed domain-separation
 * label, so the bytes used to encrypt tokens differ from the bytes used to
 * sign portal session tokens even when only one secret is provisioned.
 */
export async function resolveTokenEncryptionSecret(env: Env): Promise<string> {
  const dedicated = (env as any).TOKEN_ENCRYPTION_SECRET;
  if (dedicated) return dedicated;

  const portalSecret = env.PORTAL_SESSION_SECRET;
  if (!portalSecret) {
    throw new Error('TOKEN_ENCRYPTION_SECRET configuration error: secret is missing.');
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(portalSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode('invoice-rescue:token-encryption-v1')
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Encrypts a token using AES-GCM (256-bit) with a random 12-byte IV.
 */
export async function encryptToken(plaintext: string, secretKey: string): Promise<string> {
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode(secretKey));
  const cryptoKey = await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);

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
  const cryptoKey = await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);

  return decoder.decode(decrypted);
}

/**
 * Decrypts a stored OAuth token, tolerating tokens encrypted before the
 * TOKEN_ENCRYPTION_SECRET key-derivation fix shipped: those were encrypted
 * directly with the raw PORTAL_SESSION_SECRET. Tries the current key first
 * (dedicated TOKEN_ENCRYPTION_SECRET, or the HMAC-derived fallback); if that
 * fails AND no dedicated secret is configured, retries with the raw session
 * secret so already-connected clients aren't silently logged out of
 * Xero/QuickBooks on the next sync. Only reads need this — new tokens are
 * always written with the current key via encryptToken + resolveTokenEncryptionSecret.
 */
export async function decryptStoredToken(ciphertextWithIv: string, env: Env): Promise<string> {
  const currentSecret = await resolveTokenEncryptionSecret(env);
  try {
    return await decryptToken(ciphertextWithIv, currentSecret);
  } catch (err) {
    if ((env as any).TOKEN_ENCRYPTION_SECRET) throw err;
    return decryptToken(ciphertextWithIv, env.PORTAL_SESSION_SECRET);
  }
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
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;

  const fullPayload: OAuthStatePayload = { ...payload, nonce, exp };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(fullPayload)));

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
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
  if (!state || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const payloadBytes = fromBase64Url(payloadB64);
  const sigBytes = fromBase64Url(sigB64);
  if (!payloadBytes || !sigBytes) return null;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      new TextEncoder().encode(payloadB64)
    );
    if (!isValid) return null;

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as OAuthStatePayload;

    if (expectedProvider && payload.p !== expectedProvider) return null;
    if (typeof payload.cid !== 'number' || typeof payload.exp !== 'number') return null;
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
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: XERO_SCOPES,
      state,
    });
    return `${XERO_AUTH_URL}?${params.toString()}`;
  } else {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
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
  if (provider === 'quickbooks' && !realmId) {
    throw new OAuthValidationError('QuickBooks realmId missing from callback');
  }

  const tokenUrl = provider === 'xero' ? XERO_TOKEN_URL : QB_TOKEN_URL;
  const basicAuth = btoa(`${clientCredentials.clientId}:${clientCredentials.clientSecret}`);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new OAuthTokenExchangeError(
      `Token exchange failed (${res.status}): ${errText}`,
      res.status >= 500 ? 502 : res.status
    );
  }

  let rawTokenData: unknown;
  try {
    rawTokenData = await res.json();
  } catch (err: unknown) {
    throw new OAuthTokenExchangeError(
      `Token exchange failed (${res.status}): invalid JSON response (${err instanceof Error ? err.message : String(err)})`,
      502,
      err
    );
  }

  const tokenData = parseTokenPayload(rawTokenData, provider, false);

  let tenantId: string;
  if (provider === 'quickbooks') {
    if (!realmId) throw new OAuthValidationError('QuickBooks realmId missing from callback');
    tenantId = realmId;
  } else {
    // Xero tenant resolution via /connections
    const connRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
      },
    });
    if (!connRes.ok) {
      const errText = await connRes.text();
      throw new OAuthConnectionError(`Xero connections fetch failed: ${errText}`, connRes.status);
    }

    let rawConnections: unknown;
    try {
      rawConnections = await connRes.json();
    } catch (err: unknown) {
      throw new OAuthConnectionError(
        `Xero connections fetch failed: invalid JSON response (${err instanceof Error ? err.message : String(err)})`,
        502,
        err
      );
    }

    const connections = parseXeroConnections(rawConnections);
    if (connections.length === 0) {
      throw new OAuthConnectionError('No connected Xero organization found', 404);
    }
    const org = connections.find((c) => c.tenantType === 'ORGANISATION') ?? connections[0];
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
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new OAuthTokenRefreshError(
      `Token refresh failed (${res.status}): ${errText}`,
      res.status >= 500 ? 502 : res.status
    );
  }

  let rawTokenData: unknown;
  try {
    rawTokenData = await res.json();
  } catch (err: unknown) {
    throw new OAuthTokenRefreshError(
      `Token refresh failed (${res.status}): invalid JSON response (${err instanceof Error ? err.message : String(err)})`,
      502,
      err
    );
  }

  const tokenData = parseTokenPayload(rawTokenData, provider, true);

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
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch (err: unknown) {
    console.warn(`Upstream token revocation failed (${provider}):`, err);
  }
}
