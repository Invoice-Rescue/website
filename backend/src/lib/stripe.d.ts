/**
 * Minimal Stripe REST client — plain fetch() calls, no stripe-node dependency.
 * Covers exactly what the client portal needs: create a customer at
 * onboarding, mint a billing-portal session, and verify webhook signatures.
 */
/** Best-effort: returns the new customer id, or null if Stripe rejects/errors (caller must not block on this). */
export declare function createCustomer(secretKey: string, input: {
    name: string;
    email: string;
}): Promise<string | null>;
/** Returns the hosted billing-portal URL to redirect the client to, or null on failure. */
export declare function createBillingPortalSession(secretKey: string, customerId: string, returnUrl: string): Promise<string | null>;
/** Verifies a Stripe webhook per https://docs.stripe.com/webhooks#verify-manually — checks the
 * HMAC-SHA256 signature AND rejects timestamps older than 5 minutes (replay protection). */
export declare function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, webhookSecret: string): Promise<boolean>;
export interface StripeSubscriptionEvent {
    type: string;
    data: {
        object: {
            customer: string;
            status?: string;
        };
    };
}
