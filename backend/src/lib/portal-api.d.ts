/**
 * Invoice Rescue — Client Portal & Review Queue API (Milestone M3 / R3)
 *
 * Implements the 6 core portal and review queue endpoints:
 * 1. handlePortalDashboardData: Executive overview metrics, 4-tier aging breakdown, pipeline, recent activity
 * 2. handlePortalDebtors: Debtor ledger with debounced search, stage/status filtering, and multi-column sorting
 * 3. handleGetDrafts: Review queue listing with full statutory claim calculation breakdown
 * 4. handleApproveDraft: Approves draft, dispatches email via env.SEND locked to hello@invoicerescue.co.uk
 * 5. handleSkipDraft: Skips/defers draft with zero emails sent
 * 6. handleUpdateDraft: In-place message edit saving in chase_log
 *
 * Enforces strict tenant isolation, locked sender model, and zero external runtime dependencies.
 */
export declare const SENDER_NAME = "Invoice Rescue";
export declare const LOCKED_SENDER_EMAIL = "hello@invoicerescue.co.uk";
export declare const SECURITY_HEADERS: Record<string, string>;
export interface AuthContext {
    isAdmin: boolean;
    clientId: number | null;
}
/**
 * Resolves request authentication:
 * 1. Admin Basic Auth (Authorization: Basic <base64>)
 * 2. Client Session (Authorization: Bearer <token> or portal_session cookie)
 * 3. Returns { auth, errorResponse }
 */
export declare function resolveAuth(request: Request, env: Env): Promise<{
    auth: AuthContext | null;
    errorResponse: Response | null;
}>;
/**
 * Resolves the target clientId for client portal requests:
 * - If client session: strictly enforces session clientId. Rejects mismatching ?client_id with 403.
 * - If admin: uses ?client_id if provided.
 * - If unauthenticated (demo mode): falls back to the first active client.
 */
export declare function resolvePortalClientId(request: Request, env: Env): Promise<{
    clientId: number | null;
    errorResponse: Response | null;
}>;
/**
 * Calculates days overdue between invoice due_date and current timestamp.
 */
export declare function calculateDaysOverdue(dueDateStr: string): number;
/**
 * Derives escalation stage (0 to 4) and human-readable label.
 */
export declare function deriveStage(daysOverdue: number, maxStepFromChaseLog?: number | null): {
    stage: number;
    label: string;
};
/**
 * Formats a monetary amount in major currency units.
 */
export declare function formatMoney(amountPence: number, currency?: string): string;
export declare function handlePortalDashboardData(request: Request, env: Env): Promise<Response>;
export declare function handlePortalDebtors(request: Request, env: Env): Promise<Response>;
export declare function handleGetDrafts(request: Request, env: Env): Promise<Response>;
export declare function handleApproveDraft(request: Request, env: Env, draftIdParam: string): Promise<Response>;
export declare function handleSkipDraft(request: Request, env: Env, draftIdParam: string): Promise<Response>;
export declare function handleUpdateDraft(request: Request, env: Env, draftIdParam: string): Promise<Response>;
