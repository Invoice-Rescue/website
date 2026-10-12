/**
 * Fixed-window rate limiting backed by D1 (table `rate_limits`, migration 0008).
 *
 * Used on the unauthenticated routes that trigger a real email send (/portal/login, /api/lead) —
 * without it each request is a free send, i.e. an email-flooding amplifier. D1 rather than the
 * Workers Rate Limiting binding so the same code runs unchanged in the node:test harness, and
 * because at this traffic level one extra upsert per request is negligible.
 */

export interface RateLimitRule {
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * Records one hit against `bucket` and reports whether it is still within `rule`.
 * Counting happens before the check so a flood can't slip through between read and write.
 */
export async function consumeRateLimit(
  db: D1Database,
  bucket: string,
  rule: RateLimitRule,
  nowMs = Date.now()
): Promise<boolean> {
  const nowSeconds = Math.floor(nowMs / 1000);
  const windowStart = nowSeconds - (nowSeconds % rule.windowSeconds);

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?1, ?2, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET hits = hits + 1
       RETURNING hits`
    )
    .bind(bucket, windowStart)
    .first<{ hits: number }>();

  // Expired windows are never read again; prune them so the table stays tiny.
  await db
    .prepare(`DELETE FROM rate_limits WHERE bucket = ?1 AND window_start < ?2`)
    .bind(bucket, windowStart)
    .run();

  return (row?.hits ?? 1) <= rule.limit;
}

/** Best-effort client address for bucketing; Cloudflare always sets CF-Connecting-IP in production. */
export function clientAddress(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
