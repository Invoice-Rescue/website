#!/usr/bin/env bash
# Invoice Rescue — REST API smoke test.
# Exercises every route against a running `wrangler dev` (or deployed) instance.
# Usage: BASE_URL=http://127.0.0.1:8787 backend/test/rest-api.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_SECRET:?Set ADMIN_SECRET to the value in your .dev.vars before running this script}"
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:?Set STRIPE_WEBHOOK_SECRET to the value in your .dev.vars before running this script}"
pass=0
fail=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "PASS: $desc"
    pass=$((pass + 1))
  else
    echo "FAIL: $desc — expected to contain '$expected', got: $actual"
    fail=$((fail + 1))
  fi
}

echo "== /api/health =="
res=$(curl -s "$BASE_URL/api/health")
check "health check ok" '"ok":true' "$res"

echo "== /api/lead =="
res=$(curl -s -X POST "$BASE_URL/api/lead" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"name":"Test Person","email":"test@example.com","company":"Test Ltd","overdue_band":"5k_25k","message":"hello","website":""}')
check "lead accepted" '"ok":true' "$res"

echo "== /api/lead validation =="
res=$(curl -s -X POST "$BASE_URL/api/lead" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"name":"","email":"not-an-email","overdue_band":"bogus","website":""}')
check "lead rejects bad input" '"ok":false' "$res"

echo "== /api/lead honeypot =="
res=$(curl -s -X POST "$BASE_URL/api/lead" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"name":"Bot","email":"bot@example.com","overdue_band":"not_sure","website":"http://spam.example"}')
check "honeypot pretends success" '"ok":true' "$res"

echo "== /api/clients (no auth) =="
res=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/clients" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"company_name":"Acme Ltd","contact_email":"jane@acme.test","plan":"engine","accounting_source":"csv"}')
check "client rejects missing auth" "401" "$res"

echo "== /api/clients =="
res=$(curl -s -u "admin:$ADMIN_SECRET" -X POST "$BASE_URL/api/clients" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"company_name":"Acme Ltd","contact_email":"jane@acme.test","plan":"engine","accounting_source":"csv"}')
check "client created" '"ok":true' "$res"

echo "== /api/clients validation =="
res=$(curl -s -u "admin:$ADMIN_SECRET" -X POST "$BASE_URL/api/clients" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"company_name":"","contact_email":"not-an-email"}')
check "client rejects bad input" '"ok":false' "$res"

echo "== /portal (client portal) =="
res=$(curl -s "$BASE_URL/portal")
check "login form renders" "Client login" "$res"

res=$(curl -s -X POST "$BASE_URL/portal/login" -H "Content-Type: application/x-www-form-urlencoded" \
  --data "email=nobody-$$@example.com")
check "login request never leaks whether the email matched" "Check your email" "$res"

res=$(curl -s "$BASE_URL/portal/verify?token=not-a-real-token")
check "garbage verify token rejected" "invalid or has expired" "$res"

res=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/portal/dashboard")
check "dashboard without session redirects to login" "303" "$res"

res=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/portal/billing")
check "billing without session redirects to login" "303" "$res"

echo "== /api/billing/webhook (Stripe signature verification) =="
payload='{"id":"evt_test","type":"invoice.payment_failed","data":{"object":{"customer":"cus_test123"}}}'
timestamp=$(date +%s)
sig=$(printf '%s' "${timestamp}.${payload}" | openssl dgst -sha256 -hmac "$STRIPE_WEBHOOK_SECRET" | sed 's/^.* //')

res=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/billing/webhook" -H "Content-Type: application/json" -d "$payload")
check "webhook rejects missing signature" "400" "$res"

res=$(curl -s -X POST "$BASE_URL/api/billing/webhook" -H "Content-Type: application/json" \
  -H "Stripe-Signature: t=${timestamp},v1=0000000000000000000000000000000000000000000000000000000000000000" \
  -d "$payload")
check "webhook rejects wrong signature" '"ok":false' "$res"

res=$(curl -s -X POST "$BASE_URL/api/billing/webhook" -H "Content-Type: application/json" \
  -H "Stripe-Signature: t=${timestamp},v1=${sig}" -d "$payload")
check "webhook accepts correctly-signed event" '"ok":true' "$res"

echo
echo "NOTE: /api/clients/:id/invoices/import, /admin, /api/chase/:id/approve|skip,"
echo "and the two cron handlers need invoices seeded on top of the client created above — see"
echo "docs/credit-control-system-design.md and the manual walkthrough below. Admin routes need"
echo "-u admin:\$ADMIN_SECRET (any username works, only the password is checked)."
echo
echo "  curl -u admin:\$ADMIN_SECRET -X POST $BASE_URL/api/clients/1/invoices/import --data-binary @invoices.csv"
echo "  curl \"$BASE_URL/cdn-cgi/handler/scheduled?cron=0+6+*+*+*\"   # detect-overdue"
echo "  curl -u admin:\$ADMIN_SECRET $BASE_URL/admin"
echo "  curl -u admin:\$ADMIN_SECRET -X POST $BASE_URL/api/chase/1/approve -H 'Accept: application/json'"
echo "  curl \"$BASE_URL/cdn-cgi/handler/scheduled?cron=0+8+*+*+FRI\" # friday-report"
echo
echo "The magic-link login itself (POST /portal/login → email → GET /portal/verify?token=...) can't"
echo "be scripted here since it requires reading the emailed link; walk through it by hand in a browser"
echo "against a seeded client, then confirm /portal/dashboard shows its invoices and /portal/billing"
echo "redirects to Stripe (needs clients.stripe_customer_id set, which POST /api/clients now does"
echo "best-effort at onboarding)."

echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
