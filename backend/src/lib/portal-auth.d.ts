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
    cid: number;
    purpose: "login" | "session";
    exp: number;
}
export declare function signLoginToken(clientId: number, secret: string): Promise<string>;
export declare function verifyLoginToken(token: string, secret: string): Promise<number | null>;
export declare function verifySessionToken(token: string, secret: string): Promise<number | null>;
/** Set-Cookie header value for a freshly-issued session. */
export declare function buildSessionCookie(clientId: number, secret: string): Promise<string>;
/** Set-Cookie header value that clears the session cookie. */
export declare function clearSessionCookie(): string;
/** Extracts the session token from a request's Cookie header, if present. */
export declare function readSessionCookie(request: Request): string | null;
/** Resolves the authenticated client id from a request's session cookie, or null if absent/invalid/expired. */
export declare function authenticateClient(request: Request, secret: string): Promise<number | null>;
