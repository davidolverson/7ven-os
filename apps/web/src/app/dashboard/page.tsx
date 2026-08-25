import type { Metadata } from "next";
import type { QueryResultRow } from "pg";
import { ProtectedApp } from "@/components/protected-app";
import { query } from "@/lib/db";

export const metadata: Metadata = {
  title: "Dashboard",
};

interface DashboardRow extends QueryResultRow {
  evidence_count: number;
  active_roster_count: number;
  open_payment_count: number;
  open_payment_minor: string;
}

async function getDashboardSummary(personId: string) {
  const result = await query<DashboardRow>(
    `SELECT
       (SELECT count(*)::int FROM app.grind_evidence WHERE person_id = $1) AS evidence_count,
       (SELECT count(*)::int FROM app.roster_membership WHERE person_id = $1 AND ended_at IS NULL) AS active_roster_count,
       (SELECT count(*)::int FROM app.payment_obligation
         WHERE person_id = $1 AND state IN ('earned','approved','scheduled','disputed')) AS open_payment_count,
       COALESCE((SELECT sum(amount_minor)::text FROM app.payment_obligation
         WHERE person_id = $1 AND state IN ('earned','approved','scheduled','disputed')), '0') AS open_payment_minor`,
    [personId],
  );

  return result.rows[0] ?? {
    evidence_count: 0,
    active_roster_count: 0,
    open_payment_count: 0,
    open_payment_minor: "0",
  };
}

export default function DashboardPage() {
  return (
    <ProtectedApp>
      {async (principal) => {
        const summary = await getDashboardSummary(principal.personId);
        return (
          <>
            <header className="page-header">
              <div>
                <p className="eyebrow">Member home</p>
                <h1>Welcome, {principal.displayName}</h1>
                <p className="muted page-lead">Your status, evidence, roster activity, account security, and recorded obligations in one place.</p>
              </div>
              <span className="badge" data-tone={principal.twoFactorEnabled ? "good" : "warn"}>
                {principal.twoFactorEnabled ? "2FA enabled" : "2FA not enabled"}
              </span>
            </header>

            <section className="grid grid-3" aria-label="Member summary">
              <article className="card">
                <p className="eyebrow">Status</p>
                <p className="metric">{principal.membershipStatus}</p>
                <p className="muted">Organizational status is separate from employment or contractor classification.</p>
              </article>
              <article className="card">
                <p className="eyebrow">Grind evidence</p>
                <p className="metric">{summary.evidence_count}</p>
                <p className="muted">Evidence records, not a universal XP or popularity score.</p>
              </article>
              <article className="card">
                <p className="eyebrow">Active rosters</p>
                <p className="metric">{summary.active_roster_count}</p>
                <p className="muted">Current team assignments with an open roster interval.</p>
              </article>
            </section>

            <section className="grid grid-2 dashboard-section">
              <article className="card stack">
                <div className="card-header">
                  <h2>Recorded money</h2>
                  <span className="badge">{summary.open_payment_count} open</span>
                </div>
                <p className="metric">{Number(summary.open_payment_minor) / 100}</p>
                <p className="muted">Minor-unit total across earned, approved, scheduled, or disputed obligations. Currency-specific presentation is added when multi-currency obligations are activated.</p>
              </article>

              <article className="card stack">
                <div className="card-header">
                  <h2>Org roles</h2>
                  <span className="badge">{principal.roles.length}</span>
                </div>
                {principal.roles.length ? (
                  <ul className="status-list">
                    {principal.roles.map((role, index) => (
                      <li className="status-row" key={`${role.role_key}-${role.scope_type}-${role.scope_id ?? "all"}-${index}`}>
                        <span>{role.role_key}</span>
                        <span className="muted">{role.scope_type}{role.scope_id ? ` · ${role.scope_id}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No staff or member role has been assigned. Authentication alone grants no Org authority.</p>
                )}
              </article>
            </section>
          </>
        );
      }}
    </ProtectedApp>
  );
}
