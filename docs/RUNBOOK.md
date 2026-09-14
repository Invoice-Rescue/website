# Operational Runbook

This runbook outlines standard operating procedures, deployment workflows, monitoring routines, incident remediation steps, and disaster recovery processes for Invoice Rescue.

---

## 1. System Overview & Architecture

Invoice Rescue is deployed as a unified Cloudflare Worker with static asset serving and a serverless SQLite database (Cloudflare D1):

- **Domain**: `invoicerescue.co.uk`
- **Platform**: Cloudflare Workers + D1 (`WEUR` region) + Cloudflare Email Routing
- **Worker Script**: `backend/src/index.ts`
- **Static Assets**: `frontend/` (served directly at edge via `assets` binding)
- **Database**: `invoice-rescue-db` (`b9e84ca4-bcd2-44e7-b4f2-d2dc61e1a29f`)

---

## 2. Deployment Procedures

### 2.1 Standard Release Workflow

Deployments should always be executed from a clean working tree on the `main` branch.

1. **Run Quality Verification Gate**:

   ```bash
   npm run verify
   ```

   Ensures markdown docs lint cleanly, TypeScript types pass with zero errors, unit tests pass, and Wrangler dry-run bundle build succeeds.

2. **Apply Pending D1 Database Migrations (Remote)**:
   If your release includes changes to `backend/db/migrations/*.sql`:

   ```bash
   npx wrangler d1 migrations apply invoice-rescue-db --remote
   ```

   > [!IMPORTANT]
   > Always test migrations locally first with `npx wrangler d1 migrations apply invoice-rescue-db --local` before applying remotely.

3. **Deploy Worker and Static Assets**:

   ```bash
   npx wrangler deploy
   ```

4. **Verify Live Health**:

   ```bash
   curl -s -i https://invoicerescue.co.uk/api/health
   ```

   Expected response: HTTP 200 with `{"ok":true,"service":"invoice-rescue"}`.

### 2.2 Updating Production Secrets

If updating or rotating API keys or passwords:

```bash
# Requires interactive browser authentication:
npx wrangler secret put <SECRET_NAME>
```

> [!NOTE]
> Static API tokens (`CLOUDFLARE_API_TOKEN`) cannot execute secret updates due to Cloudflare API authentication restrictions. Secrets must be deployed via `npx wrangler login`.

---

## 3. Health Checks & Monitoring

### 3.1 Health Endpoint

- **URL**: `https://invoicerescue.co.uk/api/health`
- **Checks**: Verifies Worker execution and active D1 connectivity via `SELECT 1`.
- **Healthy Response**:

  ```json
  { "ok": true, "service": "invoice-rescue" }
  ```

- **Unhealthy Response** (HTTP 503):

  ```json
  { "ok": false, "service": "invoice-rescue", "db": "unreachable" }
  ```

### 3.2 Real-time Log Streaming

To monitor live requests, errors, and cron trigger executions:

```bash
npx wrangler tail
```

Use filters to isolate errors:

```bash
npx wrangler tail --status error
```

---

## 4. Scheduled Jobs & Background Tasks

