# End-to-end test suite

Playwright E2E tests for Invoice Rescue. They boot `wrangler dev` against a local D1 database and drive `/admin` through HTTP Basic Auth.

Local run (needs `ADMIN_SECRET` in `.dev.vars` and local migrations applied):

```bash
npx wrangler d1 migrations apply invoice-rescue-db --local
npm run e2e
```

Covered: the happy-path credit-control flow, failure injection, and split-trust email routing. CI builds its own throwaway `.dev.vars` and migrated local D1 before running this suite (see `.github/workflows/ci.yml`).
