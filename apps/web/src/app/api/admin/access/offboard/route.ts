import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { query, transaction } from "@/lib/db";
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
  role_key: string;
  scope_type: string;
  scope_id: string | null;
  revoked_at: Date;
}

function hasIdentityAdminRole(value: unknown) {
  if (typeof value !== "string") return false;
  return value
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean)
    .includes("admin");
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

  const correlationId = randomUUID();

  try {
    const principal = await requirePermission("roles:manage", { type: "organization" });

    if (principal.personId === parsed.data.targetPersonId) {
      return jsonError(409, "SELF_OFFBOARD_NOT_ALLOWED", "A privileged operator cannot offboard their own access through this endpoint.");
    }

    const requestHeaders = request.headers;
    const identitySession = await auth.api.getSession({ headers: requestHeaders });
    const identityUser = identitySession?.user as (typeof identitySession.user & { role?: string | null }) | undefined;

    if (!identitySession || identitySession.user.id !== principal.authUserId || !hasIdentityAdminRole(identityUser?.role)) {
      return jsonError(
        403,
        "IDENTITY_ADMIN_REQUIRED",
        "Offboarding requires identity-administration authority in addition to Org access-management authority.",
      );
    }

    const targetLookup = await query<PersonAccessRow>(
      `SELECT id, auth_user_id, display_name, membership_status, active
         FROM app.person_profile
        WHERE id = $1
        LIMIT 1`,
      [parsed.data.targetPersonId],
    );
    const target = targetLookup.rows[0];
    if (!target) {
      return jsonError(404, "PERSON_NOT_FOUND", "The target person was not found.");
    }

    try {
      // Normalize the target back to the non-admin Better Auth role before ending sessions.
      // This prevents a later credential sign-in from regaining identity-admin authority.
      await auth.api.setRole({
        headers: requestHeaders,
        body: { userId: target.auth_user_id, role: "user" },
      });
      await auth.api.revokeUserSessions({
        headers: requestHeaders,
        body: { userId: target.auth_user_id },
      });
    } catch (error) {
      console.error("identity offboarding failed", { correlationId, targetPersonId: target.id, error });
      return jsonError(502, "IDENTITY_REVOCATION_FAILED", "Identity access could not be fully revoked. No Org deactivation was assumed complete.");
    }

    const result = await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`offboard:${target.id}`]);

      const selected = await client.query<PersonAccessRow>(
        `SELECT id, auth_user_id, display_name, membership_status, active
           FROM app.person_profile
          WHERE id = $1
          FOR UPDATE`,
        [target.id],
      );
      const lockedTarget = selected.rows[0];
      if (!lockedTarget) return { kind: "missing" as const };

      const revokedRoles = await client.query<RevokedRoleRow>(
        `UPDATE app.role_assignment
            SET revoked_at = now(),
                revoked_by = $2,
                revocation_reason = $3
          WHERE person_id = $1
            AND revoked_at IS NULL
            AND (ends_at IS NULL OR ends_at > now())
          RETURNING id, role_key, scope_type, scope_id, revoked_at`,
        [lockedTarget.id, principal.personId, parsed.data.reason],
      );

      const wasActive = lockedTarget.active;
      const beforeMembershipStatus = lockedTarget.membership_status;

      if (lockedTarget.active || lockedTarget.membership_status !== "inactive") {
        await client.query(
          `UPDATE app.person_profile
              SET active = false,
                  membership_status = 'inactive',
                  updated_at = now()
            WHERE id = $1`,
          [lockedTarget.id],
        );
      }

      if (!wasActive && beforeMembershipStatus === "inactive" && revokedRoles.rowCount === 0) {
        return { kind: "replay" as const, revokedRoleIds: [] as string[] };
      }

      const revokedRoleIds = revokedRoles.rows.map((role) => role.id);
      await writeAuditEvent(
        {
          actorPersonId: principal.personId,
          domain: "identity",
          action: "organizational_access.offboarded",
          targetType: "person_profile",
          targetId: lockedTarget.id,
          beforeState: {
            active: wasActive,
            membershipStatus: beforeMembershipStatus,
          },
          afterState: {
            active: false,
            membershipStatus: "inactive",
            identityRole: "user",
            sessionsRevoked: true,
            revokedRoleIds,
          },
          reason: parsed.data.reason,
          correlationId,
          metadata: {
            decisionRef: parsed.data.decisionRef,
            revokedRoleCount: revokedRoleIds.length,
          },
        },
        client,
      );

      return { kind: "offboarded" as const, revokedRoleIds };
    });

    if (result.kind === "missing") {
      return jsonError(404, "PERSON_NOT_FOUND", "The target person was not found during offboarding.");
    }

    return NextResponse.json(
      {
        ok: true,
        replay: result.kind === "replay",
        targetPersonId: target.id,
        revokedRoleCount: result.revokedRoleIds.length,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;

    console.error("organizational offboarding failed", { correlationId, error });
    return jsonError(500, "OFFBOARD_FAILED", "Organizational access could not be offboarded.");
  }
}
