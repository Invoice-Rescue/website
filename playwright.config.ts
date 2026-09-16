import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Playwright E2E configuration for Invoice Rescue.
 *
 * Authentication: /admin uses HTTP Basic Auth (WWW-Authenticate: Basic).
 * Playwright's `httpCredentials` makes Chromium auto-respond to the 401
 * challenge.  The password is read from .dev.vars at config-load time so it
 * matches exactly what wrangler injects into the Worker — no hardcoding needed.
 *
 * Note: .dev.vars is gitignored; CI must set ADMIN_SECRET in the environment.
 */

function readDevVars(): Record<string, string> {
  const devVarsPath = join(__dirname, '.dev.vars');
  if (!existsSync(devVarsPath)) return {};
  const lines = readFileSync(devVarsPath, 'utf-8').split('\n');
  const vars: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) vars[key] = value;
  }
  return vars;
}

// Merge .dev.vars into process.env so everything downstream can use it
const devVars = readDevVars();
for (const [k, v] of Object.entries(devVars)) {
  if (!(k in process.env)) process.env[k] = v;
}

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';

if (!ADMIN_SECRET) {
  throw new Error(
    'ADMIN_SECRET is not set. Add it to .dev.vars or set it as an environment variable before running E2E tests.',
  );
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,   // wrangler dev is single-process
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'playwright-results.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Makes Chromium auto-respond to WWW-Authenticate: Basic challenges
    httpCredentials: {
      username: 'admin',
      password: ADMIN_SECRET,
      // 'always' sends preemptively without waiting for the 401 challenge
      send: 'always',
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
