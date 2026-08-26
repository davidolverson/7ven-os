import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/access";
import { roleRequiresGovernanceApproval, type RoleKey, type ScopeType } from "@/lib/authorization-model";
import { writeAuditEvent } from "@/lib/audit";
import { transaction } from "@/lib/db";
import { accessErrorResponse, jsonError, requestIsSameOrigin } from "@/lib/request-security";

const revokeSchema = z.object({ reason: z.string().trim().min(10).max(500) });

interface AssignmentRow extends QueryResultRow {
  id: string;
  person_id: string;
  role_key: RoleKey;
  scope_type: ScopeType;
  scope_id: string | null;
  starts_at: Date;
  ends_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revocation_reason: string | null;
}

function assignmentScope(assignment: AssignmentRow) {
  if (assignment.scope_type === "organization") return { type: "organization" as const };
  if (!assignment.scope_id) throw new Error("Scoped role assignment is missing a scope ID.");
  return { type: assignment.scope_type, id: assignment.scope_id };
}

function hasActiveBreakGlass(roles: readonly { role_key: RoleKey }[]) {
  return roles.some((role) => role.role_key === "break_glass");
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!requestIsSameOrigin(request)) {
    return jsonError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.");
  }

  const { id } = await context.params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return jsonError(404, "ROLE_ASSIGNMENT_NOT_FOUND", "The role assignment was not found.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "A revocation reason is required.", fields: parsed.error.flatten().fieldErrors } },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  const correlationId = randomUUID();

  try {
    const result = await transaction(async (client) => {
      const selected = await client.query<AssignmentRow>(
        `SELECT id, person_id, role_key, scope_type, scope_id, starts_at, ends_at,
                revoked_at, revoked_by, revocation_reason
           FROM app.role_assignment
          WHERE id = $1
          FOR UPDATE`,
        [parsedId.data],
      );
      const assignment = selected.rows[0];
      if (!assignment) return { kind: "missing" as const };

      const principal = await requirePermission("roles:manage", assignmentScope(assignment));
      const breakGlass = hasActiveBreakGlass(principal.roles);

      if (assignment.role_key === "break_glass" && !breakGlass) {
        return { kind: "break_glass_forbidden" as const };
      }
      if (roleRequiresGovernanceApproval(assignment.role_key) && !breakGlass) {
        return { kind: "governance_forbidden" as const };
      }
      if (assignment.revoked_at) {
        return { kind: "already_revoked" as const, assignment };
      }
      if (assignment.ends_at && assignment.ends_at.getTime() <= Date.now()) {
        return { kind: "already_ended" as const, assignment };
      }

      const updated = await client.query<AssignmentRow>(
        `UPDATE app.role_assignment
            SET revoked_at = now(), revoked_by = $2, revocation_reason = $3
          WHERE id = $1
          RETURNING id, person_id, role_key, scope_type, scope_id, starts_at, ends_at,
                    revoked_at, revoked_by, revocation_reason`,
        [assignment.id, principal.personId, parsed.data.reason],
      );
      const revoked = updated.rows[0];
      if (!revoked) throw new Error("Role revocation update did not return a row.");

      await writeAuditEvent(
        {
          actorPersonId: principal.personId,
          domain: "authorization",
          action: "role.revoked",
          targetType: "role_assignment",
          targetId: revoked.id,
          beforeState: {
            personId: assignment.person_id,
            roleKey: assignment.role_key,
            scopeType: assignment.scope_type,
            scopeId: assignment.scope_id,
            startsAt: assignment.starts_at.toISOString(),
            endsAt: assignment.ends_at?.toISOString() ?? null,
            revokedAt: null,
          },
          afterState: {
            personId: revoked.person_id,
            roleKey: revoked.role_key,
            scopeType: revoked.scope_type,
            scopeId: revoked.scope_id,
            startsAt: revoked.starts_at.toISOString(),
            endsAt: revoked.ends_at?.toISOString() ?? null,
            revokedAt: revoked.revoked_at?.toISOString() ?? null,
            revokedBy: revoked.revoked_by,
          },
          reason: parsed.data.reason,
          correlationId,
        },
        client,
      );

      return { kind: "revoked" as const, assignment: revoked };
    });

    if (result.kind === "missing") return jsonError(404, "ROLE_ASSIGNMENT_NOT_FOUND", "The role assignment was not found.");
    if (result.kind === "break_glass_forbidden") return jsonError(403, "BREAK_GLASS_REQUIRES_BREAK_GLASS", "Only an active break-glass principal may revoke break-glass access.");
    if (result.kind === "governance_forbidden") {
      return jsonError(403, "GOVERNANCE_APPROVAL_REQUIRED", "This sensitive or governance role cannot be revoked through direct technical access management.");
    }

    return NextResponse.json(
      {
        ok: true,
        roleAssignmentId: result.assignment.id,
        replay: result.kind === "already_revoked" || result.kind === "already_ended",
        state: result.kind === "already_ended" ? "ended" : "revoked",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;
    console.error("role revocation failed", { correlationId, error });
    return jsonError(500, "ROLE_REVOKE_FAILED", "The role assignment could not be revoked.");
  }
}
