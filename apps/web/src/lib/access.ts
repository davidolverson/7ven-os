import { headers } from "next/headers";
import type { QueryResultRow } from "pg";
import { auth } from "@/lib/auth";
import { query, transaction } from "@/lib/db";
import { env } from "@/lib/env";
import { writeAuditEvent } from "@/lib/audit";
import {
  grantsPermission,
  permissionRequiresStrongAuth,
  type Permission,
  type PermissionScope,
  type RoleGrant,
} from "@/lib/authorization-model";

export type { Permission, PermissionScope, RoleKey, ScopeType } from "@/lib/authorization-model";

interface PersonRow extends QueryResultRow {
  id: string;
  auth_user_id: string;
  display_name: string;
  membership_status: string;
}

interface RoleRow extends QueryResultRow, RoleGrant {}

export interface Principal {
  personId: string;
  authUserId: string;
  email: string;
  displayName: string;
  membershipStatus: string;
  twoFactorEnabled: boolean;
  roles: RoleRow[];
}

export class AccessDeniedError extends Error {
  readonly status = 403;

  constructor(message = "You do not have permission to perform this action.") {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export class AuthenticationRequiredError extends Error {
  readonly status = 401;

  constructor() {
    super("Authentication required.");
    this.name = "AuthenticationRequiredError";
  }
}

async function ensurePersonProfile(authUser: { id: string; name: string; email: string }): Promise<PersonRow> {
  return transaction(async (client) => {
    const existing = await client.query<PersonRow>(
      `SELECT id, auth_user_id, display_name, membership_status
         FROM app.person_profile
        WHERE auth_user_id = $1 AND active = true
        LIMIT 1`,
      [authUser.id],
    );

    if (existing.rows[0]) return existing.rows[0];

    const inserted = await client.query<PersonRow>(
      `INSERT INTO app.person_profile (auth_user_id, display_name, membership_status)
       VALUES ($1, $2, 'community')
       ON CONFLICT (auth_user_id) DO NOTHING
       RETURNING id, auth_user_id, display_name, membership_status`,
      [authUser.id, authUser.name || authUser.email.split("@")[0] || "Member"],
    );

    if (inserted.rows[0]) {
      await writeAuditEvent(
        {
          actorKind: "system",
          domain: "identity",
          action: "person_profile.provisioned",
          targetType: "person_profile",
          targetId: inserted.rows[0].id,
          metadata: { membershipStatus: "community" },
        },
        client,
      );
      return inserted.rows[0];
    }

    const raced = await client.query<PersonRow>(
      `SELECT id, auth_user_id, display_name, membership_status
         FROM app.person_profile
        WHERE auth_user_id = $1 AND active = true
        LIMIT 1`,
      [authUser.id],
    );

    const person = raced.rows[0];
    if (!person) throw new Error("Authenticated user profile could not be provisioned.");
    return person;
  });
}

function matchesBreakGlassPrincipal(authUser: { id: string; email: string }) {
  const configured = env.BREAK_GLASS_PRINCIPAL;
  if (!configured) return false;

  if (configured.startsWith("user:")) {
    return configured.slice("user:".length) === authUser.id;
  }

  if (configured.startsWith("email:")) {
    return configured.slice("email:".length).toLowerCase() === authUser.email.toLowerCase();
  }

  return false;
}

async function ensureOneTimeBreakGlassAssignment(
  person: PersonRow,
  authUser: { id: string; email: string; twoFactorEnabled: boolean },
) {
  if (!authUser.twoFactorEnabled || !matchesBreakGlassPrincipal(authUser)) return;

  await transaction(async (client) => {
    // One global bootstrap claim. Once any break-glass assignment has existed, environment bootstrap never grants it again.
    await client.query("SELECT pg_advisory_xact_lock(713001)");

    const history = await client.query<{ id: string } & QueryResultRow>(
      `SELECT id
         FROM app.role_assignment
        WHERE role_key = 'break_glass'
        LIMIT 1`,
    );

    if (history.rows[0]) return;

    const inserted = await client.query<{ id: string; ends_at: Date } & QueryResultRow>(
      `INSERT INTO app.role_assignment (
         person_id, role_key, scope_type, scope_id, granted_by, reason, starts_at, ends_at
       ) VALUES ($1, 'break_glass', 'organization', NULL, NULL, $2, now(), now() + interval '60 minutes')
       RETURNING id, ends_at`,
      [person.id, "One-time environment break-glass bootstrap. Rotate/remove BREAK_GLASS_PRINCIPAL after administrative recovery."],
    );

    const role = inserted.rows[0];
    if (!role) throw new Error("Break-glass bootstrap insert did not return a role assignment.");

    await writeAuditEvent(
      {
        actorKind: "system",
        domain: "authorization",
        action: "role.break_glass_bootstrapped",
        targetType: "role_assignment",
        targetId: role.id,
        afterState: {
          personId: person.id,
          roleKey: "break_glass",
          scopeType: "organization",
          endsAt: role.ends_at.toISOString(),
        },
        reason: "One-time environment bootstrap after verified 2FA enrollment",
      },
      client,
    );
  });
}

export async function getCurrentPrincipal(): Promise<Principal | null> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });

  if (!session) return null;

  const user = session.user as typeof session.user & { twoFactorEnabled?: boolean };
  const twoFactorEnabled = user.twoFactorEnabled === true;
  const person = await ensurePersonProfile({
    id: user.id,
    name: user.name,
    email: user.email,
  });

  await ensureOneTimeBreakGlassAssignment(person, {
    id: user.id,
    email: user.email,
    twoFactorEnabled,
  });

  const roleResult = await query<RoleRow>(
    `SELECT role_key, scope_type, scope_id
       FROM app.role_assignment
      WHERE person_id = $1
        AND starts_at <= now()
        AND (ends_at IS NULL OR ends_at > now())`,
    [person.id],
  );

  return {
    personId: person.id,
    authUserId: person.auth_user_id,
    email: user.email,
    displayName: person.display_name,
    membershipStatus: person.membership_status,
    twoFactorEnabled,
    roles: roleResult.rows,
  };
}

export async function requireCurrentPrincipal(): Promise<Principal> {
  const principal = await getCurrentPrincipal();
  if (!principal) throw new AuthenticationRequiredError();
  return principal;
}

export function principalHasPermission(principal: Principal, permission: Permission, scope?: PermissionScope) {
  return grantsPermission(principal.roles, permission, scope);
}

export async function requirePermission(permission: Permission, scope?: PermissionScope): Promise<Principal> {
  const principal = await requireCurrentPrincipal();

  if (!principalHasPermission(principal, permission, scope)) {
    throw new AccessDeniedError();
  }

  if (permissionRequiresStrongAuth(permission) && !principal.twoFactorEnabled) {
    throw new AccessDeniedError("Two-factor authentication is required for this privileged action.");
  }

  return principal;
}
