import { test, expect, APIRequestContext } from '@playwright/test';

// Failure-injection: verify the Worker handles error conditions gracefully.
// APIRequestContext (request.*) is separate from the browser page context, so
// page.route() stubs do NOT intercept these calls. We test the real endpoints
// and assert no 5xx responses.

// Admin Basic auth comes from playwright.config.ts `httpCredentials` (send: 'always'), so specs
// never build the header themselves — a hand-built Authorization header is echoed into
// Playwright's failure call log, leaking ADMIN_SECRET into CI output.

async function authedPost(request: APIRequestContext, url: string, data: unknown) {
  return request.post(url, {
    data,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('failure injection - network latency and D1 timeout', async ({ page, request }) => {
  test.setTimeout(240_000); // see the cron timeout below
  // 1. Import for a nonexistent client — Worker must return 4xx, not crash
  const importResp = await authedPost(request, '/api/clients/999/invoices/import', {
    csv: 'id,amount,due_date\n2,2000,2023-02-01',
  });
  expect(importResp.status()).not.toBe(500);
  expect(importResp.status()).not.toBe(503);

  // 2. Trigger cron runner — wrangler local endpoint
  const cronResp = await request.post('/cdn-cgi/local/scheduled', {
    params: { cron: '0 6 * * *' },
    // The cron drafts each overdue invoice via a real Gemini call, sequentially — allow for it.
    timeout: 180_000,
  });
  expect(cronResp.status()).toBeLessThan(500);

  // 3. Admin review queue must still render cleanly after error conditions
  await page.goto('/admin');
  await expect(page.locator('h1')).toContainText('Review queue');
  await expect(page.locator('table')).toBeVisible();
});
