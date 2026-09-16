import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("Milestone M4 Stress Suite — Challenger 2 (D1 Query Indexing, Migrations & Constraint Stress)", () => {
  const migrationsDir = join(process.cwd(), "backend", "db", "migrations");
  const localD1DbPath = join(
    process.cwd(),
    ".wrangler",
    "state",
    "v3",
    "d1",
    "miniflare-D1DatabaseObject",
    "e1679c68e96d0066649d19cf7dd33a43377fa6243b5ffe851c9d9a9490120e0f.sqlite",
  );

  function createFreshMigratedDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    const migrationFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      db.exec(sql);
    }
    return db;
  }

  // =========================================================================
  // SUITE 1: Migration 0007 Integrity & Idempotency
  // =========================================================================
  describe("1. Migration 0007 Integrity & Idempotency", () => {
    test("1.1 Migration file 0007_query_indices.sql exists and defines all 4 required performance indexes", () => {
      const migrationPath = join(migrationsDir, "0007_query_indices.sql");
      assert.ok(existsSync(migrationPath), "0007_query_indices.sql must exist");

      const sql = readFileSync(migrationPath, "utf-8");
      assert.match(sql, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_chase_log_status\s+ON\s+chase_log\s*\(\s*status\s*\)/i);
      assert.match(sql, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_accounting_connections_lookup\s+ON\s+accounting_connections\s*\(\s*provider\s*,\s*tenant_id\s*\)/i);
      assert.match(sql, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_clients_status\s+ON\s+clients\s*\(\s*status\s*\)/i);
      assert.match(sql, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_invoices_client_due\s+ON\s+invoices\s*\(\s*client_id\s*,\s*due_date\s+DESC\s*\)/i);
    });

    test("1.2 Applying migrations 0001 through 0007 sequentially builds a valid schema with all 4 indexes", () => {
      const db = createFreshMigratedDb();

      const indexes = db
        .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string; tbl_name: string; sql: string }>;

      const indexMap = new Map(indexes.map((idx) => [idx.name, idx]));

      assert.ok(indexMap.has("idx_chase_log_status"), "idx_chase_log_status must exist");
      assert.strictEqual(indexMap.get("idx_chase_log_status")!.tbl_name, "chase_log");

      assert.ok(indexMap.has("idx_accounting_connections_lookup"), "idx_accounting_connections_lookup must exist");
      assert.strictEqual(indexMap.get("idx_accounting_connections_lookup")!.tbl_name, "accounting_connections");

      assert.ok(indexMap.has("idx_clients_status"), "idx_clients_status must exist");
      assert.strictEqual(indexMap.get("idx_clients_status")!.tbl_name, "clients");

      assert.ok(indexMap.has("idx_invoices_client_due"), "idx_invoices_client_due must exist");
      assert.strictEqual(indexMap.get("idx_invoices_client_due")!.tbl_name, "invoices");
    });

    test("1.3 Migration 0007 execution is completely idempotent (multiple executions produce zero errors)", () => {
      const db = createFreshMigratedDb();
      const sql0007 = readFileSync(join(migrationsDir, "0007_query_indices.sql"), "utf-8");

      // Execute repeatedly 5 times
      for (let i = 0; i < 5; i++) {
        assert.doesNotThrow(() => {
          db.exec(sql0007);
        }, `Re-execution ${i + 1} of 0007_query_indices.sql must not throw`);
      }

      // Check count of indexes has not duplicated
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_chase_log_status', 'idx_accounting_connections_lookup', 'idx_clients_status', 'idx_invoices_client_due')")
        .all() as Array<{ name: string }>;

      assert.strictEqual(indexes.length, 4, "Must have exactly 4 indexes, no duplicates created");
    });

    test("1.4 Local Wrangler D1 SQLite database file contains all 4 indexes and passes PRAGMA integrity_check", () => {
      assert.ok(existsSync(localD1DbPath), `Local D1 SQLite database must exist at ${localD1DbPath}`);
      const db = new DatabaseSync(localD1DbPath);

      // Verify integrity
      const integrity = db.prepare("PRAGMA integrity_check;").all() as Array<{ integrity_check: string }>;
      assert.strictEqual(integrity.length, 1);
      assert.strictEqual(integrity[0].integrity_check, "ok");

      // Verify indexes in local D1
      const indexes = db
        .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string; tbl_name: string }>;
      const names = indexes.map((i) => i.name);

      assert.ok(names.includes("idx_chase_log_status"), "Local D1 missing idx_chase_log_status");
      assert.ok(names.includes("idx_accounting_connections_lookup"), "Local D1 missing idx_accounting_connections_lookup");
      assert.ok(names.includes("idx_clients_status"), "Local D1 missing idx_clients_status");
      assert.ok(names.includes("idx_invoices_client_due"), "Local D1 missing idx_invoices_client_due");

      // Verify migration table d1_migrations has migration 0007 recorded
      const migrations = db
        .prepare("SELECT id, name, applied_at FROM d1_migrations ORDER BY id ASC")
        .all() as Array<{ id: number; name: string; applied_at: string }>;

      assert.strictEqual(migrations.length, 7);
      assert.strictEqual(migrations[6].name, "0007_query_indices.sql");
    });
  });

  // =========================================================================
  // SUITE 2: Query Performance Plan Verification (EXPLAIN QUERY PLAN)
  // =========================================================================
  describe("2. Query Performance Plan Verification (EXPLAIN QUERY PLAN)", () => {
    test("2.1 Query A: 'SELECT id FROM chase_log WHERE status = 'draft'' uses idx_chase_log_status instead of table scan", () => {
      const db = createFreshMigratedDb();

      // Check plan WITH index
      const planWithIndex = db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM chase_log WHERE status = 'draft'")
        .all() as Array<{ id: number; parent: number; notused: number; detail: string }>;

      const detail = planWithIndex.map((p) => p.detail).join("; ");
      assert.ok(
        detail.includes("idx_chase_log_status"),
        `Expected plan to use idx_chase_log_status, got: ${detail}`,
      );
      assert.ok(
        !detail.includes("SCAN chase_log"),
        `Plan should not perform a full table scan, got: ${detail}`,
      );

      // Contrast: Drop index and verify it degrades to full table scan
      db.exec("DROP INDEX idx_chase_log_status;");
      const planWithoutIndex = db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM chase_log WHERE status = 'draft'")
        .all() as Array<{ detail: string }>;
      const detailWithout = planWithoutIndex.map((p) => p.detail).join("; ");
      assert.ok(
        detailWithout.includes("SCAN chase_log"),
        `Without index, query must fall back to SCAN chase_log, got: ${detailWithout}`,
      );
    });

    test("2.2 Query B: 'SELECT client_id FROM accounting_connections WHERE provider = ? AND tenant_id = ?' uses idx_accounting_connections_lookup", () => {
      const db = createFreshMigratedDb();

      const planWithIndex = db
        .prepare("EXPLAIN QUERY PLAN SELECT client_id FROM accounting_connections WHERE provider = ? AND tenant_id = ?")
        .all() as Array<{ detail: string }>;

      const detail = planWithIndex.map((p) => p.detail).join("; ");
      assert.ok(
        detail.includes("idx_accounting_connections_lookup"),
        `Expected plan to use idx_accounting_connections_lookup, got: ${detail}`,
      );
      assert.ok(
        !detail.includes("SCAN accounting_connections"),
        `Plan should not perform a full table scan, got: ${detail}`,
      );

      // Contrast: Drop index and verify degradation
      db.exec("DROP INDEX idx_accounting_connections_lookup;");
      const planWithoutIndex = db
        .prepare("EXPLAIN QUERY PLAN SELECT client_id FROM accounting_connections WHERE provider = ? AND tenant_id = ?")
        .all() as Array<{ detail: string }>;
      const detailWithout = planWithoutIndex.map((p) => p.detail).join("; ");
      assert.ok(
        detailWithout.includes("SCAN accounting_connections"),
        `Without index, query must fall back to SCAN accounting_connections, got: ${detailWithout}`,
      );
    });

    test("2.3 Query C: 'SELECT id FROM clients WHERE status = 'active'' uses idx_clients_status", () => {
      const db = createFreshMigratedDb();

      const planWithIndex = db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM clients WHERE status = 'active'")
        .all() as Array<{ detail: string }>;

      const detail = planWithIndex.map((p) => p.detail).join("; ");
      assert.ok(
        detail.includes("idx_clients_status"),
        `Expected plan to use idx_clients_status, got: ${detail}`,
      );
      assert.ok(
        !detail.includes("SCAN clients"),
        `Plan should not perform a full table scan, got: ${detail}`,
      );

      // Contrast: Drop index and verify degradation
      db.exec("DROP INDEX idx_clients_status;");
      const planWithoutIndex = db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM clients WHERE status = 'active'")
        .all() as Array<{ detail: string }>;
      const detailWithout = planWithoutIndex.map((p) => p.detail).join("; ");
      assert.ok(
        detailWithout.includes("SCAN clients"),
        `Without index, query must fall back to SCAN clients, got: ${detailWithout}`,
      );
    });

    test("2.4 Query D: 'SELECT id FROM invoices WHERE client_id = ? ORDER BY due_date DESC' uses idx_invoices_client_due WITHOUT temporary B-tree sort", () => {
      const db = createFreshMigratedDb();

      const planWithIndex = db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM invoices WHERE client_id = ? ORDER BY due_date DESC")
        .all() as Array<{ detail: string }>;

      const detail = planWithIndex.map((p) => p.detail).join("; ");
      assert.ok(
        detail.includes("idx_invoices_client_due"),
        `Expected plan to use idx_invoices_client_due, got: ${detail}`,
      );
      assert.ok(
        !detail.includes("USE TEMP B-TREE FOR ORDER BY"),
        `Composite index must eliminate temporary B-tree sort for ORDER BY, got: ${detail}`,
      );

      // Contrast: Drop composite index and verify that it requires USE TEMP B-TREE FOR ORDER BY
      db.exec("DROP INDEX idx_invoices_client_due;");
      const planWithoutIndex = db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM invoices WHERE client_id = ? ORDER BY due_date DESC")
        .all() as Array<{ detail: string }>;
      const detailWithout = planWithoutIndex.map((p) => p.detail).join("; ");
      assert.ok(
        detailWithout.includes("USE TEMP B-TREE FOR ORDER BY"),
        `Without composite index (client_id, due_date DESC), query must require USE TEMP B-TREE FOR ORDER BY, got: ${detailWithout}`,
      );
    });

    test("2.5 Verify query plans directly against the live local D1 SQLite database", () => {
      const db = new DatabaseSync(localD1DbPath);

      // Query A
      const planA = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM chase_log WHERE status = 'draft'").all() as Array<{ detail: string }>;
      assert.ok(planA.some((p) => p.detail.includes("idx_chase_log_status")));

      // Query B
      const planB = db.prepare("EXPLAIN QUERY PLAN SELECT client_id FROM accounting_connections WHERE provider = ? AND tenant_id = ?").all() as Array<{ detail: string }>;
      assert.ok(planB.some((p) => p.detail.includes("idx_accounting_connections_lookup")));

      // Query C
      const planC = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM clients WHERE status = 'active'").all() as Array<{ detail: string }>;
      assert.ok(planC.some((p) => p.detail.includes("idx_clients_status")));

      // Query D
      const planD = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM invoices WHERE client_id = ? ORDER BY due_date DESC").all() as Array<{ detail: string }>;
      assert.ok(planD.some((p) => p.detail.includes("idx_invoices_client_due")));
      assert.ok(!planD.some((p) => p.detail.includes("USE TEMP B-TREE")));
    });
  });

  // =========================================================================
  // SUITE 3: Foreign Key Constraint Stress (PRAGMA foreign_keys = ON)
  // =========================================================================
  describe("3. Foreign Key Constraint Stress (PRAGMA foreign_keys = ON)", () => {
    test("3.1 Prevents orphan invoices: inserting invoice with non-existent client_id throws foreign key constraint failure", () => {
      const db = createFreshMigratedDb();

      assert.throws(
        () => {
          db.prepare(
            `INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
             VALUES (999999, 'Phantom Debtor', 'INV-ORPHAN-1', 10000, '2026-09-01')`,
          ).run();
        },
        (err: any) => {
          assert.ok(err.message.includes("FOREIGN KEY constraint failed") || err.code === "SQLITE_CONSTRAINT_FOREIGNKEY");
          return true;
        },
        "Must throw foreign key constraint violation when client_id does not exist",
      );
    });

    test("3.2 Prevents orphan chase_log entries: inserting chase_log with non-existent invoice_id throws foreign key failure", () => {
      const db = createFreshMigratedDb();

      assert.throws(
        () => {
          db.prepare(
            `INSERT INTO chase_log (invoice_id, step, channel, status)
             VALUES (888888, 1, 'email', 'draft')`,
          ).run();
        },
        (err: any) => {
          assert.ok(err.message.includes("FOREIGN KEY constraint failed") || err.code === "SQLITE_CONSTRAINT_FOREIGNKEY");
          return true;
        },
        "Must throw foreign key constraint violation when invoice_id does not exist",
      );
    });

    test("3.3 Prevents client deletion when active invoices reference it", () => {
      const db = createFreshMigratedDb();

      // Seed client and invoice
      db.prepare("INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Parent Client', 'p@test.com')").run();
      db.prepare(`
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (10, 1, 'Debtor Co', 'INV-REF-1', 50000, '2026-09-10')
      `).run();

      // Attempt to delete client 1
      assert.throws(
        () => {
          db.prepare("DELETE FROM clients WHERE id = 1").run();
        },
        (err: any) => {
          assert.ok(err.message.includes("FOREIGN KEY constraint failed") || err.code === "SQLITE_CONSTRAINT_FOREIGNKEY");
          return true;
        },
        "Must prevent deleting client that has dependent invoices",
      );

      // Verify client 1 still exists intact
      const client = db.prepare("SELECT id FROM clients WHERE id = 1").all();
      assert.strictEqual(client.length, 1);
    });

    test("3.4 Prevents invoice deletion when chase_log records reference it", () => {
      const db = createFreshMigratedDb();

      db.prepare("INSERT INTO clients (id, company_name, contact_email) VALUES (2, 'Client 2', 'c2@test.com')").run();
      db.prepare(`
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (20, 2, 'Debtor 2', 'INV-REF-2', 75000, '2026-09-10')
      `).run();
      db.prepare(`
        INSERT INTO chase_log (id, invoice_id, step, status)
        VALUES (200, 20, 1, 'sent')
      `).run();

      // Attempt to delete invoice 20
      assert.throws(
        () => {
          db.prepare("DELETE FROM invoices WHERE id = 20").run();
        },
        (err: any) => {
          assert.ok(err.message.includes("FOREIGN KEY constraint failed") || err.code === "SQLITE_CONSTRAINT_FOREIGNKEY");
          return true;
        },
        "Must prevent deleting invoice with dependent chase_log rows",
      );

      // Verify invoice 20 still exists
      const inv = db.prepare("SELECT id FROM invoices WHERE id = 20").all();
      assert.strictEqual(inv.length, 1);
    });

    test("3.5 Prevents orphan accounting_connections: non-existent client_id throws foreign key failure", () => {
      const db = createFreshMigratedDb();

      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at)
            VALUES (77777, 'xero', 'tenant-77', 'enc_a', 'enc_r', '2026-10-01T00:00:00Z')
          `).run();
        },
        (err: any) => {
          assert.ok(err.message.includes("FOREIGN KEY constraint failed") || err.code === "SQLITE_CONSTRAINT_FOREIGNKEY");
          return true;
        },
        "Must prevent inserting accounting_connection with nonexistent client_id",
      );
    });
  });

  // =========================================================================
  // SUITE 4: Unique Tenant Constraint Stress (UNIQUE (client_id, invoice_number))
  // =========================================================================
  describe("4. Unique Tenant Constraint Stress (UNIQUE (client_id, invoice_number))", () => {
    test("4.1 Duplicate (client_id, invoice_number) within same client is rejected with UNIQUE constraint violation", () => {
      const db = createFreshMigratedDb();

      db.prepare("INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client One', 'c1@test.com')").run();
      db.prepare(`
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 'Debtor A', 'INV-DUP-100', 50000, '2026-09-01')
      `).run();

      // Attempt duplicate invoice_number for Client 1
      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
            VALUES (1, 'Debtor B', 'INV-DUP-100', 60000, '2026-09-02')
          `).run();
        },
        (err: any) => {
          assert.ok(err.message.includes("UNIQUE constraint failed") || err.code === "SQLITE_CONSTRAINT_UNIQUE");
          return true;
        },
        "Must reject duplicate invoice_number for same client_id",
      );
    });

    test("4.2 Identical invoice_number across different clients succeeds (tenant isolation)", () => {
      const db = createFreshMigratedDb();

      db.prepare("INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client 1', 'c1@test.com'), (2, 'Client 2', 'c2@test.com')").run();

      // Client 1 has INV-COMMON-001
      db.prepare(`
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 'Debtor A', 'INV-COMMON-001', 50000, '2026-09-01')
      `).run();

      // Client 2 also has INV-COMMON-001 (should succeed!)
      assert.doesNotThrow(() => {
        db.prepare(`
          INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
          VALUES (2, 'Debtor B', 'INV-COMMON-001', 99000, '2026-09-05')
        `).run();
      });

      const invs = db.prepare("SELECT client_id, invoice_number, amount_pence FROM invoices WHERE invoice_number = 'INV-COMMON-001'").all();
      assert.strictEqual(invs.length, 2);
    });

    test("4.3 Updating an invoice number to collide with an existing invoice in the same client is rejected", () => {
      const db = createFreshMigratedDb();

      db.prepare("INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client 1', 'c1@test.com')").run();
      db.prepare(`
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date) VALUES
          (101, 1, 'Debtor 1', 'INV-A', 10000, '2026-09-01'),
          (102, 1, 'Debtor 2', 'INV-B', 20000, '2026-09-01')
      `).run();

      // Attempt update invoice 102 to INV-A
      assert.throws(
        () => {
          db.prepare("UPDATE invoices SET invoice_number = 'INV-A' WHERE id = 102").run();
        },
        (err: any) => {
          assert.ok(err.message.includes("UNIQUE constraint failed") || err.code === "SQLITE_CONSTRAINT_UNIQUE");
          return true;
        },
      );
    });

    test("4.4 Accounting connections UNIQUE (client_id, provider) prevents duplicate provider connections per tenant", () => {
      const db = createFreshMigratedDb();

      db.prepare("INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client 1', 'c1@test.com')").run();

      db.prepare(`
        INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at)
        VALUES (1, 'xero', 'xero-t1', 'enc1', 'ref1', '2026-10-01T00:00:00Z')
      `).run();

      // Second connection for same provider and client should fail
      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at)
            VALUES (1, 'xero', 'xero-t2', 'enc2', 'ref2', '2026-10-02T00:00:00Z')
          `).run();
        },
        (err: any) => {
          assert.ok(err.message.includes("UNIQUE constraint failed") || err.code === "SQLITE_CONSTRAINT_UNIQUE");
          return true;
        },
      );

      // But quickbooks for client 1 should succeed
      assert.doesNotThrow(() => {
        db.prepare(`
          INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at)
          VALUES (1, 'quickbooks', 'qb-t1', 'enc3', 'ref3', '2026-10-01T00:00:00Z')
        `).run();
      });
    });
  });

  // =========================================================================
  // SUITE 5: Domain CHECK Constraints & Data Integrity Stress
  // =========================================================================
  describe("5. Domain CHECK Constraints & Data Integrity Stress", () => {
    test("5.1 Invoices table CHECK (amount_pence > 0) rejects zero or negative amounts", () => {
      const db = createFreshMigratedDb();
      db.prepare("INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client 1', 'c1@test.com')").run();

      // Zero amount
      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
            VALUES (1, 'Debtor Zero', 'INV-ZERO', 0, '2026-09-01')
          `).run();
        },
        (err: any) => {
          assert.ok(err.message.includes("CHECK constraint failed") || err.code === "SQLITE_CONSTRAINT_CHECK");
          return true;
        },
      );

      // Negative amount
      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
            VALUES (1, 'Debtor Neg', 'INV-NEG', -5000, '2026-09-01')
          `).run();
        },
        (err: any) => {
          assert.ok(err.message.includes("CHECK constraint failed") || err.code === "SQLITE_CONSTRAINT_CHECK");
          return true;
        },
      );
    });

    test("5.2 Invoices table status CHECK constraint rejects invalid status values", () => {
      const db = createFreshMigratedDb();
      db.prepare("INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client 1', 'c1@test.com')").run();

      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date, status)
            VALUES (1, 'Debtor Bad Status', 'INV-BAD', 10000, '2026-09-01', 'nonexistent_status')
          `).run();
        },
        (err: any) => {
          assert.ok(err.message.includes("CHECK constraint failed") || err.code === "SQLITE_CONSTRAINT_CHECK");
          return true;
        },
      );
    });

    test("5.3 Chase log status CHECK constraint strictly restricts values to ('draft', 'sent', 'skipped')", () => {
      const db = createFreshMigratedDb();
      db.prepare("INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client 1', 'c1@test.com')").run();
      db.prepare(`
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (10, 1, 'Debtor 1', 'INV-10', 10000, '2026-09-01')
      `).run();

      // Valid values should succeed
      for (const st of ["draft", "sent", "skipped"]) {
        assert.doesNotThrow(() => {
          db.prepare(`INSERT INTO chase_log (invoice_id, step, status) VALUES (10, 1, '${st}')`).run();
        });
      }

      // Invalid value should fail
      assert.throws(
        () => {
          db.prepare("INSERT INTO chase_log (invoice_id, step, status) VALUES (10, 1, 'invalid_status')").run();
        },
        (err: any) => {
          assert.ok(err.message.includes("CHECK constraint failed") || err.code === "SQLITE_CONSTRAINT_CHECK");
          return true;
        },
      );
    });
  });
});
