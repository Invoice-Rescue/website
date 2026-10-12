export interface DraftRow {
  id: number;
  step: number;
  body: string | null;
  subject: string | null;
  invoice_number: string;
  debtor_name: string;
  debtor_email: string | null;
  company_name: string;
}

/** Server-rendered review queue — no build step, consistent with the rest of this repo. */
export function renderReviewQueue(drafts: DraftRow[]): string {
  const rows = drafts
    .map(
      (d) => `
    <tr>
      <td data-label="Client">${escapeHtml(d.company_name)}</td>
      <td data-label="Debtor">${escapeHtml(d.debtor_name)} (${escapeHtml(d.debtor_email ?? 'no email on file')})</td>
      <td data-label="Invoice">${escapeHtml(d.invoice_number)}</td>
      <td data-label="Step">Step ${d.step}</td>
      <td data-label="Message">
        <form method="post" action="/api/chase/${d.id}/approve">
          <textarea name="body" rows="6" cols="60">${escapeHtml(d.body ?? '')}</textarea><br>
          <button type="submit">Approve &amp; send</button>
        </form>
      </td>
      <td><form method="post" action="/api/chase/${d.id}/skip"><button type="submit">Skip</button></form></td>
    </tr>`
    )
    .join('');

  // Below 700px rows stack into cards so the Approve/Skip controls stay on-screen at 375px.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice Rescue — Review queue</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.5rem;vertical-align:top;text-align:left}textarea{width:100%;min-width:20rem;box-sizing:border-box} /* overrides cols=60 so the textarea never forces horizontal scroll */
@media (max-width:700px){body{margin:1rem}thead{display:none}table,tbody,tr,td{display:block;width:100%;box-sizing:border-box}tr{border:1px solid #ccc;margin-bottom:1rem}td{border:0;border-top:1px solid #eee}td:first-child{border-top:0}td[data-label]::before{content:attr(data-label) ": ";font-weight:600}textarea{min-width:0}}</style>
</head><body>
<h1>Review queue</h1>
<p><strong>Gated by a single shared secret (Basic Auth), not real auth.</strong> Put Cloudflare Access in front of <code>/admin</code> (and <code>/api/chase/*</code>) before relying on this past 1-2 clients — see docs/credit-control-system-design.md §4.4.</p>
<table>
<thead><tr><th>Client</th><th>Debtor</th><th>Invoice</th><th>Step</th><th>Message</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No drafts awaiting review.</td></tr>'}</tbody>
</table>
</body></html>`;
}

export function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}
