import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/access";
import {
  governanceProtectedRoleKeys,
  roleRequiresGovernanceApproval,
  scopeTypes,
  type RoleKey,
  type ScopeType,
} from "@/lib/authorization-model";
import { writeAuditEvent } from "@/lib/audit";
import { query, transaction } from "@/lib/db";
import { accessErrorResponse, jsonError, requestIsSameOrigin } from "@/lib/request-security";

const grantRequestSchema = z
  .object({
    operation: z.literal("grant"),
    personId: z.string().uuid(),
    roleKey: z.enum(governanceProtectedRoleKeys),
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

const revokeRequestSchema = z.object({
  operation: z.literal("revoke"),
  roleAssignmentId: z.string().uuid(),
  reason: z.string().trim().min(10).max(500),
});

const roleChangeRequestSchema = z.union([grantRequestSchema, revokeRequestSchema]);

interface PersonRow extends QueryResultRow {
  id: string;
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
  revoked_at: Date | null;
}

interface RoleChangeRequestRow extends QueryResultRow {
  id: string;
  correlation_id: string;
}

function permissionScope(scopeType: ScopeType, scopeId: string | null) {
  if (scopeType === "organization") return { type: "organization" as const };
  if (!scopeId) throw new Error("Scoped governance request is missing a scope ID.");
  return { type: scopeType, id: scopeId };
}

function hasActiveBreakGlass(roles: readonly { role_key: RoleKey }[]) {
  return roles.some((role) => role.role_key === "break_glass");
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return jsonError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.");
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return jsonError(413, "PAYLOAD_TOO_LARGE", "Governance request payload is too large.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  const parsed = roleChangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "The protected role-change request is invalid.",
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  const requestCorrelationId = randomUUID();
  const change = parsed.data;

  try {
    if (change.operation === "grant") {
      const grant = change;
      const scopeId = grant.scopeType === "organization" ? null : grant.scopeId ?? null;
      const scope = permissionScope(grant.scopeType, scopeId);
      const principal = await requirePermission("roles:manage", scope);

      if (hasActiveBreakGlass(principal.roles)) {
        return jsonError(403, "BREAK_GLASS_NOT_NORMAL_GOVERNANCE", "Break-glass access cannot be used to create a normal governance request.");
      }

      const endsAt = grant.endsAt ? new Date(grant.endsAt) : null;
      const result = await transaction(async (client) => {
        const lockKey = `role-change-request|grant|${grant.personId}|${grant.roleKey}|${grant.scopeType}|${scopeId ?? "organization"}`;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);

        const personResult = await client.query<PersonRow>(
          `SELECT id, active
             FROM app.person_profile
            WHERE id = $1
            FOR UPDATE`,
          [grant.personId],
        );
        const person = personResult.rows[0];
        if (!person || !person.active) return { kind: "person_missing" as const };

        const existingRole = await client.query<{ id: string } & QueryResultRow>(
          `SELECT id
             FROM app.role_assignment
            WHERE person_id = $1
              AND role_key = $2
              AND scope_type = $3
              AND scope_id IS NOT DISTINCT FROM $4::uuid
              AND revoked_at IS NULL
              AND tstzrange(starts_at, COALESCE(ends_at, 'infinity'::timestamptz), '[)')
                  && tstzrange(now(), COALESCE($5::timestamptz, 'infinity'::timestamptz), '[)')
            LIMIT 1`,
          [grant.personId, grant.roleKey, grant.scopeType, scopeId, endsAt],
        );
        if (existingRole.rows[0]) return { kind: "already_active" as const };

        const inserted = await client.query<RoleChangeRequestRow>(
          `INSERT INTO app.role_change_request (
             operation, target_person_id, role_key, scope_type, scope_id, requested_ends_at,
             requested_by, request_reason, state, correlation_id
           ) VALUES ('grant', $1, $2, $3, $4, $5, $6, $7, 'pending', $8)
           RETURNING id, correlation_id`,
          [
            grant.personId,
            grant.roleKey,
            grant.scopeType,
            scopeId,
            endsAt,
            principal.personId,
            grant.reason,
            requestCorrelationId,
          ],
        );
        const governanceRequest = inserted.rows[0];
        if (!governanceRequest) throw new Error("Protected role-change request insert did not return a row.");

        await writeAuditEvent(
          {
            actorPersonId: principal.personId,
            domain: "governance",
            action: "role_change.requested",
            targetType: "role_change_request",
            targetId: governanceRequest.id,
            afterState: {
              operation: "grant",
              targetPersonId: grant.personId,
              roleKey: grant.roleKey,
              scopeType: grant.scopeType,
              scopeId,
              requestedEndsAt: endsAt?.toISOString() ?? null,
              state: "pending",
            },
            reason: grant.reason,
            correlationId: governanceRequest.correlation_id,
          },
          client,
        );

        return { kind: "created" as const, request: governanceRequest };
      });

      if (result.kind === "person_missing") {
        return jsonError(404, "PERSON_NOT_FOUND", "The target person does not exist or is inactive.");
      }
      if (result.kind === "already_active") {
        return jsonError(409, "ROLE_ALREADY_ACTIVE", "The protected role is already active for this person and scope.");
      }

      return NextResponse.json(
        { ok: true, roleChangeRequestId: result.request.id, state: "pending" },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }

    const revoke = change;
    const assignmentResult = await query<AssignmentRow>(
      `SELECT id, person_id, role_key, scope_type, scope_id, starts_at, ends_at, revoked_at
         FROM app.role_assignment
        WHERE id = $1
        LIMIT 1`,
      [revoke.roleAssignmentId],
    );
    const assignmentSnapshot = assignmentResult.rows[0];
    if (!assignmentSnapshot) {
      return jsonError(404, "ROLE_ASSIGNMENT_NOT_FOUND", "The role assignment was not found.");
    }
    if (!roleRequiresGovernanceApproval(assignmentSnapshot.role_key)) {
      return jsonError(422, "PROTECTED_ROLE_REQUIRED", "Only governance-protected roles use this request path.");
    }

    const scope = permissionScope(assignmentSnapshot.scope_type, assignmentSnapshot.scope_id);
    const principal = await requirePermission("roles:manage", scope);
    if (hasActiveBreakGlass(principal.roles)) {
      return jsonError(403, "BREAK_GLASS_NOT_NORMAL_GOVERNANCE", "Break-glass access cannot be used to create a normal governance request.");
    }

    const result = await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`role-change-request|revoke|${revoke.roleAssignmentId}`]);

      const selected = await client.query<AssignmentRow>(
        `SELECT id, person_id, role_key, scope_type, scope_id, starts_at, ends_at, revoked_at
           FROM app.role_assignment
          WHERE id = $1
          FOR UPDATE`,
        [revoke.roleAssignmentId],
      );
      const assignment = selected.rows[0];
      if (!assignment) return { kind: "missing" as const };
      if (!roleRequiresGovernanceApproval(assignment.role_key)) return { kind: "not_protected" as const };
      if (assignment.revoked_at || (assignment.ends_at && assignment.ends_at.getTime() <= Date.now())) {
        return { kind: "not_active" as const };
      }

      const inserted = await client.query<RoleChangeRequestRow>(
        `INSERT INTO app.role_change_request (
           operation, target_person_id, target_assignment_id, role_key, scope_type, scope_id,
           requested_by, request_reason, state, correlation_id
         ) VALUES ('revoke', $1, $2, $3, $4, $5, $6, $7, 'pending', $8)
         RETURNING id, correlation_id`,
        [
          assignment.person_id,
          assignment.id,
          assignment.role_key,
          assignment.scope_type,
          assignment.scope_id,
          principal.personId,
          revoke.reason,
          requestCorrelationId,
        ],
      );
      const governanceRequest = inserted.rows[0];
      if (!governanceRequest) throw new Error("Protected role revocation request insert did not return a row.");

      await writeAuditEvent(
        {
          actorPersonId: principal.personId,
          domain: "governance",
          action: "role_change.requested",
          targetType: "role_change_request",
          targetId: governanceRequest.id,
          afterState: {
            operation: "revoke",
            targetPersonId: assignment.person_id,
            targetAssignmentId: assignment.id,
            roleKey: assignment.role_key,
            scopeType: assignment.scope_type,
            scopeId: assignment.scope_id,
            state: "pending",
          },
          reason: revoke.reason,
          correlationId: governanceRequest.correlation_id,
        },
        client,
      );

      return { kind: "created" as const, request: governanceRequest };
    });

    if (result.kind === "missing") {
      return jsonError(404, "ROLE_ASSIGNMENT_NOT_FOUND", "The role assignment was not found.");
    }
    if (result.kind === "not_protected") {
      return jsonError(422, "PROTECTED_ROLE_REQUIRED", "Only governance-protected roles use this request path.");
    }
    if (result.kind === "not_active") {
      return jsonError(409, "ROLE_NOT_ACTIVE", "The protected role assignment is already revoked or ended.");
    }

    return NextResponse.json(
      { ok: true, roleChangeRequestId: result.request.id, state: "pending" },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;
    if (isUniqueViolation(error)) {
      return jsonError(409, "ROLE_CHANGE_ALREADY_PENDING", "An equivalent protected role change is already pending governance review.");
    }

    console.error("protected role-change request failed", { correlationId: requestCorrelationId, error });
    return jsonError(500, "ROLE_CHANGE_REQUEST_FAILED", "The protected role-change request could not be created.");
  }
}
