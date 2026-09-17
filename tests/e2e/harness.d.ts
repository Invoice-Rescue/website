import { DatabaseSync } from "node:sqlite";
export interface MockEmailMessage {
    to: string;
    from: {
        name: string;
        email: string;
    };
    subject: string;
    text?: string;
    html?: string;
}
export declare class MockEmailBinding {
    sent: MockEmailMessage[];
    send(message: MockEmailMessage): Promise<void>;
    clear(): void;
}
export interface TestD1Database {
    prepare(sql: string): TestD1PreparedStatement;
    batch<T = unknown>(statements: TestD1PreparedStatement[]): Promise<Array<{
        results: T[];
        meta: {
            changes: number;
            last_row_id: number;
        };
    }>>;
    exec(query: string): Promise<{
        count: number;
        duration: number;
    }>;
    rawSqlite: DatabaseSync;
}
export interface TestD1PreparedStatement {
    bind(...params: unknown[]): TestD1PreparedStatement;
    first<T = unknown>(col?: string): Promise<T | null>;
    all<T = unknown>(): Promise<{
        results: T[];
        meta: {
            changes: number;
            last_row_id: number;
        };
    }>;
    run(): Promise<{
        results: [];
        meta: {
            changes: number;
            last_row_id: number;
        };
    }>;
}
export declare function createTestDb(): TestD1Database;
export interface TestEnvFixture {
    env: Env;
    db: TestD1Database;
    notify: MockEmailBinding;
    send: MockEmailBinding;
}
export declare function createTestEnv(overrides?: Partial<Env>): TestEnvFixture;
export declare function createBasicAuthHeader(secret?: string): string;
export declare function signHmacSha256(payload: string, keyString: string): Promise<string>;
export declare function signStripeWebhook(body: string, secret: string, timestampSeconds: number): Promise<string>;
