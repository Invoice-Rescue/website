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
      <td>${escapeHtml(d.company_name)}</td>
      <td>${escapeHtml(d.debtor_name)} (${escapeHtml(d.debtor_email ?? "no email on file")})</td>
      <td>${escapeHtml(d.invoice_number)}</td>
      <td>Step ${d.step}</td>
      <td>
        <form method="post" action="/api/chase/${d.id}/approve">
          <textarea name="body" rows="6" cols="60">${escapeHtml(d.body ?? "")}</textarea><br>
          <button type="submit">Approve &amp; send</button>
        </form>
      </td>
      <td><form method="post" action="/api/chase/${d.id}/skip"><button type="submit">Skip</button></form></td>
    </tr>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice Rescue — Review queue</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.5rem;vertical-align:top;text-align:left}</style>
</head><body>
<h1>Review queue</h1>
<p><strong>Not access-gated.</strong> Put Cloudflare Access in front of <code>/admin</code> (and <code>/api/chase/*</code>) before relying on this with real client data — see docs/credit-control-system-design.md §4.4.</p>
<table>
<thead><tr><th>Client</th><th>Debtor</th><th>Invoice</th><th>Step</th><th>Message</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No drafts awaiting review.</td></tr>'}</tbody>
</table>
</body></html>`;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}
