import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface MockEmailMessage {
  to: string;
  from: { name: string; email: string };
  subject: string;
  text?: string;
  html?: string;
}

export class MockEmailBinding {
  public sent: MockEmailMessage[] = [];

  async send(message: MockEmailMessage): Promise<void> {
    this.sent.push(message);
  }

  clear(): void {
    this.sent = [];
  }
}

export interface TestD1Database {
  prepare(sql: string): TestD1PreparedStatement;
  batch<T = unknown>(statements: TestD1PreparedStatement[]): Promise<Array<{ results: T[]; meta: { changes: number; last_row_id: number } }>>;
  exec(query: string): Promise<{ count: number; duration: number }>;
  rawSqlite: DatabaseSync;
}

export interface TestD1PreparedStatement {
  bind(...params: unknown[]): TestD1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[]; meta: { changes: number; last_row_id: number } }>;
  run(): Promise<{ results: []; meta: { changes: number; last_row_id: number } }>;
}

export function createTestDb(): TestD1Database {
  const sqlite = new DatabaseSync(":memory:");

  // Read and apply all migrations in sequential order
  const migrationsDir = join(process.cwd(), "backend", "db", "migrations");
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    sqlite.exec(sql);
  }

  function createStatement(sql: string, initialParams: unknown[] = []): TestD1PreparedStatement {
    let boundParams = [...initialParams];
    return {
      bind(...params: unknown[]) {
        boundParams = params;
        return this;
      },
      async first<T = unknown>(col?: string): Promise<T | null> {
        const stmt = sqlite.prepare(sql);
        const row = stmt.get(...(boundParams as any[])) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (col) return (row[col] ?? null) as T;
        return row as T;
      },
      async all<T = unknown>(): Promise<{ results: T[]; meta: { changes: number; last_row_id: number } }> {
        const stmt = sqlite.prepare(sql);
        const rows = stmt.all(...(boundParams as any[])) as T[];
        return {
          results: rows,
          meta: { changes: 0, last_row_id: 0 },
        };
      },
      async run(): Promise<{ results: []; meta: { changes: number; last_row_id: number } }> {
        const stmt = sqlite.prepare(sql);
        const res = stmt.run(...(boundParams as any[]));
        return {
          results: [],
          meta: {
            changes: Number(res.changes),
            last_row_id: Number(res.lastInsertRowid),
          },
        };
      },
    };
  }

  return {
    prepare(sql: string) {
      return createStatement(sql);
    },
    async batch<T = unknown>(statements: TestD1PreparedStatement[]) {
      sqlite.exec("BEGIN TRANSACTION;");
      try {
        const results = [];
        for (const stmt of statements) {
          const res = await stmt.all<T>();
          results.push(res);
        }
        sqlite.exec("COMMIT;");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK;");
        throw err;
      }
    },
    async exec(query: string) {
      sqlite.exec(query);
      return { count: 1, duration: 0 };
    },
    rawSqlite: sqlite,
  };
}

export interface TestEnvFixture {
  env: Env;
  db: TestD1Database;
  notify: MockEmailBinding;
  send: MockEmailBinding;
}

export function createTestEnv(overrides?: Partial<Env>): TestEnvFixture {
  const db = createTestDb();
  const notify = new MockEmailBinding();
  const send = new MockEmailBinding();

  const env: Env = {
    DB: db as unknown as D1Database,
    NOTIFY: notify as unknown as SendEmail,
    SEND: send as unknown as SendEmail,
    ASSETS: {
      fetch: async () => new Response("Not Found", { status: 404 }),
    } as unknown as Fetcher,
    ADMIN_SECRET: "admin-test-secret-12345",
    PORTAL_SESSION_SECRET: "portal-session-secret-key-32-chars-long-12345!",
    STRIPE_SECRET_KEY: "sk_test_mock_stripe_key",
    STRIPE_WEBHOOK_SECRET: "whsec_test_stripe_secret_key_mock",
    GEMINI_API_KEY: "mock_gemini_api_key",
    BOE_BASE_RATE_PERCENT: "3.75",
    OPERATOR_NAME: "Tibor Rames",
    NOTIFY_TO: "tiborcc2@gmail.com",
    NOTIFY_FROM: "hello@invoicerescue.co.uk",
    STRIPE_PUBLISHABLE_KEY: "pk_test_mock",
    OPENROUTER_API_KEY: "mock",
    CLOUDFLARE_API_TOKEN: "mock",
    ACCESS_KEY_ID: "mock",
    SECRET_ACCESS_KEY: "mock",
    S3_ENDPOINT: "mock",
    STRIPE_SECRET_LIVE_KEY: "mock",
    STRIPE_SECRET_TEST_KEY: "mock",
    STRIPE_PUBLISHABLE_TEST_KEY: "mock",
    STRIPE_WEBHOOK_SECRET_TEST: "mock",
    STRIPE_WEBHOOK_SECRET_LIVE: "mock",
    ...overrides,
  };

  return { env, db, notify, send };
}

export function createBasicAuthHeader(secret: string = "admin-test-secret-12345"): string {
  return `Basic ${btoa(`admin:${secret}`)}`;
}

export async function signHmacSha256(payload: string, keyString: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyString),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function signStripeWebhook(body: string, secret: string, timestampSeconds: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampSeconds}.${body}`));
  const hex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestampSeconds},v1=${hex}`;
}

