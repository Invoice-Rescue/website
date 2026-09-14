import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCsv } from "../backend/src/lib/csv";

/**
 * Seeds local Cloudflare D1 database (invoice-rescue-db) with realistic
 * test clients, overdue invoices, and a draft chase message for local development.
 */
function main() {
  console.log("=== Seeding Local D1 Database (invoice-rescue-db) ===");

  const sqlStatements: string[] = [];

  // Clean up any previous test seed data first
  sqlStatements.push(`
DELETE FROM chase_log WHERE invoice_id IN (
  SELECT id FROM invoices WHERE invoice_number IN ('INV-2026-001', 'INV-2026-002', 'INV-2026-003', 'INV-2026-004')
);
DELETE FROM invoices WHERE invoice_number IN ('INV-2026-001', 'INV-2026-002', 'INV-2026-003', 'INV-2026-004');
DELETE FROM clients WHERE contact_email = 'jane@acmedigital.test';
  `.trim());

  // 1. Seed sample client
  sqlStatements.push(`
INSERT INTO clients (company_name, contact_name, contact_email, plan, accounting_source, voice_notes, status, stripe_customer_id, created_at)
VALUES ('Acme Digital Ltd', 'Jane Smith', 'jane@acmedigital.test', 'engine', 'csv', 'Professional and cordial, firm on 14+ days', 'active', 'cus_test_acme123', datetime('now'));
  `.trim());

  // 2. Read invoice fixture
  const fixturePath = join(__dirname, "../tests/fixtures/invoices.csv");
  const csvContent = readFileSync(fixturePath, "utf-8");
  const rows = parseCsv(csvContent);

  console.log(`Parsed ${rows.length} invoices from fixtures.`);

  for (const row of rows) {
    const amountPence = Math.round(Number(row.amount) * 100);
    sqlStatements.push(`
INSERT INTO invoices (client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, issued_date, due_date, status, created_at, last_synced_at)
SELECT id, '${row.debtor_name.replace(/'/g, "''")}', '${row.debtor_email}', '${row.invoice_number}', ${amountPence}, '${row.currency}', '${row.issued_date}', '${row.due_date}', 'overdue', datetime('now'), datetime('now')
FROM clients WHERE contact_email = 'jane@acmedigital.test';
    `.trim());
  }

  // 3. Seed sample draft in chase_log for /admin queue testing
  sqlStatements.push(`
INSERT INTO chase_log (invoice_id, step, channel, subject, outcome, status, body)
SELECT id, 1, 'email', 'Reminder: Invoice INV-2026-001 is overdue', NULL, 'draft', 'Hi Accounts,

Just a quick note that invoice INV-2026-001 for GBP 1450.00 was due on 2026-08-01. Could you please confirm payment status?

Best regards,
Jane Smith'
FROM invoices WHERE invoice_number = 'INV-2026-001'
LIMIT 1;
  `.trim());

  const tempSqlFile = join(tmpdir(), `invoice-rescue-seed-${Date.now()}.sql`);
  writeFileSync(tempSqlFile, sqlStatements.join("\n\n") + "\n", "utf-8");

  try {
    console.log(`Applying SQL seed script via wrangler d1 execute --file...`);
    const cmd = `npx wrangler d1 execute invoice-rescue-db --local --file "${tempSqlFile}"`;
    execSync(cmd, { stdio: "inherit" });
    console.log("\n✅ Local D1 database seeded successfully!");
    console.log("You can now test:");
    console.log("1. /admin review queue: curl -u admin:<ADMIN_SECRET> http://127.0.0.1:8787/admin");
    console.log("2. /portal magic link login with: jane@acmedigital.test");
    console.log("3. Overdue cron detection: curl http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+6+*+*+*");
  } finally {
    try {
      unlinkSync(tempSqlFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

main();
