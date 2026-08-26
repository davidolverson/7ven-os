export const roleKeys = [
  "member",
  "recruiter",
  "coach",
  "creator_manager",
  "competition_admin",
  "integrity_officer",
  "safeguarding_officer",
  "finance_submitter",
  "finance_approver",
  "finance_reconciler",
  "council",
  "privileged_admin",
  "break_glass",
] as const;

export type RoleKey = (typeof roleKeys)[number];

export const assignableRoleKeys = [
  "member",
  "recruiter",
  "coach",
  "creator_manager",
  "competition_admin",
  "integrity_officer",
  "safeguarding_officer",
  "finance_submitter",
  "finance_approver",
  "finance_reconciler",
  "council",
  "privileged_admin",
] as const satisfies readonly Exclude<RoleKey, "break_glass">[];

// Direct technical access administration is deliberately limited to routine operational roles.
// Sensitive/governance roles must use a governed approval path; break-glass is the only emergency bypass.
export const directAssignableRoleKeys = [
  "member",
  "recruiter",
  "coach",
  "creator_manager",
  "competition_admin",
] as const satisfies readonly (typeof assignableRoleKeys)[number][];

export const governanceProtectedRoleKeys = [
  "integrity_officer",
  "safeguarding_officer",
  "finance_submitter",
  "finance_approver",
  "finance_reconciler",
  "council",
  "privileged_admin",
] as const satisfies readonly (typeof assignableRoleKeys)[number][];

const governanceProtectedRoleSet = new Set<RoleKey>(governanceProtectedRoleKeys);

export function roleRequiresGovernanceApproval(roleKey: RoleKey) {
  return governanceProtectedRoleSet.has(roleKey);
}

export const scopeTypes = ["organization", "title", "team", "event", "case", "finance"] as const;
export type ScopeType = (typeof scopeTypes)[number];

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
  | "roles:manage"
  | "governance:approve";

export interface RoleGrant {
  role_key: RoleKey;
  scope_type: ScopeType;
  scope_id: string | null;
}

export interface PermissionScope {
  type: ScopeType;
  id?: string;
}

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
  council: [
    "profile:read:any",
    "applications:read",
    "grind:read",
    "roster:read",
    "competition:read",
    "creator:read",
    "compliance:read",
    "audit:read",
    "governance:approve",
  ],
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
    "roles:manage",
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
    "roles:manage",
  ],
};

const strongAuthPermissions = new Set<Permission>([
  "applications:update",
  "grind:verify",
  "roster:write",
  "competition:write",
  "results:submit",
  "results:verify",
  "results:certify",
  "creator:write",
  "cases:read:restricted",
  "cases:update:restricted",
  "finance:create",
  "finance:approve",
  "finance:reconcile",
  "compliance:write",
  "audit:read",
  "roles:manage",
  "governance:approve",
]);

function roleMatchesScope(role: RoleGrant, scope?: PermissionScope) {
  // Organization grants are global only when they have the canonical NULL scope ID.
  // Any malformed grant fails closed even if it somehow bypassed database constraints.
  if (role.scope_type === "organization") return role.scope_id === null;
  if (!scope || role.scope_id === null) return false;
  if (role.scope_type !== scope.type) return false;
  return role.scope_id === scope.id;
}

export function grantsPermission(roles: readonly RoleGrant[], permission: Permission, scope?: PermissionScope) {
  return roles.some((role) => roleMatchesScope(role, scope) && rolePermissions[role.role_key].includes(permission));
}

export function permissionRequiresStrongAuth(permission: Permission) {
  return strongAuthPermissions.has(permission);
}
