import type { Metadata } from "next";
import type { QueryResultRow } from "pg";
import { ProtectedApp } from "@/components/protected-app";
import { query } from "@/lib/db";
import { tryPermission } from "@/lib/permission-query";

export const metadata: Metadata = {
  title: "Studio",
};

interface AssignmentRow extends QueryResultRow {
  id: string;
  person_id: string;
  display_name: string;
  title: string;
  work_classification: string;
  compensation_summary: string;
  disclosure_required: boolean;
  state: string;
  due_at: Date | null;
}

async function getAssignments(personId: string, manageAll: boolean) {
  const result = await query<AssignmentRow>(
    `SELECT a.id, a.person_id, p.display_name, a.title, a.work_classification,
            a.compensation_summary, a.disclosure_required, a.state, a.due_at
       FROM app.creator_assignment a
       JOIN app.person_profile p ON p.id = a.person_id
      WHERE ($2::boolean = true OR a.person_id = $1)
      ORDER BY a.due_at NULLS LAST, a.created_at DESC
      LIMIT 100`,
    [personId, manageAll],
  );
  return result.rows;
}

export default function StudioPage() {
  return (
    <ProtectedApp>
      {async (principal) => {
        const canManage = await tryPermission("creator:write");
        const assignments = await getAssignments(principal.personId, canManage.allowed);

        return (
          <>
            <header className="page-header">
              <div>
                <p className="eyebrow">Herald / Forge</p>
                <h1>Creator Studio</h1>
                <p className="muted page-lead">
                  Every assignment declares its work classification and compensation context before work is treated as an organizational deliverable.
                </p>
              </div>
              <span className="badge" data-tone={canManage.allowed ? "good" : undefined}>
                {canManage.allowed ? "Manager view" : "My assignments"}
              </span>
            </header>

            {assignments.length ? (
              <div className="grid grid-2">
                {assignments.map((assignment) => (
                  <article className="card stack" key={assignment.id}>
                    <div className="card-header">
                      <div>
                        {canManage.allowed ? <p className="eyebrow">{assignment.display_name}</p> : null}
                        <h2>{assignment.title}</h2>
                      </div>
                      <span className="badge">{assignment.state}</span>
                    </div>
                    <ul className="status-list">
                      <li className="status-row"><span className="status-label">Work classification</span><span>{assignment.work_classification}</span></li>
                      <li className="status-row"><span className="status-label">Compensation</span><span>{assignment.compensation_summary}</span></li>
                      <li className="status-row"><span className="status-label">Sponsor disclosure</span><span>{assignment.disclosure_required ? "Required" : "Not flagged"}</span></li>
                      <li className="status-row"><span className="status-label">Due</span><span>{assignment.due_at ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(assignment.due_at)) : "No due date"}</span></li>
                    </ul>
                  </article>
                ))}
              </div>
            ) : (
              <section className="card stack">
                <span className="badge">Empty</span>
                <h2>No creator assignments.</h2>
                <p className="muted">An empty Studio is valid; productive work must never be invented merely to manufacture Grind activity.</p>
              </section>
            )}
          </>
        );
      }}
    </ProtectedApp>
  );
}