Cloudflare Worker Cron Triggers are defined in [`wrangler.jsonc`](file:///d:/Dev/Workspaces/Active/invoice-rescue/wrangler.jsonc):

| Schedule | Job Name | Handler Function | Action |
| :--- | :--- | :--- | :--- |
| `0 6 * * *` (06:00 UTC daily) | `detect-overdue` | `runOverdueDetection()` | Scans overdue invoices, determines escalation step, drafts chase email via Gemini, queues in `chase_log` with status `draft`, and notifies operator. |
| `0 8 * * FRI` (08:00 UTC Fri) | `friday-report` | `runFridayReport()` | Aggregates 7-day payment stats (Paid, Promised, Escalating) and emails weekly cash report to active clients. |

### 4.1 Manual Trigger Execution (Local Dev)

Simulate triggers locally against a running `npm run dev` instance:

```bash
# Overdue detection:
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+6+*+*+*"

# Friday report:
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+8+*+*+FRI"
```

---

## 5. Rollback Procedures

### 5.1 Worker & Code Rollback

If a bad deployment is detected:

1. **Option A: Wrangler Rollback**:
   Roll back to the previous deployment version:

   ```bash
   npx wrangler rollback
   ```

2. **Option B: Redeploy Prior Git Commit**:

   ```bash
   git checkout <last-known-good-commit>
   npx wrangler deploy
   ```

### 5.2 Database Recovery (Cloudflare D1 Time Travel)

Cloudflare D1 provides continuous Point-in-Time Recovery (PITR):

1. **Restore to a Specific Bookmark or Timestamp**:

   ```bash
   # Restore by bookmark:
   npx wrangler d1 time-travel restore invoice-rescue-db --bookmark=<BOOKMARK_ID>

   # Restore by ISO8601 timestamp:
   npx wrangler d1 time-travel restore invoice-rescue-db --timestamp="2026-09-14T06:00:00Z"
   ```

2. **Manual SQL Export**:
   Always export a snapshot prior to complex data migrations:

   ```bash
   npx wrangler d1 export invoice-rescue-db --remote --output=backup-$(date +%Y%m%d).sql
   ```

3. **Schema Rollback Patterns**:
   SQLite does not support `ALTER TABLE DROP CONSTRAINT`. Schema rollbacks must follow forward migrations using the copy-rename-drop pattern (see `backend/db/migrations/0003_add_check_constraints.sql`).

---

## 6. Incident Remediation Guide

### 6.1 Stripe Webhook Rejections (`400 Invalid signature`)

- **Symptoms**: `/api/billing/webhook` logs "Invalid signature". Client subscription statuses do not update.
- **Root Cause**: `STRIPE_WEBHOOK_SECRET` in Cloudflare Secrets does not match the signing secret of the configured Stripe Dashboard webhook endpoint.
- **Remediation**:
  1. Open Stripe Dashboard → Developers → Webhooks.
  2. Locate the endpoint `https://invoicerescue.co.uk/api/billing/webhook`.
  3. Reveal the Signing Secret (`whsec_...`).
  4. Run `npx wrangler secret put STRIPE_WEBHOOK_SECRET` and enter the secret.

### 6.2 Operator Admin Lockout (`401 Unauthorized`)

- **Symptoms**: Browser repeatedly prompts for Basic Auth credentials when navigating to `/admin`.
- **Root Cause**: Invalid password or unset `ADMIN_SECRET`.
- **Remediation**:
  1. Check secret documentation in password manager or secure secrets store.
  2. Re-set secret if needed: `npx wrangler secret put ADMIN_SECRET`.
  3. Note: Any username is accepted by HTTP Basic Auth; only the password is validated.

### 6.3 Gemini AI Drafting Failures

- **Symptoms**: Morning cron trigger completes but no drafts appear in `/admin`. Logs show `Gemini draft failed for invoice <id>`.
- **Root Cause**: Invalid `GEMINI_API_KEY`, API quota exhaustion, or network timeout.
- **Remediation**:
  1. Verify API key status in Google AI Studio.
  2. Invoices remain overdue; once the key is restored, the next cron execution will automatically draft the pending steps.

### 6.4 Inbound Email Routing Failure

- **Symptoms**: Emails sent to `@invoicerescue.co.uk` are not forwarded to `INBOX_FORWARD_TO`.
- **Root Cause**: Forwarding address is unverified in Cloudflare Email Routing.
- **Remediation**:
  1. Check verified destination addresses:

     ```bash
     npx wrangler email routing addresses list
     ```

  2. Ensure `INBOX_FORWARD_TO` in `wrangler.jsonc` matches an active verified destination address.

---

## 7. Escalation Contacts

- **Primary System Operator**: Tibor (`tibor@invoicerescue.co.uk`)
- **System Notifications**: `tiborcc2@gmail.com`
- **Customer Support & Public Inquiries**: `hello@invoicerescue.co.uk`
