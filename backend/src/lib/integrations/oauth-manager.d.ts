/**
 * OAuth 2.0 Manager for Xero and QuickBooks
 * Zero-external-dependency implementation using Web Crypto API and native fetch.
 */
export interface OAuthStatePayload {
    cid: number;
    p: 'xero' | 'quickbooks';
    nonce: string;
    exp: number;
    ret: string;
}
export interface TokenExchangeResult {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tenantId: string;
}
export declare const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
export declare const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export declare const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
export declare const XERO_REVOKE_URL = "https://identity.xero.com/connect/revocation";
export declare const XERO_SCOPES = "offline_access accounting.transactions accounting.contacts.read accounting.settings.read openid profile email";
export declare const QB_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
export declare const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export declare const QB_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export declare const QB_SCOPES = "com.intuit.quickbooks.accounting openid email";
/** Utility: Base64URL encoding/decoding */
export declare function toBase64Url(bytes: Uint8Array): string;
export declare function fromBase64Url(s: string): Uint8Array | null;
/**
 * Encrypts a token using AES-GCM (256-bit) with a random 12-byte IV.
 */
export declare function encryptToken(plaintext: string, secretKey: string): Promise<string>;
/**
 * Decrypts an AES-GCM ciphertext string with 12-byte IV prepended.
 */
export declare function decryptToken(ciphertextWithIv: string, secretKey: string): Promise<string>;
/**
 * Generates a signed, tamper-proof state token containing tenant client ID and provider.
 */
export declare function generateOAuthState(payload: Omit<OAuthStatePayload, 'exp' | 'nonce'>, secretKey: string, ttlSeconds?: number): Promise<string>;
/**
 * Verifies and parses an OAuth state token.
 */
export declare function verifyOAuthState(state: string, secretKey: string, expectedProvider?: 'xero' | 'quickbooks'): Promise<OAuthStatePayload | null>;
/**
 * Constructs the provider authorization redirect URL.
 */
export declare function buildAuthorizationUrl(provider: 'xero' | 'quickbooks', clientId: string, redirectUri: string, state: string): string;
/**
 * Exchanges authorization code for tokens and resolves tenant ID.
 */
export declare function exchangeCodeForTokens(provider: 'xero' | 'quickbooks', code: string, redirectUri: string, clientCredentials: {
    clientId: string;
    clientSecret: string;
}, realmId?: string | null): Promise<TokenExchangeResult>;
/**
 * Refreshes tokens for an accounting connection.
 */
export declare function refreshProviderTokens(provider: 'xero' | 'quickbooks', refreshToken: string, clientCredentials: {
    clientId: string;
    clientSecret: string;
}): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}>;
/**
 * Revokes a provider token (best effort).
 */
export declare function revokeProviderToken(provider: 'xero' | 'quickbooks', token: string, clientCredentials: {
    clientId: string;
    clientSecret: string;
}): Promise<void>;
