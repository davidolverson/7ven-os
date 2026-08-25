import { headers } from "next/headers";
import type { QueryResultRow } from "pg";
import { auth } from "@/lib/auth";
import { query } from "@/lib/db";

export type RoleKey =
  | "member"
  | "recruiter"
  | "coach"
  | "creator_manager"
  | "competition_admin"
  | "integrity_officer"
  | "safeguarding_officer"
  | "finance_submitter"
  | "finance_approver"
  | "finance_reconciler"
  | "council"
  | "privileged_admin"
  | "break_glass";

export type Permission =
  | "profile:read:self"
  | "profile:read:any"
  | "applications:read"
  | "applications:update"
  | "grind:read"
  | "grind:submit"
  | "grind:verify"
  | "roster:read"
  | "roster:write"
  | "competition:read"
  | "competition:write"
  | "results:submit"
  | "results:verify"
  | "results:certify"
  | "creator:read"
  | "creator:write"
  | "cases:intake"
  | "cases:read:restricted"
  | "cases:update:restricted"
  | "finance:create"
  | "finance:approve"
  | "finance:reconcile"
  | "compliance:read"
  | "compliance:write"
  | "audit:read"
  | "roles:manage";

const rolePermissions: Record<RoleKey, readonly Permission[]> = {
  member: ["profile:read:self", "grind:read", "grind:submit", "roster:read", "competition:read", "creator:read", "cases:intake"],
  recruiter: ["profile:read:any", "applications:read", "applications:update", "grind:read", "grind:submit"],
  coach: ["profile:read:any", "grind:read", "grind:submit", "roster:read", "roster:write", "competition:read"],
  creator_manager: ["profile:read:any", "creator:read", "creator:write", "grind:read", "grind:submit"],
  competition_admin: ["profile:read:any", "roster:read", "competition:read", "competition:write", "results:submit"],
  integrity_officer: ["competition:read", "results:verify", "results:certify", "cases:intake", "cases:read:restricted", "cases:update:restricted", "audit:read"],
  safeguarding_officer: ["cases:intake", "cases:read:restricted", "cases:update:restricted", "audit:read"],
  finance_submitter: ["finance:create"],
  finance_approver: ["finance:approve"],
  finance_reconciler: ["finance:reconcile"],
  council: ["profile:read:any", "applications:read", "grind:read", "roster:read", "competition:read", "creator:read", "compliance:read", "audit:read"],
  privileged_admin: [
    "profile:read:any",
    "applications:read",
    "applications:update",
    "grind:read",
    "grind:submit",
    "grind:verify",
    "roster:read",
    "roster:write",
    "competition:read",
    "competition:write",
    "results:submit",
    "creator:read",
    "creator:write",
    "cases:intake",
    "compliance:read",
    "compliance:write",
    "audit:read",
    "roles:manage"
  ],
  break_glass: [
    "profile:read:self",
    "profile:read:any",
    "applications:read",
    "applications:update",
    "grind:read",
    "grind:submit",
    "grind:verify",
    "roster:read",
    "roster:write",
    "competition:read",
    "competition:write",
    "results:submit",
    "results:verify",
    "results:certify",
    "creator:read",
    "creator:write",
    "cases:intake",
    "cases:read:restricted",
    "cases:update:restricted",
    "finance:create",
    "finance:approve",
    "finance:reconcile",
    "compliance:read",
    "compliance:write",
    "audit:read",
    "roles:manage"
  ]
};

interface PersonRow extends QueryResultRow {
  id: string;
  auth_user_id: string;
  display_name: string;
  membership_status: string;
}

interface RoleRow extends QueryResultRow {
  role_key: RoleKey;
  scope_type: string;
  scope_id: string | null;
}

export interface Principal {
  personId: string;
  authUserId: string;
  email: string;
  displayName: string;
  membershipStatus: string;
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

export async function getCurrentPrincipal(): Promise<Principal | null> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });

  if (!session) return null;

  const personResult = await query<PersonRow>(
    `SELECT id, auth_user_id, display_name, membership_status
       FROM app.person_profile
      WHERE auth_user_id = $1 AND active = true
      LIMIT 1`,
    [session.user.id],
  );

  const person = personResult.rows[0];
  if (!person) return null;

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
    email: session.user.email,
    displayName: person.display_name,
    membershipStatus: person.membership_status,
    roles: roleResult.rows,
  };
}

export async function requireCurrentPrincipal(): Promise<Principal> {
  const principal = await getCurrentPrincipal();
  if (!principal) throw new AuthenticationRequiredError();
  return principal;
}

function roleMatchesScope(role: RoleRow, scope?: { type: string; id?: string }) {
  if (role.scope_type === "organization") return true;
  if (!scope) return false;
  if (role.scope_type !== scope.type) return false;
  return role.scope_id === null || role.scope_id === scope.id;
}

export async function requirePermission(
  permission: Permission,
  scope?: { type: string; id?: string },
): Promise<Principal> {
  const principal = await requireCurrentPrincipal();

  const allowed = principal.roles.some((role) => {
    if (!roleMatchesScope(role, scope)) return false;
    return rolePermissions[role.role_key].includes(permission);
  });

  if (!allowed) throw new AccessDeniedError();
  return principal;
}
