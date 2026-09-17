/**
 * Client portal auth — magic link + session, both as HMAC-signed tokens.
 * No password storage: a client requests a link, we email a short-lived
 * "login" token, clicking it exchanges for a longer-lived "session" token
 * set as an HttpOnly cookie. Uses Web Crypto (built into Workers) — no JWT
 * library needed for a single-claim token.
 *
 * Token shape: base64url(JSON payload) + "." + base64url(HMAC-SHA256 sig)
 */
const LOGIN_TOKEN_TTL_SECONDS = 15 * 60; // magic link expires in 15 minutes
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // session cookie lasts 7 days
const SESSION_COOKIE_NAME = "portal_session";
function toBase64Url(bytes) {
    let binary = "";
    for (const b of bytes)
        binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(s) {
    try {
        const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++)
            bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    catch {
        return null;
    }
}
async function hmacKey(secret) {
    // Guard against PORTAL_SESSION_SECRET being unset: TextEncoder.encode(undefined) silently
    // encodes "" rather than throwing, which would sign every token with a known, empty key —
    // fail closed instead (the fetch() handler's catch-all turns this into a generic 500).
    if (!secret)
        throw new Error("portal session secret is not configured");
    return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
    ]);
}
async function signToken(payload, secret) {
    const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const key = await hmacKey(secret);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
    return `${payloadB64}.${toBase64Url(new Uint8Array(sig))}`;
}
/** Returns the payload if the signature is valid, unexpired, and matches the expected purpose — null otherwise. */
async function verifyToken(token, secret, expectedPurpose) {
    const parts = token.split(".");
    if (parts.length !== 2)
        return null;
    const [payloadB64, sigB64] = parts;
    const sigBytes = fromBase64Url(sigB64);
    const payloadBytes = fromBase64Url(payloadB64);
    if (!sigBytes || !payloadBytes)
        return null;
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payloadB64));
    if (!valid)
        return null;
    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    }
    catch {
        return null;
    }
    if (payload.purpose !== expectedPurpose)
        return null;
    if (typeof payload.cid !== "number" || typeof payload.exp !== "number")
        return null;
    if (payload.exp < Math.floor(Date.now() / 1000))
        return null;
    return payload;
}
export async function signLoginToken(clientId, secret) {
    return signToken({ cid: clientId, purpose: "login", exp: Math.floor(Date.now() / 1000) + LOGIN_TOKEN_TTL_SECONDS }, secret);
}
export async function verifyLoginToken(token, secret) {
    const payload = await verifyToken(token, secret, "login");
    return payload ? payload.cid : null;
}
async function signSessionToken(clientId, secret) {
    return signToken({ cid: clientId, purpose: "session", exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }, secret);
}
export async function verifySessionToken(token, secret) {
    const payload = await verifyToken(token, secret, "session");
    return payload ? payload.cid : null;
}
/** Set-Cookie header value for a freshly-issued session. */
export async function buildSessionCookie(clientId, secret) {
    const token = await signSessionToken(clientId, secret);
    return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=${SESSION_TTL_SECONDS}`;
}
/** Set-Cookie header value that clears the session cookie. */
export function clearSessionCookie() {
    return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=0`;
}
/** Extracts the session token from a request's Cookie header, if present. */
export function readSessionCookie(request) {
    const header = request.headers.get("Cookie") ?? "";
    const match = header.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
    return match ? match[1] : null;
}
/** Resolves the authenticated client id from a request's session cookie, or null if absent/invalid/expired. */
export async function authenticateClient(request, secret) {
    const token = readSessionCookie(request);
    if (!token)
        return null;
    return verifySessionToken(token, secret);
}
