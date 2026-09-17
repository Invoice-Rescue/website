import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
export class MockEmailBinding {
    sent = [];
    async send(message) {
        this.sent.push(message);
    }
    clear() {
        this.sent = [];
    }
}
export function createTestDb() {
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
    function createStatement(sql, initialParams = []) {
        let boundParams = [...initialParams];
        return {
            bind(...params) {
                boundParams = params;
                return this;
            },
            async first(col) {
                const stmt = sqlite.prepare(sql);
                const row = stmt.get(...boundParams);
                if (!row)
                    return null;
                if (col)
                    return (row[col] ?? null);
                return row;
            },
            async all() {
                const stmt = sqlite.prepare(sql);
                const rows = stmt.all(...boundParams);
                return {
                    results: rows,
                    meta: { changes: 0, last_row_id: 0 },
                };
            },
            async run() {
                const stmt = sqlite.prepare(sql);
                const res = stmt.run(...boundParams);
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
        prepare(sql) {
            return createStatement(sql);
        },
        async batch(statements) {
            sqlite.exec("BEGIN TRANSACTION;");
            try {
                const results = [];
                for (const stmt of statements) {
                    const res = await stmt.all();
                    results.push(res);
                }
                sqlite.exec("COMMIT;");
                return results;
            }
            catch (err) {
                sqlite.exec("ROLLBACK;");
                throw err;
            }
        },
        async exec(query) {
            sqlite.exec(query);
            return { count: 1, duration: 0 };
        },
        rawSqlite: sqlite,
    };
}
export function createTestEnv(overrides) {
    const db = createTestDb();
    const notify = new MockEmailBinding();
    const send = new MockEmailBinding();
    const env = {
        DB: db,
        NOTIFY: notify,
        SEND: send,
        ASSETS: {
            fetch: async () => new Response("Not Found", { status: 404 }),
        },
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
export function createBasicAuthHeader(secret = "admin-test-secret-12345") {
    return `Basic ${btoa(`admin:${secret}`)}`;
}
export async function signHmacSha256(payload, keyString) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(keyString), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
export async function signStripeWebhook(body, secret, timestampSeconds) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampSeconds}.${body}`));
    const hex = Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return `t=${timestampSeconds},v1=${hex}`;
}
