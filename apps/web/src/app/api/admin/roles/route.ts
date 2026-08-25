import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/access";
import {
  assignableRoleKeys,
  roleRequiresGovernanceApproval,
  scopeTypes,
  type RoleKey,
  type ScopeType,
} from "@/lib/authorization-model";
import { writeAuditEvent } from "@/lib/audit";
import { transaction } from "@/lib/db";
import { accessErrorResponse, jsonError, requestIsSameOrigin } from "@/lib/request-security";

const roleGrantSchema = z
  .object({
    personId: z.string().uuid(),
    roleKey: z.enum(assignableRoleKeys),
    scopeType: z.enum(scopeTypes).default("organization"),
    scopeId: z.string().uuid().nullable().optional(),
    reason: z.string().trim().min(10).max(500),
    endsAt: z.string().datetime().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scopeType === "organization" && value.scopeId) {
      ctx.addIssue({ code: "custom", path: ["scopeId"], message: "Organization-scoped roles cannot include a scope ID." });
    }
    if (value.scopeType !== "organization" && !value.scopeId) {
      ctx.addIssue({ code: "custom", path: ["scopeId"], message: "Scoped roles require a scope ID." });
    }
    if (value.endsAt && new Date(value.endsAt).getTime() <= Date.now()) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "Role expiry must be in the future." });
    }
  });

interface PersonRow extends QueryResultRow {
  id: string;
  display_name: string;
  active: boolean;
}

interface AssignmentRow extends QueryResultRow {
  id: string;
  person_id: string;
  role_key: RoleKey;
  scope_type: ScopeType;
  scope_id: string | null;
  starts_at: Date;
  ends_at: Date | null;
}

function permissionScope(scopeType: ScopeType, scopeId: string | null) {
  if (scopeType === "organization") return { type: "organization" as const };
  if (!scopeId) throw new Error("Scoped role assignment is missing a scope ID.");
  return { type: scopeType, id: scopeId };
}

function hasActiveBreakGlass(roles: readonly { role_key: RoleKey }[]) {
  return roles.some((role) => role.role_key === "break_glass");
}

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return jsonError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.");
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return jsonError(413, "PAYLOAD_TOO_LARGE", "Role assignment payload is too large.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  const parsed = roleGrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "The role assignment request is invalid.",
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  const scopeId = parsed.data.scopeType === "organization" ? null : parsed.data.scopeId ?? null;
  const scope = permissionScope(parsed.data.scopeType, scopeId);
  const correlationId = randomUUID();

  try {
    const principal = await requirePermission("roles:manage", scope);

    if (roleRequiresGovernanceApproval(parsed.data.roleKey) && !hasActiveBreakGlass(principal.roles)) {
      return jsonError(
        403,
        "GOVERNANCE_APPROVAL_REQUIRED",
        "This sensitive or governance role cannot be granted through direct technical access management.",
      );
    }

    const endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : null;

    const result = await transaction(async (client) => {
      const lockKey = `${parsed.data.personId}|${parsed.data.roleKey}|${parsed.data.scopeType}|${scopeId ?? "organization"}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);

      const personResult = await client.query<PersonRow>(
        `SELECT id, display_name, active
           FROM app.person_profile
          WHERE id = $1
          LIMIT 1`,
        [parsed.data.personId],
      );
      const person = personResult.rows[0];
      if (!person || !person.active) {
        return { kind: "person_missing" as const };
      }

      const overlap = await client.query<AssignmentRow>(
        `SELECT id, person_id, role_key, scope_type, scope_id, starts_at, ends_at
           FROM app.role_assignment
          WHERE person_id = $1
            AND role_key = $2
            AND scope_type = $3
            AND scope_id IS NOT DISTINCT FROM $4::uuid
            AND tstzrange(starts_at, COALESCE(ends_at, 'infinity'::timestamptz), '[)')
                && tstzrange(now(), COALESCE($5::timestamptz, 'infinity'::timestamptz), '[)')
          ORDER BY starts_at DESC
          LIMIT 1`,
        [parsed.data.personId, parsed.data.roleKey, parsed.data.scopeType, scopeId, endsAt],
      );

      if (overlap.rows[0]) {
        return { kind: "existing" as const, assignment: overlap.rows[0] };
      }

      const inserted = await client.query<AssignmentRow>(
        `INSERT INTO app.role_assignment (
           person_id, role_key, scope_type, scope_id, granted_by, reason, starts_at, ends_at
         ) VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
         RETURNING id, person_id, role_key, scope_type, scope_id, starts_at, ends_at`,
        [
          parsed.data.personId,
          parsed.data.roleKey,
          parsed.data.scopeType,
          scopeId,
          principal.personId,
          parsed.data.reason,
          endsAt,
        ],
      );

      const assignment = inserted.rows[0];
      if (!assignment) throw new Error("Role assignment insert did not return a row.");

      await writeAuditEvent(
        {
          actorPersonId: principal.personId,
          domain: "authorization",
          action: "role.granted",
          targetType: "role_assignment",
          targetId: assignment.id,
          afterState: {
            personId: assignment.person_id,
            roleKey: assignment.role_key,
            scopeType: assignment.scope_type,
            scopeId: assignment.scope_id,
            startsAt: assignment.starts_at.toISOString(),
            endsAt: assignment.ends_at?.toISOString() ?? null,
          },
          reason: parsed.data.reason,
          correlationId,
        },
        client,
      );

      return { kind: "created" as const, assignment };
    });

    if (result.kind === "person_missing") {
      return jsonError(404, "PERSON_NOT_FOUND", "The target person does not exist or is inactive.");
    }

    return NextResponse.json(
      {
        ok: true,
        roleAssignmentId: result.assignment.id,
        replay: result.kind === "existing",
      },
      {
        status: result.kind === "existing" ? 200 : 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;

    console.error("role grant failed", { correlationId, error });
    return jsonError(500, "ROLE_GRANT_FAILED", "The role assignment could not be completed.");
  }
}
