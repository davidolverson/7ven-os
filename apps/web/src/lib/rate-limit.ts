import { createHmac } from "node:crypto";
import type { QueryResultRow } from "pg";
import { env } from "@/lib/env";
import { query } from "@/lib/db";

interface RateLimitRow extends QueryResultRow {
  request_count: number;
  window_started_at: Date;
}

function keyHash(rawKey: string) {
  return createHmac("sha256", env.PRIVACY_HASH_SECRET).update(rawKey).digest("hex");
}

export async function consumeRateLimit(options: {
  bucket: string;
  rawKey: string;
  limit: number;
  windowSeconds: number;
}) {
  const { bucket, rawKey, limit, windowSeconds } = options;
  const hashed = keyHash(rawKey);

  const result = await query<RateLimitRow>(
    `INSERT INTO app.rate_limit_bucket (bucket, key_hash, window_started_at, request_count)
     VALUES ($1, $2, now(), 1)
     ON CONFLICT (bucket, key_hash) DO UPDATE
       SET request_count = CASE
             WHEN app.rate_limit_bucket.window_started_at <= now() - ($3::int * interval '1 second') THEN 1
             ELSE app.rate_limit_bucket.request_count + 1
           END,
           window_started_at = CASE
             WHEN app.rate_limit_bucket.window_started_at <= now() - ($3::int * interval '1 second') THEN now()
             ELSE app.rate_limit_bucket.window_started_at
           END,
           updated_at = now()
     RETURNING request_count, window_started_at`,
    [bucket, hashed, windowSeconds],
  );

  const row = result.rows[0];
  if (!row) throw new Error("Rate limit state was not returned.");

  const elapsedSeconds = Math.max(0, (Date.now() - new Date(row.window_started_at).getTime()) / 1000);
  const retryAfterSeconds = Math.max(1, Math.ceil(windowSeconds - elapsedSeconds));

  return {
    allowed: row.request_count <= limit,
    remaining: Math.max(0, limit - row.request_count),
    retryAfterSeconds,
  };
}
