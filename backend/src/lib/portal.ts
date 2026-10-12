import { escapeHtml } from './admin';

export interface PortalClientRow {
  id: number;
  company_name: string;
  contact_name: string | null;
  stripe_customer_id: string | null;
}

export interface PortalInvoiceRow {
  invoice_number: string;
  debtor_name: string;
  amount_pence: number;
  currency: string;
  status: string;
  due_date: string;
}

export interface PortalChaseRow {
  invoice_number: string;
  step: number;
  status: string;
  sent_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

const money = (pence: number, currency: string) =>
  `${currency === 'GBP' ? '£' : currency + ' '}${(pence / 100).toFixed(2)}`;

const shell = (
  title: string,
  body: string
) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice Rescue — ${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem auto;padding:0 1rem;max-width:840px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #ccc;padding:.5rem;vertical-align:top;text-align:left}form.inline{display:inline}input[type=email]{padding:.4rem;width:260px;max-width:100%;box-sizing:border-box}button{padding:.4rem .8rem}</style>
</head><body>${body}</body></html>`;

export function renderPortalLogin(message?: string): string {
  return shell(
    'Client login',
    `<h1>Client login</h1>
${message ? `<p>${escapeHtml(message)}</p>` : ''}
<form method="post" action="/portal/login">
  <label>Email <input type="email" name="email" required autofocus></label>
  <button type="submit">Send login link</button>
</form>`
  );
}

export function renderPortalLoginSent(): string {
  return shell(
    'Check your email',
    `<h1>Check your email</h1>
<p>If that email matches an active client account, a login link is on its way — it expires in 15 minutes.</p>`
  );
}

/** GET /portal/verify confirmation — only the POST consumes the single-use token, so link-prefetching mail scanners can't burn it. */
export function renderPortalVerifyConfirm(token: string): string {
  return shell(
    'Continue',
    `<h1>Continue to your Invoice Rescue dashboard</h1>
<form method="post" action="/portal/verify">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <button type="submit">Continue to dashboard</button>
</form>`
  );
}

// chase_log.sent_at defaults to now(), so it only means "sent" when status is 'sent'.
function chaseSentCell(c: PortalChaseRow): string {
  if (c.status === 'sent') return escapeHtml(c.sent_at);
  if (c.status === 'draft') return 'Awaiting review';
  if (c.status === 'skipped')
    return `Skipped${c.reviewed_at ? ' on ' + escapeHtml(c.reviewed_at) : ''}`;
  return '—';
}

function chaseReviewCell(c: PortalChaseRow): string {
  if (!c.reviewed_by) return '—';
  const verb =
    c.status === 'sent'
      ? 'Reviewed and approved'
      : c.status === 'skipped'
        ? 'Reviewed and skipped'
        : 'Reviewed';
  return `${verb} by ${escapeHtml(c.reviewed_by)}${c.reviewed_at ? ' on ' + escapeHtml(c.reviewed_at) : ''}`;
}

export function renderPortalDashboard(
  client: PortalClientRow,
  invoices: PortalInvoiceRow[],
  chases: PortalChaseRow[]
): string {
  const invoiceRows = invoices
    .map(
      (i) => `<tr>
  <td>${escapeHtml(i.invoice_number)}</td>
  <td>${escapeHtml(i.debtor_name)}</td>
  <td>${money(i.amount_pence, i.currency)}</td>
  <td>${escapeHtml(i.status)}</td>
  <td>${escapeHtml(i.due_date)}</td>
</tr>`
    )
    .join('');

  const chaseRows = chases
    .map(
      (c) => `<tr>
  <td>${escapeHtml(c.invoice_number)}</td>
  <td>Step ${c.step}</td>
  <td>${escapeHtml(c.status)}</td>
  <td>${chaseSentCell(c)}</td>
  <td>${chaseReviewCell(c)}</td>
</tr>`
    )
    .join('');

  return shell(
    'Dashboard',
    `<h1>${escapeHtml(client.company_name)}</h1>
<p>
  <form class="inline" method="post" action="/portal/billing"><button type="submit">Manage billing</button></form>
  <form class="inline" method="post" action="/portal/logout"><button type="submit">Log out</button></form>
</p>
<p>Every message we send in your name is reviewed by a person before it goes out — that's shown against each entry below. To change plan or cancel, see your <a href="/terms">Terms</a> or email <a href="mailto:hello@invoicerescue.co.uk">hello@invoicerescue.co.uk</a>.</p>

<h2>Invoices</h2>
<div class="scroll"><table><thead><tr><th>Invoice</th><th>Debtor</th><th>Amount</th><th>Status</th><th>Due</th></tr></thead>
<tbody>${invoiceRows || '<tr><td colspan="5">No invoices on file yet.</td></tr>'}</tbody></table></div>

<h2>Chase history</h2>
<div class="scroll"><table><thead><tr><th>Invoice</th><th>Step</th><th>Status</th><th>Sent</th><th>Review</th></tr></thead>
<tbody>${chaseRows || '<tr><td colspan="5">No chase activity yet.</td></tr>'}</tbody></table></div>`
  );
}
