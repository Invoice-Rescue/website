/**
 * Client portal auth — magic link + session, both as HMAC-signed tokens.
 * No password storage: a client requests a link, we email a short-lived
 * "login" token, clicking it exchanges for a longer-lived "session" token
 * set as an HttpOnly cookie. Uses Web Crypto (built into Workers) — no JWT
 * library needed for a single-claim token.
 *
 * Token shape: base64url(JSON payload) + "." + base64url(HMAC-SHA256 sig)
 */

export interface TokenPayload {
  cid: number; // client id
  purpose: 'login' | 'session';
  exp: number; // unix seconds
  jti?: string; // login tokens only: random id, consumed on first use (single-use magic links)
  ep?: number; // session tokens only: clients.session_epoch at issue time (bumped on logout)
}

/** The D1 + secret slice of Env that session checks need — narrow so tests can pass a stub. */
export interface SessionAuthEnv {
  DB: D1Database;
  PORTAL_SESSION_SECRET: string;
}

const LOGIN_TOKEN_TTL_SECONDS = 15 * 60; // magic link expires in 15 minutes
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // session cookie lasts 7 days
const SESSION_COOKIE_NAME = 'portal_session';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array | null {
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

async function hmacKey(secret: string): Promise<CryptoKey> {
  // Guard against PORTAL_SESSION_SECRET being unset: TextEncoder.encode(undefined) silently
  // encodes "" rather than throwing, which would sign every token with a known, empty key —
  // fail closed instead (the fetch() handler's catch-all turns this into a generic 500).
  if (!secret) throw new Error('portal session secret is not configured');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signToken(payload: TokenPayload, secret: string): Promise<string> {
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Returns the payload if the signature is valid, unexpired, and matches the expected purpose — null otherwise. */
async function verifyToken(
  token: string,
  secret: string,
  expectedPurpose: TokenPayload['purpose']
): Promise<TokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const sigBytes = fromBase64Url(sigB64);
  const payloadBytes = fromBase64Url(payloadB64);
  if (!sigBytes || !payloadBytes) return null;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    new TextEncoder().encode(payloadB64)
  );
  if (!valid) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (payload.purpose !== expectedPurpose) return null;
  if (typeof payload.cid !== 'number' || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

export async function signLoginToken(clientId: number, secret: string): Promise<string> {
  return signToken(
    {
      cid: clientId,
      purpose: 'login',
      exp: Math.floor(Date.now() / 1000) + LOGIN_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    },
    secret
  );
}

/** Signature/expiry/purpose check only — does NOT consume the token. Use consumeLoginToken to log in. */
export async function verifyLoginToken(token: string, secret: string): Promise<number | null> {
  const payload = await verifyToken(token, secret, 'login');
  return payload ? payload.cid : null;
}

/**
 * Verifies a magic-link token AND marks it used, so each link logs in at most once. A leaked link
 * (forwarded email, browser history, Referer) is otherwise a reusable bearer credential for its
 * whole 15-minute life. Tokens minted before jti existed are rejected — they expire within 15 min.
 */
export async function consumeLoginToken(
  token: string,
  env: SessionAuthEnv
): Promise<number | null> {
  const payload = await verifyToken(token, env.PORTAL_SESSION_SECRET, 'login');
  if (!payload || typeof payload.jti !== 'string' || payload.jti === '') return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const insert = await env.DB.prepare(
    `INSERT INTO consumed_login_tokens (jti, client_id, expires_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (jti) DO NOTHING`
  )
    .bind(payload.jti, payload.cid, payload.exp)
    .run();
  if (insert.meta.changes !== 1) return null;

  // Opportunistic cleanup: consumed rows are only needed until the token would have expired anyway.
  await env.DB.prepare(`DELETE FROM consumed_login_tokens WHERE expires_at < ?1`)
    .bind(nowSeconds)
    .run();
  return payload.cid;
}

async function signSessionToken(
  clientId: number,
  secret: string,
  sessionEpoch: number
): Promise<string> {
  return signToken(
    {
      cid: clientId,
      purpose: 'session',
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      ep: sessionEpoch,
    },
    secret
  );
}

export async function verifySessionToken(token: string, secret: string): Promise<number | null> {
  const payload = await verifyToken(token, secret, 'session');
  return payload ? payload.cid : null;
}

/**
 * Set-Cookie header value for a freshly-issued session. `sessionEpoch` must be the client's current
 * clients.session_epoch (0 is the column default, so a never-logged-out client is at 0).
 */
export async function buildSessionCookie(
  clientId: number,
  secret: string,
  sessionEpoch = 0
): Promise<string> {
  const token = await signSessionToken(clientId, secret, sessionEpoch);
  // Path=/ (not /portal): the SPA lives at /dashboard/* and calls /api/portal/*, neither of
  // which falls under /portal per RFC 6265 path matching — a narrower path meant the cookie
  // never attached and every real session fell through to the anonymous path in portal-api.ts.
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** Set-Cookie header value that clears the session cookie. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Extracts the session token from a request's Cookie header, if present. */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
  return match ? match[1] : null;
}

/** Reads the client's current session epoch, or null if the client no longer exists. */
export async function readSessionEpoch(db: D1Database, clientId: number): Promise<number | null> {
  const row = await db
    .prepare(`SELECT session_epoch FROM clients WHERE id = ?1`)
    .bind(clientId)
    .first<{ session_epoch: number }>();
  return row ? row.session_epoch : null;
}

/**
 * Full session check: valid signature/expiry/purpose AND the token's epoch matches the client's
 * current session_epoch (so logout revokes it) AND the client still exists. Tokens issued before
 * epochs existed carry no `ep` and are treated as epoch 0 — valid until that client's next logout.
 */
export async function verifySessionForClient(
  token: string,
  env: SessionAuthEnv
): Promise<number | null> {
  const payload = await verifyToken(token, env.PORTAL_SESSION_SECRET, 'session');
  if (!payload) return null;
  const currentEpoch = await readSessionEpoch(env.DB, payload.cid);
  if (currentEpoch === null || (payload.ep ?? 0) !== currentEpoch) return null;
  return payload.cid;
}

/** Invalidates every session previously issued to this client ("log out everywhere"). */
export async function revokeClientSessions(db: D1Database, clientId: number): Promise<void> {
  await db
    .prepare(`UPDATE clients SET session_epoch = session_epoch + 1 WHERE id = ?1`)
    .bind(clientId)
    .run();
}

/** Resolves the authenticated client id from a request's session cookie, or null if absent/invalid/expired/revoked. */
export async function authenticateClient(
  request: Request,
  env: SessionAuthEnv
): Promise<number | null> {
  const token = readSessionCookie(request);
  if (!token) return null;
  return verifySessionForClient(token, env);
}
