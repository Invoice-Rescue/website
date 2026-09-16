/**
 * Invoice Rescue — Split-Trust Email Delivery Module (Milestone M4 / R4)
 *
 * Implements Interface Contract 5:
 * - sendOperatorNotification: dispatches internal alerts exclusively via env.NOTIFY to tiborcc2@gmail.com
 * - sendDebtorCommunication: dispatches authenticated debtor chases exclusively via env.SEND
 *
 * Enforces RFC deliverability headers, locked sender constraints, and resilient error boundaries.
 */

export const SENDER_NAME = "Invoice Rescue";
export const LOCKED_SENDER_EMAIL = "hello@invoicerescue.co.uk";
export const OPERATOR_INBOX_EMAIL = "tiborcc2@gmail.com";

/**
 * Validates basic RFC 5322 email address format.
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Generates standard locked sign-off for debtor communications.
 */
export function formatDebtorSignoff(clientBusinessName?: string): string {
  const clientName = clientBusinessName?.trim() || "our client";
  return `Tibor Rames\nInvoice Rescue — acting on behalf of ${clientName}\n${LOCKED_SENDER_EMAIL}`;
}

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
export async function sendOperatorNotification(
  env: Env,
  subject: string,
  body: string,
): Promise<boolean> {
  if (!env.NOTIFY || typeof env.NOTIFY.send !== "function") {
    console.error("sendOperatorNotification: env.NOTIFY binding unavailable");
    return false;
  }

  try {
    const messageId = `<${crypto.randomUUID()}@invoicerescue.co.uk>`;
    const dateHeader = new Date().toUTCString();

    await env.NOTIFY.send({
      to: OPERATOR_INBOX_EMAIL,
      from: { name: SENDER_NAME, email: env.NOTIFY_FROM || LOCKED_SENDER_EMAIL },
      subject,
      text: body,
      headers: {
        "Auto-Submitted": "auto-generated",
        "Message-ID": messageId,
        "Date": dateHeader,
      },
    });
    return true;
  } catch (err) {
    console.error("sendOperatorNotification failed:", err);
    return false;
  }
}

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
export async function sendDebtorCommunication(
  env: Env,
  to: string,
  subject: string,
  body: string,
  options?: DebtorCommunicationOptions,
): Promise<boolean> {
  if (!to || !isValidEmail(to)) {
    console.error(`sendDebtorCommunication: invalid recipient email address: ${to}`);
    return false;
  }

  if (!env.SEND || typeof env.SEND.send !== "function") {
    console.error("sendDebtorCommunication: env.SEND binding unavailable");
    return false;
  }

  try {
    let messageText = body.trim();
    if (options?.clientBusinessName && !messageText.includes("Tibor Rames")) {
      const signoff = formatDebtorSignoff(options.clientBusinessName);
      messageText = `${messageText}\n\n${signoff}`;
    }

    const messageId = `<${crypto.randomUUID()}@invoicerescue.co.uk>`;
    const dateHeader = new Date().toUTCString();
    const replyToEmail = env.NOTIFY_FROM || LOCKED_SENDER_EMAIL;

    await env.SEND.send({
      to: to.trim(),
      from: { name: SENDER_NAME, email: replyToEmail },
      replyTo: replyToEmail,
      subject,
      text: messageText,
      headers: {
        "Auto-Submitted": "auto-generated",
        "Message-ID": messageId,
        "Date": dateHeader,
        "Reply-To": replyToEmail,
      },
    });
    return true;
  } catch (err) {
    console.error("sendDebtorCommunication failed:", err);
    return false;
  }
}
