import { test, describe } from 'node:test';
import assert from 'node:assert';
import { renderReviewQueue, type DraftRow } from '../backend/src/lib/admin';
import {
  renderPortalDashboard,
  renderPortalLogin,
  renderPortalLoginSent,
  renderPortalVerifyConfirm,
  type PortalChaseRow,
  type PortalClientRow,
} from '../backend/src/lib/portal';

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const XSS = `<script>alert("x")</script>`;

const client: PortalClientRow = {
  id: 1,
  company_name: 'Acme & Co',
  contact_name: null,
  stripe_customer_id: null,
};

function chase(overrides: Partial<PortalChaseRow>): PortalChaseRow {
  return {
    invoice_number: 'INV-1',
    step: 1,
    status: 'sent',
    sent_at: '2026-10-01 09:00:00',
    reviewed_at: '2026-10-01 08:55:00',
    reviewed_by: 'operator',
    ...overrides,
  };
}

const draft: DraftRow = {
  id: 7,
  step: 2,
  body: 'Please pay',
  subject: 'Overdue',
  invoice_number: 'INV-7',
  debtor_name: 'Debtor Ltd',
  debtor_email: 'ap@debtor.example',
  company_name: 'Acme',
};

// Every Worker-rendered page is served under a CSP with no script-src, so none may contain a script.
const renderedPages: Record<string, string> = {
  login: renderPortalLogin('That link is invalid or has expired.'),
  loginSent: renderPortalLoginSent(),
  verifyConfirm: renderPortalVerifyConfirm('tok'),
  dashboard: renderPortalDashboard(client, [], [chase({})]),
  adminQueue: renderReviewQueue([draft]),
  adminQueueEmpty: renderReviewQueue([]),
};

describe('rendered HTML documents', () => {
  for (const [name, html] of Object.entries(renderedPages)) {
    test(`${name} has the mobile viewport meta and no script or inline handlers`, () => {
      assert.ok(html.includes(VIEWPORT), `${name} missing viewport meta`);
      assert.doesNotMatch(html, /<script/i);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    });
  }

  test('admin queue stacks rows on narrow screens with labelled cells', () => {
    const html = renderedPages.adminQueue;
    assert.match(html, /@media \(max-width:700px\)/);
    assert.ok(html.includes('data-label="Client"'));
  });
});

describe('portal chase history', () => {
  test('shows the sent timestamp only for sent rows', () => {
    const html = renderPortalDashboard(
      client,
      [],
      [chase({ status: 'sent', sent_at: '2026-10-01 09:00:00' })]
    );
    assert.ok(html.includes('<td>2026-10-01 09:00:00</td>'));
  });

  test("draft shows 'Awaiting review', not the DB-default sent_at", () => {
    const html = renderPortalDashboard(
      client,
      [],
      [
        chase({
          status: 'draft',
          sent_at: '2026-10-02 06:00:00',
          reviewed_at: null,
          reviewed_by: null,
        }),
      ]
    );
    assert.ok(html.includes('Awaiting review'));
    assert.ok(!html.includes('2026-10-02 06:00:00'));
  });

  test("skipped shows 'Skipped' with the review time, not sent_at", () => {
    const html = renderPortalDashboard(
      client,
      [],
      [
        chase({
          status: 'skipped',
          sent_at: '2026-10-02 06:00:00',
          reviewed_at: '2026-10-03 10:00:00',
          reviewed_by: 'operator',
        }),
      ]
    );
    assert.ok(html.includes('Skipped on 2026-10-03 10:00:00'));
    assert.ok(!html.includes('2026-10-02 06:00:00'));
    assert.ok(html.includes('Reviewed and skipped by operator'));
    assert.ok(!html.includes('approved by operator'));
  });

  test('client reviewer label reads naturally in the audit trail', () => {
    const html = renderPortalDashboard(client, [], [chase({ reviewed_by: 'Jane Smith (client)' })]);
    assert.ok(html.includes('Reviewed and approved by Jane Smith (client) on 2026-10-01 08:55:00'));
  });

  test('operator reviewer label reads naturally in the audit trail', () => {
    const html = renderPortalDashboard(client, [], [chase({ reviewed_by: 'operator' })]);
    assert.ok(html.includes('Reviewed and approved by operator on 2026-10-01 08:55:00'));
  });
});

describe('escaping invariant', () => {
  test('portal dashboard escapes client, invoice and chase values', () => {
    const html = renderPortalDashboard(
      { ...client, company_name: XSS },
      [
        {
          invoice_number: XSS,
          debtor_name: XSS,
          amount_pence: 100,
          currency: 'GBP',
          status: XSS,
          due_date: XSS,
        },
      ],
      [
        chase({
          invoice_number: XSS,
          status: 'sent',
          sent_at: XSS,
          reviewed_by: XSS,
          reviewed_at: XSS,
        }),
      ]
    );
    assert.doesNotMatch(html, /<script/i);
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  });

  test('ampersand in company name is escaped', () => {
    assert.ok(renderPortalDashboard(client, [], []).includes('<h1>Acme &amp; Co</h1>'));
  });

  test('admin queue escapes draft fields', () => {
    const html = renderReviewQueue([
      {
        ...draft,
        company_name: XSS,
        debtor_name: XSS,
        debtor_email: XSS,
        invoice_number: XSS,
        body: `</textarea>${XSS}`,
      },
    ]);
    assert.doesNotMatch(html, /<script/i);
    assert.ok(html.includes('&lt;/textarea&gt;'));
  });
});

describe('renderPortalVerifyConfirm', () => {
  test('renders a POST form carrying the token, without consuming it on GET', () => {
    const html = renderPortalVerifyConfirm('abc.def');
    assert.ok(html.includes('Continue to your Invoice Rescue dashboard'));
    assert.ok(html.includes('<form method="post" action="/portal/verify">'));
    assert.ok(html.includes('<input type="hidden" name="token" value="abc.def">'));
    assert.match(html, /<button type="submit">Continue to dashboard<\/button>/);
  });

  test('escapes an attribute-breaking token', () => {
    const html = renderPortalVerifyConfirm(`"><script>alert(1)</script>`);
    assert.doesNotMatch(html, /<script/i);
    assert.ok(html.includes('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'));
  });
});
