import {
  AccessDeniedError,
  AuthenticationRequiredError,
  requirePermission,
  type Permission,
  type Principal,
} from "@/lib/access";

export async function tryPermission(
  permission: Permission,
  scope?: { type: string; id?: string },
): Promise<{ allowed: true; principal: Principal } | { allowed: false }> {
  try {
    const principal = await requirePermission(permission, scope);
    return { allowed: true, principal };
  } catch (error) {
    if (error instanceof AccessDeniedError || error instanceof AuthenticationRequiredError) {
      return { allowed: false };
    }
    throw error;
  }
}
