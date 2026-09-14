import { test, describe } from "node:test";
import assert from "node:assert";
import { parseCsv } from "../backend/src/lib/csv";

describe("csv parser", () => {
  test("parses standard tabular CSV correctly", () => {
    const csvData = [
      "invoice_number,debtor_name,debtor_email,amount,currency,due_date",
      "INV-1001,Acme Corp,billing@acme.test,1250.00,GBP,2026-08-01",
      "INV-1002,Beta Ltd,finance@beta.test,450.50,GBP,2026-08-15",
    ].join("\n");

    const rows = parseCsv(csvData);
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows[0], {
      invoice_number: "INV-1001",
      debtor_name: "Acme Corp",
      debtor_email: "billing@acme.test",
      amount: "1250.00",
      currency: "GBP",
      due_date: "2026-08-01",
    });
    assert.deepStrictEqual(rows[1], {
      invoice_number: "INV-1002",
      debtor_name: "Beta Ltd",
      debtor_email: "finance@beta.test",
      amount: "450.50",
      currency: "GBP",
      due_date: "2026-08-15",
    });
  });

  test("handles embedded commas and escaped quotes within fields", () => {
    const csvData = [
      "invoice_number,debtor_name,notes",
      'INV-2001,"Smith, Jones & Co",Regular customer',
      'INV-2002,"The ""Best"" Bakery Ltd",Priority account',
    ].join("\n");

    const rows = parseCsv(csvData);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].debtor_name, "Smith, Jones & Co");
    assert.strictEqual(rows[1].debtor_name, 'The "Best" Bakery Ltd');
  });

  test("handles empty rows and Windows CRLF newlines gracefully", () => {
    const csvData = "col1,col2\r\nval1,val2\r\n\r\nval3,val4\r\n";
    const rows = parseCsv(csvData);
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows[0], { col1: "val1", col2: "val2" });
    assert.deepStrictEqual(rows[1], { col1: "val3", col2: "val4" });
  });

  test("returns empty array for empty or whitespace-only input", () => {
    assert.deepStrictEqual(parseCsv(""), []);
    assert.deepStrictEqual(parseCsv("\n\n"), []);
  });
});
