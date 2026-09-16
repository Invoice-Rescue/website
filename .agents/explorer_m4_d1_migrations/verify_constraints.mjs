import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sqlite = new DatabaseSync(':memory:');
const pragmaBefore = sqlite.prepare('PRAGMA foreign_keys;').get();
console.log('PRAGMA foreign_keys initially:', pragmaBefore);

const migrationsDir = join(process.cwd(), 'backend', 'db', 'migrations');
const migrationFiles = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

for (const file of migrationFiles) {
  const sql = readFileSync(join(migrationsDir, file), 'utf-8');
  sqlite.exec(sql);
}

const pragmaAfter = sqlite.prepare('PRAGMA foreign_keys;').get();
console.log('PRAGMA foreign_keys after migrations:', pragmaAfter);

try {
  sqlite.exec("INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date) VALUES (9999, 'Bad Debtor', 'INV-999', 1000, '2026-09-01');");
  console.log('VIOLATION: Foreign key was NOT enforced!');
} catch (err) {
  console.log('CONFIRMED: Foreign key constraint enforced:', err.message);
}

// Check check constraints
try {
  sqlite.exec("INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date) VALUES (1, 'Bad Debtor', 'INV-998', -100, '2026-09-01');");
  console.log('VIOLATION: CHECK constraint (amount_pence > 0) NOT enforced!');
} catch (err) {
  console.log('CONFIRMED: CHECK constraint enforced:', err.message);
}

// Check UNIQUE constraint
try {
  sqlite.exec("INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Test Co', 'test@test.com');");
  sqlite.exec("INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date) VALUES (1, 'Debtor A', 'INV-001', 1000, '2026-09-01');");
  sqlite.exec("INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date) VALUES (1, 'Debtor B', 'INV-001', 2000, '2026-09-01');");
  console.log('VIOLATION: UNIQUE (client_id, invoice_number) NOT enforced!');
} catch (err) {
  console.log('CONFIRMED: UNIQUE (client_id, invoice_number) enforced:', err.message);
}
