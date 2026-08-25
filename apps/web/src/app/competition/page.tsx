import type { Metadata } from "next";
import type { QueryResultRow } from "pg";
import { ProtectedApp } from "@/components/protected-app";
import { query } from "@/lib/db";
import { tryPermission } from "@/lib/permission-query";

export const metadata: Metadata = {
  title: "Competition",
};

interface EventRow extends QueryResultRow {
  id: string;
  name: string;
  game_title: string;
  engine_type: string;
  lifecycle_state: string;
  ruleset_version: string;
  starts_at: Date | null;
  blocking_gate_count: number;
}

async function getEvents(includeDrafts: boolean) {
  const result = await query<EventRow>(
    `SELECT e.id, e.name, e.game_title, e.engine_type, e.lifecycle_state,
            e.ruleset_version, e.starts_at,
            (SELECT count(*)::int
               FROM app.blocking_compliance_gate g
              WHERE g.scope_ref = e.compliance_scope_ref
                AND g.scope_type IN ('event','title')) AS blocking_gate_count
       FROM app.competition_event e
      WHERE ($1::boolean = true OR e.lifecycle_state NOT IN ('draft','cancelled'))
      ORDER BY e.starts_at NULLS LAST, e.created_at DESC
      LIMIT 100`,
    [includeDrafts],
  );
  return result.rows;
}

export default function CompetitionPage() {
  return (
    <ProtectedApp>
      {async () => {
        const canManage = await tryPermission("competition:write");
        const events = await getEvents(canManage.allowed);

        return (
          <>
            <header className="page-header">
              <div>
                <p className="eyebrow">Arena</p>
                <h1>Competition</h1>
                <p className="muted page-lead">
                  Events use versioned rules and separate operational management from integrity verification and certification.
                </p>
              </div>
              <span className="badge" data-tone={canManage.allowed ? "good" : undefined}>
                {canManage.allowed ? "Operations view" : "Participant view"}
              </span>
            </header>

            {events.length ? (
              <div className="grid grid-2">
                {events.map((event) => (
                  <article className="card stack" key={event.id}>
                    <div className="card-header">
                      <div>
                        <p className="eyebrow">{event.game_title}</p>
                        <h2>{event.name}</h2>
                      </div>
                      <span className="badge" data-tone={event.blocking_gate_count > 0 ? "warn" : "good"}>
                        {event.lifecycle_state}
                      </span>
                    </div>
                    <ul className="status-list">
                      <li className="status-row"><span className="status-label">Engine</span><span>{event.engine_type}</span></li>
                      <li className="status-row"><span className="status-label">Ruleset</span><span>{event.ruleset_version}</span></li>
                      <li className="status-row"><span className="status-label">Start</span><span>{event.starts_at ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.starts_at)) : "Not scheduled"}</span></li>
                      {canManage.allowed ? (
                        <li className="status-row">
                          <span className="status-label">Blocking compliance gates</span>
                          <span>{event.blocking_gate_count}</span>
                        </li>
                      ) : null}
                    </ul>
                  </article>
                ))}
              </div>
            ) : (
              <section className="card stack">
                <span className="badge">Empty</span>
                <h2>No competition events are available.</h2>
                <p className="muted">Draft events remain hidden from participants until operations intentionally publish them.</p>
              </section>
            )}
          </>
        );
      }}
    </ProtectedApp>
  );
}
