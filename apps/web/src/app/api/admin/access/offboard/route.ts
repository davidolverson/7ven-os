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

const identityAttemptLeaseMinutes = 5;

interface PersonAccessRow extends QueryResultRow {
  id: string;
  auth_user_id: string;
  display_name: string;
  membership_status: string;
  active: boolean;
}

interface IdRow extends QueryResultRow {
  id: string;
}

interface ExternalIdentityRow extends QueryResultRow {
  id: string;
  provider: string;
}

interface OffboardingExecutionRow extends QueryResultRow {
  id: string;
  person_id: string;
  requested_by: string;
  decision_ref: string;
  reason: string;
  state: "org_disabled" | "identity_in_progress" | "identity_failed" | "complete";
  correlation_id: string;
  identity_error_code: string | null;
  identity_attempt_token: string | null;
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

async function enqueueDisconnectProjections(
  client: import("pg").PoolClient,
  externalIdentities: readonly ExternalIdentityRow[],
) {
  const jobIds: string[] = [];

  for (const identity of externalIdentities) {
    const inserted = await client.query<IdRow>(
      `INSERT INTO app.projection_job (
         provider, entity_type, entity_id, desired_state, status, next_attempt_at
       ) VALUES ($1, 'external_identity', $2, $3::jsonb, 'pending', now())
       RETURNING id`,
      [identity.provider, identity.id, JSON.stringify({ connected: false, reason: "offboarding" })],
    );
    const job = inserted.rows[0];
    if (!job) throw new Error("Projection disconnect insert did not return a row.");
    jobIds.push(job.id);
  }

  return jobIds;
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

    // Phase 1 is the fail-closed security boundary. It removes all currently modeled Org
    // authority before any call into the separately governed identity domain.
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
                identity_error_code, identity_attempt_token, attempt_count, org_disabled_at,
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
                  identity_error_code, identity_attempt_token, attempt_count, org_disabled_at,
                  last_identity_attempt_at, identity_completed_at
             FROM app.offboarding_execution
            WHERE person_id = $1 AND state IN ('org_disabled', 'identity_in_progress', 'identity_failed')
            LIMIT 1
            FOR UPDATE`,
          [target.id],
        );
        if (otherIncomplete.rows[0]) {
          return { kind: "decision_conflict" as const, execution: otherIncomplete.rows[0] };
        }
      }

      const revokedRoles = await client.query<IdRow>(
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

      const endedRosters = await client.query<IdRow>(
        `UPDATE app.roster_membership
            SET roster_state = 'inactive',
                ended_at = now()
          WHERE person_id = $1
            AND ended_at IS NULL
          RETURNING id`,
        [target.id],
      );

      const disconnectedIdentities = await client.query<ExternalIdentityRow>(
        `UPDATE app.external_identity
            SET disconnected_at = now()
          WHERE person_id = $1
            AND disconnected_at IS NULL
          RETURNING id, provider`,
        [target.id],
      );
      const projectionJobIds = await enqueueDisconnectProjections(client, disconnectedIdentities.rows);

      const wasActive = target.active;
      const previousMembershipStatus = target.membership_status;
      await client.query(
        `UPDATE app.person_profile
            SET active = false,
                membership_status = 'inactive',
                updated_at = CASE WHEN active OR membership_status <> 'inactive' THEN now() ELSE updated_at END
          WHERE id = $1`,
        [target.id],
      );

      if (!execution) {
        const inserted = await client.query<OffboardingExecutionRow>(
          `INSERT INTO app.offboarding_execution (
             person_id, requested_by, decision_ref, reason, state, correlation_id, org_disabled_at
           ) VALUES ($1, $2, $3, $4, 'org_disabled', $5, now())
           RETURNING id, person_id, requested_by, decision_ref, reason, state, correlation_id,
                     identity_error_code, identity_attempt_token, attempt_count, org_disabled_at,
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
              endedRosterMembershipIds: endedRosters.rows.map((row) => row.id),
              disconnectedExternalIdentityIds: disconnectedIdentities.rows.map((row) => row.id),
              projectionJobIds,
              identityState: "pending",
              offboardingExecutionId: execution.id,
            },
            reason: parsed.data.reason,
            correlationId: execution.correlation_id,
            metadata: {
              decisionRef: parsed.data.decisionRef,
              revokedRoleCount: revokedRoles.rowCount,
              endedRosterCount: endedRosters.rowCount,
              disconnectedIdentityCount: disconnectedIdentities.rowCount,
              projectionJobCount: projectionJobIds.length,
            },
          },
          client,
        );
      } else if (
        revokedRoles.rowCount > 0 ||
        endedRosters.rowCount > 0 ||
        disconnectedIdentities.rowCount > 0
      ) {
        await writeAuditEvent(
          {
            actorPersonId: principal.personId,
            domain: "identity",
            action: "organizational_access.offboarding_reasserted",
            targetType: "person_profile",
            targetId: target.id,
            afterState: {
              active: false,
              membershipStatus: "inactive",
              revokedRoleIds: revokedRoles.rows.map((row) => row.id),
              endedRosterMembershipIds: endedRosters.rows.map((row) => row.id),
              disconnectedExternalIdentityIds: disconnectedIdentities.rows.map((row) => row.id),
              projectionJobIds,
              offboardingExecutionId: execution.id,
            },
            reason: parsed.data.reason,
            correlationId: execution.correlation_id,
            metadata: { decisionRef: parsed.data.decisionRef },
          },
          client,
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
    const identityAttemptToken = randomUUID();

    // Phase 2 is a fenced claim. Only one request may perform identity cleanup at a time.
    // A stale claim may be recovered after the lease, but its old token can no longer
    // finalize state, which prevents duplicate success/failure evidence.
    const claim = await transaction(async (client) => {
      const claimed = await client.query<OffboardingExecutionRow>(
        `UPDATE app.offboarding_execution
            SET state = 'identity_in_progress',
                identity_error_code = NULL,
                identity_attempt_token = $2,
                attempt_count = attempt_count + 1,
                last_identity_attempt_at = now(),
                updated_at = now()
          WHERE id = $1
            AND (
              state IN ('org_disabled', 'identity_failed')
              OR (
                state = 'identity_in_progress'
                AND last_identity_attempt_at < now() - ($3::text || ' minutes')::interval
              )
            )
          RETURNING id, person_id, requested_by, decision_ref, reason, state, correlation_id,
                    identity_error_code, identity_attempt_token, attempt_count, org_disabled_at,
                    last_identity_attempt_at, identity_completed_at`,
        [execution.id, identityAttemptToken, identityAttemptLeaseMinutes],
      );
      if (claimed.rows[0]) return { kind: "claimed" as const, execution: claimed.rows[0] };

      const current = await client.query<OffboardingExecutionRow>(
        `SELECT id, person_id, requested_by, decision_ref, reason, state, correlation_id,
                identity_error_code, identity_attempt_token, attempt_count, org_disabled_at,
                last_identity_attempt_at, identity_completed_at
           FROM app.offboarding_execution
          WHERE id = $1`,
        [execution.id],
      );
      const currentExecution = current.rows[0];
      if (!currentExecution) throw new Error("Offboarding execution disappeared before identity claim.");
      return { kind: "busy" as const, execution: currentExecution };
    });

    if (claim.kind === "busy") {
      if (claim.execution.state === "complete") {
        return NextResponse.json(
          {
            ok: true,
            replay: true,
            targetPersonId: target.id,
            executionId: claim.execution.id,
            state: "complete",
            orgAccessDisabled: true,
            identityAccessDisabled: true,
          },
          { status: 200, headers: { "Cache-Control": "no-store" } },
        );
      }

      return NextResponse.json(
        {
          error: {
            code: "IDENTITY_REVOCATION_IN_PROGRESS",
            message: "Organizational access is disabled and identity cleanup is already in progress.",
          },
          executionId: claim.execution.id,
          orgAccessDisabled: true,
          identityRevocationPending: true,
          retryable: true,
        },
        { status: 409, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
      );
    }

    try {
      // Demote first so a later ban failure cannot leave identity-admin authority available.
      // Better Auth 1.7.1 banUser then disables future sign-in and revokes existing sessions.
      await auth.api.setRole({
        headers: requestHeaders,
        body: { userId: target.auth_user_id, role: "user" },
      });
      await auth.api.banUser({
        headers: requestHeaders,
        body: {
          userId: target.auth_user_id,
          banReason: "Organizational access offboarding",
        },
      });
    } catch (error) {
      const errorCode = sanitizedIdentityErrorCode(error);

      const failureRecorded = await transaction(async (client) => {
        const updated = await client.query<IdRow>(
          `UPDATE app.offboarding_execution
              SET state = 'identity_failed',
                  identity_error_code = $3,
                  identity_attempt_token = NULL,
                  identity_completed_at = NULL,
                  updated_at = now()
            WHERE id = $1
              AND state = 'identity_in_progress'
              AND identity_attempt_token = $2
            RETURNING id`,
          [execution.id, identityAttemptToken, errorCode],
        );
        if (!updated.rows[0]) return false;

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
        return true;
      });

      if (!failureRecorded) {
        return NextResponse.json(
          {
            error: {
              code: "OFFBOARDING_ATTEMPT_SUPERSEDED",
              message: "Organizational access remains disabled, but this identity cleanup attempt was superseded by a newer attempt.",
            },
            executionId: execution.id,
            orgAccessDisabled: true,
            identityRevocationPending: true,
            retryable: true,
          },
          { status: 409, headers: { "Cache-Control": "no-store" } },
        );
      }

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

    const completed = await transaction(async (client) => {
      const updated = await client.query<IdRow>(
        `UPDATE app.offboarding_execution
            SET state = 'complete',
                identity_error_code = NULL,
                identity_attempt_token = NULL,
                identity_completed_at = now(),
                updated_at = now()
          WHERE id = $1
            AND state = 'identity_in_progress'
            AND identity_attempt_token = $2
          RETURNING id`,
        [execution.id, identityAttemptToken],
      );
      if (!updated.rows[0]) return false;

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
      return true;
    });

    if (!completed) {
      return NextResponse.json(
        {
          error: {
            code: "OFFBOARDING_ATTEMPT_SUPERSEDED",
            message: "Organizational access remains disabled, but this identity cleanup attempt was superseded by a newer attempt.",
          },
          executionId: execution.id,
          orgAccessDisabled: true,
          identityRevocationPending: true,
          retryable: true,
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

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
