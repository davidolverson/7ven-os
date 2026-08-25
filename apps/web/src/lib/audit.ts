import type { PoolClient } from "pg";
import { query } from "@/lib/db";

export interface AuditEventInput {
  actorPersonId?: string;
  actorKind?: "user" | "system" | "break_glass" | "external_reviewer";
  domain: string;
  action: string;
  targetType?: string;
  targetId?: string;
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export async function writeAuditEvent(input: AuditEventInput, client?: PoolClient) {
  const sql = `INSERT INTO app.audit_event (
      actor_person_id, actor_kind, domain, action, target_type, target_id,
      before_state, after_state, reason, correlation_id, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7::jsonb, $8::jsonb, $9, COALESCE($10::uuid, gen_random_uuid()), $11::jsonb
    )`;

  const values = [
    input.actorPersonId ?? null,
    input.actorKind ?? "user",
    input.domain,
    input.action,
    input.targetType ?? null,
    input.targetId ?? null,
    input.beforeState === undefined ? null : JSON.stringify(input.beforeState),
    input.afterState === undefined ? null : JSON.stringify(input.afterState),
    input.reason ?? null,
    input.correlationId ?? null,
    JSON.stringify(input.metadata ?? {}),
  ] as const;

  if (client) {
    await client.query(sql, [...values]);
    return;
  }

  await query(sql, values);
}
