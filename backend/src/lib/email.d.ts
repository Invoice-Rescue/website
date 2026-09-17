/**
 * Invoice Rescue — Split-Trust Email Delivery Module (Milestone M4 / R4)
 *
 * Implements Interface Contract 5:
 * - sendOperatorNotification: dispatches internal alerts exclusively via env.NOTIFY to tiborcc2@gmail.com
 * - sendDebtorCommunication: dispatches authenticated debtor chases exclusively via env.SEND
 *
 * Enforces RFC deliverability headers, locked sender constraints, and resilient error boundaries.
 */
export declare const SENDER_NAME = "Invoice Rescue";
export declare const LOCKED_SENDER_EMAIL = "hello@invoicerescue.co.uk";
export declare const OPERATOR_INBOX_EMAIL = "tiborcc2@gmail.com";
/**
 * Validates basic RFC 5322 email address format.
 */
export declare function isValidEmail(email: string): boolean;
/**
 * Generates standard locked sign-off for debtor communications.
 */
export declare function formatDebtorSignoff(clientBusinessName?: string): string;
export interface DebtorCommunicationOptions {
    clientBusinessName?: string;
}
/**
 * Dispatches an internal operator alert strictly through env.NOTIFY.
 *
 * Deliverability & Security Controls:
 * - Recipient locked to operator address: tiborcc2@gmail.com
 * - Sender locked to: Invoice Rescue <hello@invoicerescue.co.uk>
 * - Headers: Auto-Submitted: auto-generated, Message-ID: <${uuid}@invoicerescue.co.uk>, Date: RFC 2822
 * - Resilient error handling: wraps env.NOTIFY.send in try/catch, logs error with console.error, returns false instead of throwing
 */
export declare function sendOperatorNotification(env: Env, subject: string, body: string): Promise<boolean>;
/**
 * Dispatches an authenticated debtor communication strictly through env.SEND.
 *
 * Deliverability & Security Controls:
 * - Recipient validated for RFC 5322 syntax
 * - Sender locked to: Invoice Rescue <hello@invoicerescue.co.uk>
 * - Sign-off by Tibor Rames on behalf of client (appended if clientBusinessName option provided and not already present)
 * - Headers: Auto-Submitted: auto-generated, Message-ID: <${uuid}@invoicerescue.co.uk>, Date: RFC 2822, Reply-To: hello@invoicerescue.co.uk
 * - Reply-To parameter set to hello@invoicerescue.co.uk
 * - Returns boolean indicating success
 */
export declare function sendDebtorCommunication(env: Env, to: string, subject: string, body: string, options?: DebtorCommunicationOptions): Promise<boolean>;
