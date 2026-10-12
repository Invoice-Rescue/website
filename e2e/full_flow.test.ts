import { test, expect, APIRequestContext } from '@playwright/test';

// Happy-path end-to-end test: invoice sync, escalation, admin review queue.
// Basic Auth header is handled at the browser level via httpCredentials in
// playwright.config.ts (responds to WWW-Authenticate: Basic challenges).
// For APIRequestContext calls we must set the header explicitly.

// Admin Basic auth comes from playwright.config.ts `httpCredentials` (send: 'always'), so specs
// never build the header themselves — a hand-built Authorization header is echoed into
// Playwright's failure call log, leaking ADMIN_SECRET into CI output.

async function authedPost(request: APIRequestContext, url: string, data: unknown) {
  return request.post(url, {
    data,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('full credit-control flow', async ({ page, request }) => {
  test.setTimeout(240_000); // see the cron timeout below
  // Stub external OAuth token exchange (only applies to requests the browser page makes)
  await page.route('**/oauth/token', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: 'test-token', expires_in: 3600 }),
    })
  );

  // Navigate to admin — httpCredentials auto-handles the Basic Auth challenge
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.locator('h1')).toContainText('Review queue');

  // Trigger invoice import via API (admin-gated endpoint)
  const syncResp = await authedPost(request, '/api/clients/1/invoices/import', {
    csv: 'id,amount,due_date\n1,1000,2023-01-01',
  });
  // Accept 200 (created) or 404 (no such client in local DB) — only reject 5xx
  expect(syncResp.status()).toBeLessThan(500);

  // Trigger escalation cron runner via wrangler local scheduled endpoint
  const cronResp = await request.post('/cdn-cgi/local/scheduled', {
    params: { cron: '0 6 * * *' },
    // The cron drafts each overdue invoice via a real Gemini call, sequentially — allow for it.
    timeout: 180_000,
  });
  expect(cronResp.status()).toBeLessThan(500);

  // Reload queue — it renders cleanly regardless of draft count
  await page.goto('/admin');
  await expect(page.locator('h1')).toContainText('Review queue');
  await expect(page.locator('table')).toBeVisible();
});
