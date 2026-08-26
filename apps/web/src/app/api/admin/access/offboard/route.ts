import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { transaction } from "@/lib/db";
import { accessErrorResponse, jsonError, requestIsSameOrigin } from "@/lib/request-security";

const offboardSchema = z.object({
  targetPersonId: z.string().uuid(),
  decisionRef: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(10).max(500),
});

interface PersonAccessRow extends QueryResultRow {
  id: string;
  auth_user_id: string;
  display_name: string;
  membership_status: string;
  active: boolean;
}

interface RevokedRoleRow extends QueryResultRow {
  id: string;
}

interface OffboardingExecutionRow extends QueryResultRow {
  id: string;
  person_id: string;
  requested_by: string;
  decision_ref: string;
  reason: string;
  state: "org_disabled" | "identity_failed" | "complete";
  correlation_id: string;
  identity_error_code: string | null;
  attempt_count: number;
  org_disabled_at: Date;
  last_identity_attempt_at: Date | null;
  identity_completed_at: Date | null;
}

function hasIdentityAdminRole(value: unknown) {
  if (typeof value !== "string") return false;
  return value
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean)
    .includes("admin");
}

function sanitizedIdentityErrorCode(error: unknown) {
  if (error instanceof Error && error.name) return error.name.slice(0, 120);
  return "IDENTITY_PROVIDER_ERROR";
}

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return jsonError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.");
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return jsonError(413, "PAYLOAD_TOO_LARGE", "Offboarding payload is too large.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  const parsed = offboardSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "The offboarding request is invalid.",
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  const requestCorrelationId = randomUUID();

  try {
    const principal = await requirePermission("roles:manage", { type: "organization" });

    if (principal.personId === parsed.data.targetPersonId) {
      return jsonError(409, "SELF_OFFBOARD_NOT_ALLOWED", "A privileged operator cannot offboard their own access through this endpoint.");
    }

    const requestHeaders = request.headers;
    const identitySession = await auth.api.getSession({ headers: requestHeaders });
    if (!identitySession) {
      return jsonError(
        403,
        "IDENTITY_ADMIN_REQUIRED",
        "Offboarding requires identity-administration authority in addition to Org access-management authority.",
      );
    }

    const identityUser = identitySession.user as typeof identitySession.user & { role?: string | null };
    if (identitySession.user.id !== principal.authUserId || !hasIdentityAdminRole(identityUser.role)) {
      return jsonError(
        403,
        "IDENTITY_ADMIN_REQUIRED",
        "Offboarding requires identity-administration authority in addition to Org access-management authority.",
      );
    }

    // Phase 1 is the security boundary: Org access is disabled transactionally before any
    // external identity-provider call. Once this commits, later failures are not allowed
    // to reactivate the person or restore role history.
    const phaseOne = await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`offboard:${parsed.data.targetPersonId}`]);

      const selected = await client.query<PersonAccessRow>(
        `SELECT id, auth_user_id, display_name, membership_status, active
           FROM app.person_profile
          WHERE id = $1
          FOR UPDATE`,
        [parsed.data.targetPersonId],
      );
      const target = selected.rows[0];
      if (!target) return { kind: "missing" as const };

      const sameDecision = await client.query<OffboardingExecutionRow>(
        `SELECT id, person_id, requested_by, decision_ref, reason, state, correlation_id,
                identity_error_code, attempt_count, org_disabled_at,
                last_identity_attempt_at, identity_completed_at
           FROM app.offboarding_execution
          WHERE person_id = $1 AND decision_ref = $2
          FOR UPDATE`,
        [target.id, parsed.data.decisionRef],
      );
      let execution = sameDecision.rows[0];

      if (!execution) {
        const otherIncomplete = await client.query<OffboardingExecutionRow>(
          `SELECT id, person_id, requested_by, decision_ref, reason, state, correlation_id,
                  identity_error_code, attempt_count, org_disabled_at,
                  last_identity_attempt_at, identity_completed_at
             FROM app.offboarding_execution
            WHERE person_id = $1 AND state IN ('org_disabled', 'identity_failed')
            LIMIT 1
            FOR UPDATE`,
          [target.id],
        );
        if (otherIncomplete.rows[0]) {
          return { kind: "decision_conflict" as const, execution: otherIncomplete.rows[0] };
        }

        const revokedRoles = await client.query<RevokedRoleRow>(
          `UPDATE app.role_assignment
              SET revoked_at = now(),
                  revoked_by = $2,
                  revocation_reason = $3
            WHERE person_id = $1
              AND revoked_at IS NULL
              AND (ends_at IS NULL OR ends_at > now())
            RETURNING id`,
          [target.id, principal.personId, parsed.data.reason],
        );

        const wasActive = target.active;
        const previousMembershipStatus = target.membership_status;

        await client.query(
          `UPDATE app.person_profile
              SET active = false,
                  membership_status = 'inactive',
                  updated_at = now()
            WHERE id = $1`,
          [target.id],
        );

        const inserted = await client.query<OffboardingExecutionRow>(
          `INSERT INTO app.offboarding_execution (
             person_id, requested_by, decision_ref, reason, state, correlation_id, org_disabled_at
           ) VALUES ($1, $2, $3, $4, 'org_disabled', $5, now())
           RETURNING id, person_id, requested_by, decision_ref, reason, state, correlation_id,
                     identity_error_code, attempt_count, org_disabled_at,
                     last_identity_attempt_at, identity_completed_at`,
          [target.id, principal.personId, parsed.data.decisionRef, parsed.data.reason, requestCorrelationId],
        );
        execution = inserted.rows[0];
        if (!execution) throw new Error("Offboarding execution insert did not return a row.");

        await writeAuditEvent(
          {
            actorPersonId: principal.personId,
            domain: "identity",
            action: "organizational_access.offboarded",
            targetType: "person_profile",
            targetId: target.id,
            beforeState: {
              active: wasActive,
              membershipStatus: previousMembershipStatus,
            },
            afterState: {
              active: false,
              membershipStatus: "inactive",
              revokedRoleIds: revokedRoles.rows.map((row) => row.id),
              identityState: "pending",
              offboardingExecutionId: execution.id,
            },
            reason: parsed.data.reason,
            correlationId: execution.correlation_id,
            metadata: {
              decisionRef: parsed.data.decisionRef,
              revokedRoleCount: revokedRoles.rowCount,
            },
          },
          client,
        );
      } else {
        // Reassert fail-closed Org state on retries. The normal role API already refuses
        // inactive people, but this prevents manual/legacy mutations from reviving access.
        await client.query(
          `UPDATE app.role_assignment
              SET revoked_at = COALESCE(revoked_at, now()),
                  revoked_by = COALESCE(revoked_by, $2),
                  revocation_reason = COALESCE(revocation_reason, $3)
            WHERE person_id = $1
              AND revoked_at IS NULL
              AND (ends_at IS NULL OR ends_at > now())`,
          [target.id, principal.personId, parsed.data.reason],
        );
        await client.query(
          `UPDATE app.person_profile
              SET active = false,
                  membership_status = 'inactive',
                  updated_at = CASE WHEN active OR membership_status <> 'inactive' THEN now() ELSE updated_at END
            WHERE id = $1`,
          [target.id],
        );
      }

      return {
        kind: execution.state === "complete" ? "complete" as const : "ready" as const,
        target,
        execution,
        replay: sameDecision.rows[0] !== undefined,
      };
    });

    if (phaseOne.kind === "missing") {
      return jsonError(404, "PERSON_NOT_FOUND", "The target person was not found.");
    }
    if (phaseOne.kind === "decision_conflict") {
      return NextResponse.json(
        {
          error: {
            code: "OFFBOARDING_ALREADY_IN_PROGRESS",
            message: "A different offboarding decision is already incomplete for this person.",
          },
          executionId: phaseOne.execution.id,
          orgAccessDisabled: true,
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (phaseOne.kind === "complete") {
      return NextResponse.json(
        {
          ok: true,
          replay: true,
          targetPersonId: phaseOne.target.id,
          executionId: phaseOne.execution.id,
          state: "complete",
          orgAccessDisabled: true,
          identityAccessDisabled: true,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    const { target, execution } = phaseOne;

    // Record the attempt before crossing into the separately governed identity domain.
    await transaction(async (client) => {
      await client.query(
        `UPDATE app.offboarding_execution
            SET attempt_count = attempt_count + 1,
                last_identity_attempt_at = now(),
                updated_at = now()
          WHERE id = $1 AND state <> 'complete'`,
        [execution.id],
      );
    });

    try {
      // Better Auth 1.7.1 banUser prevents future sign-in and revokes all existing sessions.
      // Normalize the stored identity role afterward so a future governed unban cannot
      // accidentally restore identity-admin authority.
      await auth.api.banUser({
        headers: requestHeaders,
        body: {
          userId: target.auth_user_id,
          banReason: `Org offboarding decision ${parsed.data.decisionRef}`,
        },
      });
      await auth.api.setRole({
        headers: requestHeaders,
        body: { userId: target.auth_user_id, role: "user" },
      });
    } catch (error) {
      const errorCode = sanitizedIdentityErrorCode(error);

      await transaction(async (client) => {
        await client.query(
          `UPDATE app.offboarding_execution
              SET state = 'identity_failed',
                  identity_error_code = $2,
                  identity_completed_at = NULL,
                  updated_at = now()
            WHERE id = $1`,
          [execution.id, errorCode],
        );

        await writeAuditEvent(
          {
            actorPersonId: principal.personId,
            domain: "identity",
            action: "identity_access.revocation_failed",
            targetType: "person_profile",
            targetId: target.id,
            afterState: {
              orgAccessDisabled: true,
              identityState: "failed",
              offboardingExecutionId: execution.id,
            },
            reason: parsed.data.reason,
            correlationId: execution.correlation_id,
            metadata: {
              decisionRef: parsed.data.decisionRef,
              errorCode,
            },
          },
          client,
        );
      });

      console.error("identity offboarding incomplete", {
        correlationId: execution.correlation_id,
        executionId: execution.id,
        targetPersonId: target.id,
        errorCode,
      });

      return NextResponse.json(
        {
          error: {
            code: "IDENTITY_REVOCATION_PENDING",
            message: "Organizational access is disabled, but identity cleanup did not complete and must be retried.",
          },
          executionId: execution.id,
          orgAccessDisabled: true,
          identityRevocationPending: true,
          retryable: true,
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE app.offboarding_execution
            SET state = 'complete',
                identity_error_code = NULL,
                identity_completed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [execution.id],
      );

      await writeAuditEvent(
        {
          actorPersonId: principal.personId,
          domain: "identity",
          action: "identity_access.revoked",
          targetType: "person_profile",
          targetId: target.id,
          afterState: {
            orgAccessDisabled: true,
            signInDisabled: true,
            sessionsRevoked: true,
            identityRole: "user",
            identityState: "complete",
            offboardingExecutionId: execution.id,
          },
          reason: parsed.data.reason,
          correlationId: execution.correlation_id,
          metadata: { decisionRef: parsed.data.decisionRef },
        },
        client,
      );
    });

    return NextResponse.json(
      {
        ok: true,
        replay: phaseOne.replay,
        targetPersonId: target.id,
        executionId: execution.id,
        state: "complete",
        orgAccessDisabled: true,
        identityAccessDisabled: true,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;

    console.error("organizational offboarding failed", { correlationId: requestCorrelationId, error });
    return jsonError(500, "OFFBOARD_FAILED", "Organizational access could not be offboarded.");
  }
}
