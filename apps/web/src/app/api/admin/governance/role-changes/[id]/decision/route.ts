import type { QueryResultRow } from "pg";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/access";
import { roleRequiresGovernanceApproval, type RoleKey, type ScopeType } from "@/lib/authorization-model";
import { writeAuditEvent } from "@/lib/audit";
import { query, transaction } from "@/lib/db";
import { accessErrorResponse, jsonError, requestIsSameOrigin } from "@/lib/request-security";

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(10).max(500),
});

interface RoleChangeRow extends QueryResultRow {
  id: string;
  operation: "grant" | "revoke";
  target_person_id: string;
  target_assignment_id: string | null;
  role_key: RoleKey;
  scope_type: ScopeType;
  scope_id: string | null;
  requested_ends_at: Date | null;
  requested_by: string;
  request_reason: string;
  state: "pending" | "executed" | "rejected" | "cancelled";
  reviewed_by: string | null;
  review_reason: string | null;
  reviewed_at: Date | null;
  result_assignment_id: string | null;
  executed_at: Date | null;
  correlation_id: string;
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
  revoked_by: string | null;
  revocation_reason: string | null;
}

interface PersonRow extends QueryResultRow {
  id: string;
  active: boolean;
}

function permissionScope(scopeType: ScopeType, scopeId: string | null) {
  if (scopeType === "organization") return { type: "organization" as const };
  if (!scopeId) throw new Error("Scoped governance request is missing a scope ID.");
  return { type: scopeType, id: scopeId };
}

function hasActiveBreakGlass(roles: readonly { role_key: RoleKey }[]) {
  return roles.some((role) => role.role_key === "break_glass");
}

