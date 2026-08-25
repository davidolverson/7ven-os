import Link from "next/link";
import type { Metadata } from "next";
import type { QueryResultRow } from "pg";
import { ProtectedApp } from "@/components/protected-app";
import { query } from "@/lib/db";
import { tryPermission } from "@/lib/permission-query";
import { AccessManager, type AccessAssignment, type AccessPersonOption } from "./access-manager";

export const metadata: Metadata = {
  title: "Access Management",
};

interface PersonRow extends QueryResultRow {
  id: string;
  display_name: string;
}

interface AssignmentRow extends QueryResultRow {
  id: string;
  person_id: string;
  display_name: string;
  role_key: string;
  scope_type: string;
  scope_id: string | null;
  starts_at: Date;
  ends_at: Date | null;
  revoked_at: Date | null;
}

async function getPeople(): Promise<AccessPersonOption[]> {
  const result = await query<PersonRow>(
    `SELECT id, display_name
       FROM app.person_profile
      WHERE active = true
      ORDER BY lower(display_name), id
      LIMIT 200`,
  );

  return result.rows.map((row) => ({ id: row.id, displayName: row.display_name }));
}

async function getAssignments(): Promise<AccessAssignment[]> {
  const result = await query<AssignmentRow>(
    `SELECT ra.id, ra.person_id, pp.display_name, ra.role_key, ra.scope_type, ra.scope_id,
            ra.starts_at, ra.ends_at, ra.revoked_at
       FROM app.role_assignment ra
       JOIN app.person_profile pp ON pp.id = ra.person_id
      ORDER BY (
        ra.revoked_at IS NULL
        AND ra.starts_at <= now()
        AND (ra.ends_at IS NULL OR ra.ends_at > now())
      ) DESC, ra.created_at DESC
      LIMIT 300`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    personId: row.person_id,
    displayName: row.display_name,
    roleKey: row.role_key,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  }));
}

export default function AccessPage() {
  return (
    <ProtectedApp>
      {async () => {
        const access = await tryPermission("roles:manage");

        if (!access.allowed) {
          return (
            <>
              <header className="page-header">
                <div>
                  <p className="eyebrow">Administration</p>
                  <h1>Access management unavailable</h1>
                  <p className="muted page-lead">
                    This surface requires an authorized Org role and enrolled two-factor authentication. Better Auth identity-admin status alone does not grant access.
                  </p>
                </div>
                <span className="badge">Permission denied</span>
              </header>
              <section className="card stack">
                <h2>No role data was loaded.</h2>
                <p className="muted">
                  Permission is checked before people or assignment records are queried, preventing the administration screen from becoming a role-discovery side channel.
                </p>
                <Link className="button" href="/security">Review account security</Link>
              </section>
            </>
          );
        }

        const [people, assignments] = await Promise.all([getPeople(), getAssignments()]);
        const canRevokeBreakGlass = access.principal.roles.some((role) => role.role_key === "break_glass");

        return (
          <>
            <header className="page-header">
              <div>
                <p className="eyebrow">Administration</p>
                <h1>Scoped Org access</h1>
                <p className="muted page-lead">
                  Grant only the minimum role and scope needed. Expiry and revocation remain distinct, historical assignments are retained, and break-glass stays outside the normal grant path.
                </p>
              </div>
              <span className="badge" data-tone="good">Authorized + 2FA</span>
            </header>
            <AccessManager
              people={people}
              assignments={assignments}
              canRevokeBreakGlass={canRevokeBreakGlass}
            />
          </>
        );
      }}
    </ProtectedApp>
  );
}