function roleState(assignment: AssignmentRow) {
  return {
    personId: assignment.person_id,
    roleKey: assignment.role_key,
    scopeType: assignment.scope_type,
    scopeId: assignment.scope_id,
    startsAt: assignment.starts_at.toISOString(),
    endsAt: assignment.ends_at?.toISOString() ?? null,
    revokedAt: assignment.revoked_at?.toISOString() ?? null,
    revokedBy: assignment.revoked_by,
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!requestIsSameOrigin(request)) {
    return jsonError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.");
  }

  const { id } = await context.params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return jsonError(404, "ROLE_CHANGE_REQUEST_NOT_FOUND", "The protected role-change request was not found.");
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return jsonError(413, "PAYLOAD_TOO_LARGE", "Governance decision payload is too large.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "The governance decision is invalid.",
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const snapshotResult = await query<RoleChangeRow>(
      `SELECT id, operation, target_person_id, target_assignment_id, role_key, scope_type, scope_id,
              requested_ends_at, requested_by, request_reason, state, reviewed_by, review_reason,
              reviewed_at, result_assignment_id, executed_at, correlation_id
         FROM app.role_change_request
        WHERE id = $1
        LIMIT 1`,
      [parsedId.data],
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) {
      return jsonError(404, "ROLE_CHANGE_REQUEST_NOT_FOUND", "The protected role-change request was not found.");
    }
    if (snapshot.state !== "pending") {
      return jsonError(409, "ROLE_CHANGE_ALREADY_DECIDED", "This protected role-change request is no longer pending.");
    }

    const principal = await requirePermission("governance:approve", permissionScope(snapshot.scope_type, snapshot.scope_id));

    if (hasActiveBreakGlass(principal.roles)) {
      return jsonError(403, "BREAK_GLASS_NOT_NORMAL_GOVERNANCE", "Break-glass access cannot be used as a normal governance approver.");
    }
    if (principal.personId === snapshot.requested_by) {
      return jsonError(409, "REQUESTER_CANNOT_REVIEW", "The requester cannot approve or reject their own protected role-change request.");
    }
    if (parsed.data.decision === "approve" && snapshot.operation === "grant" && principal.personId === snapshot.target_person_id) {
      return jsonError(409, "SELF_ELEVATION_NOT_ALLOWED", "A Council approver cannot approve their own protected-role elevation.");
    }

    const result = await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`role-change-decision|${snapshot.id}`]);

      const lockedResult = await client.query<RoleChangeRow>(
        `SELECT id, operation, target_person_id, target_assignment_id, role_key, scope_type, scope_id,
                requested_ends_at, requested_by, request_reason, state, reviewed_by, review_reason,
                reviewed_at, result_assignment_id, executed_at, correlation_id
           FROM app.role_change_request
          WHERE id = $1
          FOR UPDATE`,
        [snapshot.id],
      );
      const governanceRequest = lockedResult.rows[0];
      if (!governanceRequest) return { kind: "missing" as const };
      if (governanceRequest.state !== "pending") return { kind: "already_decided" as const };

      if (parsed.data.decision === "reject") {
        await client.query(
          `UPDATE app.role_change_request
              SET state = 'rejected',
                  reviewed_by = $2,
                  review_reason = $3,
                  reviewed_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [governanceRequest.id, principal.personId, parsed.data.reason],
        );

        await writeAuditEvent(
          {
            actorPersonId: principal.personId,
            domain: "governance",
            action: "role_change.rejected",
            targetType: "role_change_request",
            targetId: governanceRequest.id,
            beforeState: { state: "pending" },
            afterState: { state: "rejected" },
            reason: parsed.data.reason,
            correlationId: governanceRequest.correlation_id,
            metadata: {
              operation: governanceRequest.operation,
              roleKey: governanceRequest.role_key,
              targetPersonId: governanceRequest.target_person_id,
            },
          },
          client,
        );

        return { kind: "rejected" as const };
      }

      if (!roleRequiresGovernanceApproval(governanceRequest.role_key)) {
        return { kind: "integrity_error" as const };
      }

      let resultingAssignment: AssignmentRow;

      if (governanceRequest.operation === "grant") {
        const personResult = await client.query<PersonRow>(
          `SELECT id, active
             FROM app.person_profile
            WHERE id = $1
            FOR UPDATE`,
          [governanceRequest.target_person_id],
        );
        const person = personResult.rows[0];
        if (!person || !person.active) return { kind: "person_missing" as const };

        const roleLockKey = `${governanceRequest.target_person_id}|${governanceRequest.role_key}|${governanceRequest.scope_type}|${governanceRequest.scope_id ?? "organization"}`;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [roleLockKey]);

        const overlap = await client.query<AssignmentRow>(
          `SELECT id, person_id, role_key, scope_type, scope_id, starts_at, ends_at,
                  revoked_at, revoked_by, revocation_reason
             FROM app.role_assignment
            WHERE person_id = $1
              AND role_key = $2
              AND scope_type = $3
              AND scope_id IS NOT DISTINCT FROM $4::uuid
              AND revoked_at IS NULL
              AND tstzrange(starts_at, COALESCE(ends_at, 'infinity'::timestamptz), '[)')
                  && tstzrange(now(), COALESCE($5::timestamptz, 'infinity'::timestamptz), '[)')
            LIMIT 1`,
          [
            governanceRequest.target_person_id,
            governanceRequest.role_key,
            governanceRequest.scope_type,
            governanceRequest.scope_id,
            governanceRequest.requested_ends_at,
          ],
        );
        if (overlap.rows[0]) return { kind: "role_conflict" as const };

        const inserted = await client.query<AssignmentRow>(
          `INSERT INTO app.role_assignment (
             person_id, role_key, scope_type, scope_id, granted_by, reason, starts_at, ends_at
           ) VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
           RETURNING id, person_id, role_key, scope_type, scope_id, starts_at, ends_at,
                     revoked_at, revoked_by, revocation_reason`,
          [
            governanceRequest.target_person_id,
            governanceRequest.role_key,
            governanceRequest.scope_type,
            governanceRequest.scope_id,
            principal.personId,
            governanceRequest.request_reason,
            governanceRequest.requested_ends_at,
          ],
        );
        const assignment = inserted.rows[0];
        if (!assignment) throw new Error("Governed protected-role grant did not return a role assignment.");
        resultingAssignment = assignment;

        await writeAuditEvent(
          {
            actorPersonId: principal.personId,
            domain: "authorization",
            action: "role.granted",
            targetType: "role_assignment",
            targetId: assignment.id,
            afterState: roleState(assignment),
            reason: governanceRequest.request_reason,
            correlationId: governanceRequest.correlation_id,
            metadata: { roleChangeRequestId: governanceRequest.id, approvalReason: parsed.data.reason },
          },
          client,
        );
      } else {
        if (!governanceRequest.target_assignment_id) return { kind: "integrity_error" as const };

        const assignmentResult = await client.query<AssignmentRow>(
          `SELECT id, person_id, role_key, scope_type, scope_id, starts_at, ends_at,
                  revoked_at, revoked_by, revocation_reason
             FROM app.role_assignment
            WHERE id = $1
            FOR UPDATE`,
          [governanceRequest.target_assignment_id],
        );
        const assignment = assignmentResult.rows[0];
        if (!assignment) return { kind: "assignment_missing" as const };
        if (
          assignment.person_id !== governanceRequest.target_person_id ||
          assignment.role_key !== governanceRequest.role_key ||
          assignment.scope_type !== governanceRequest.scope_type ||
          assignment.scope_id !== governanceRequest.scope_id
        ) {
          return { kind: "integrity_error" as const };
        }
        if (assignment.revoked_at || (assignment.ends_at && assignment.ends_at.getTime() <= Date.now())) {
          return { kind: "role_not_active" as const };
        }

        const updated = await client.query<AssignmentRow>(
          `UPDATE app.role_assignment
              SET revoked_at = now(), revoked_by = $2, revocation_reason = $3
            WHERE id = $1
            RETURNING id, person_id, role_key, scope_type, scope_id, starts_at, ends_at,
                      revoked_at, revoked_by, revocation_reason`,
          [assignment.id, principal.personId, governanceRequest.request_reason],
        );
        const revoked = updated.rows[0];
        if (!revoked) throw new Error("Governed protected-role revocation did not return a role assignment.");
        resultingAssignment = revoked;

        await writeAuditEvent(
          {
            actorPersonId: principal.personId,
            domain: "authorization",
            action: "role.revoked",
            targetType: "role_assignment",
            targetId: revoked.id,
            beforeState: roleState(assignment),
            afterState: roleState(revoked),
            reason: governanceRequest.request_reason,
            correlationId: governanceRequest.correlation_id,
            metadata: { roleChangeRequestId: governanceRequest.id, approvalReason: parsed.data.reason },
          },
          client,
        );
      }

      await client.query(
        `UPDATE app.role_change_request
            SET state = 'executed',
                reviewed_by = $2,
                review_reason = $3,
                reviewed_at = now(),
                result_assignment_id = $4,
                executed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [governanceRequest.id, principal.personId, parsed.data.reason, resultingAssignment.id],
      );

      await writeAuditEvent(
        {
          actorPersonId: principal.personId,
          domain: "governance",
          action: "role_change.executed",
          targetType: "role_change_request",
          targetId: governanceRequest.id,
          beforeState: { state: "pending" },
          afterState: {
            state: "executed",
            operation: governanceRequest.operation,
            roleAssignmentId: resultingAssignment.id,
          },
          reason: parsed.data.reason,
          correlationId: governanceRequest.correlation_id,
          metadata: {
            roleKey: governanceRequest.role_key,
            targetPersonId: governanceRequest.target_person_id,
          },
        },
        client,
      );

      return { kind: "executed" as const, assignment: resultingAssignment };
    });

    if (result.kind === "missing") {
      return jsonError(404, "ROLE_CHANGE_REQUEST_NOT_FOUND", "The protected role-change request was not found.");
    }
    if (result.kind === "already_decided") {
      return jsonError(409, "ROLE_CHANGE_ALREADY_DECIDED", "This protected role-change request is no longer pending.");
    }
    if (result.kind === "person_missing") {
      return jsonError(409, "TARGET_NOT_ACTIVE", "The target person no longer exists or is inactive. The request remains pending for review.");
    }
    if (result.kind === "role_conflict") {
      return jsonError(409, "ROLE_ALREADY_ACTIVE", "An overlapping protected role is already active. The request remains pending for review.");
    }
    if (result.kind === "assignment_missing") {
      return jsonError(409, "ROLE_ASSIGNMENT_NOT_FOUND", "The protected role assignment no longer exists. The request remains pending for review.");
    }
    if (result.kind === "role_not_active") {
      return jsonError(409, "ROLE_NOT_ACTIVE", "The protected role assignment is already revoked or ended. The request remains pending for review.");
    }
    if (result.kind === "integrity_error") {
      return jsonError(409, "GOVERNANCE_REQUEST_INTEGRITY_ERROR", "The protected role-change request no longer matches the governed role state.");
    }
    if (result.kind === "rejected") {
      return NextResponse.json(
        { ok: true, roleChangeRequestId: snapshot.id, state: "rejected" },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        roleChangeRequestId: snapshot.id,
        roleAssignmentId: result.assignment.id,
        state: "executed",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;

    console.error("protected role governance decision failed", { roleChangeRequestId: parsedId.data, error });
    return jsonError(500, "ROLE_CHANGE_DECISION_FAILED", "The governance decision could not be completed.");
  }
}
