import type { Metadata } from "next";
import type { QueryResultRow } from "pg";
import { ProtectedApp } from "@/components/protected-app";
import { query } from "@/lib/db";
import { tryPermission } from "@/lib/permission-query";

export const metadata: Metadata = {
  title: "Talent",
};

interface ApplicationRow extends QueryResultRow {
  id: string;
  display_name: string;
  requested_track: string;
  game_title: string | null;
  state: string;
  submitted_at: Date;
}

async function getStaffQueue() {
  const result = await query<ApplicationRow>(
    `SELECT id, display_name, requested_track, game_title, state, submitted_at
       FROM app.application
      WHERE state NOT IN ('withdrawn')
      ORDER BY submitted_at DESC
      LIMIT 50`,
  );
  return result.rows;
}

async function getOwnApplications(email: string) {
  const result = await query<ApplicationRow>(
    `SELECT id, display_name, requested_track, game_title, state, submitted_at
       FROM app.application
      WHERE lower(email) = lower($1)
      ORDER BY submitted_at DESC
      LIMIT 20`,
    [email],
  );
  return result.rows;
}

function ApplicationsTable({ rows, staff }: { rows: ApplicationRow[]; staff: boolean }) {
  if (!rows.length) {
    return (
      <section className="card stack">
        <span className="badge">Empty</span>
        <h2>{staff ? "No applications in the queue." : "No application is linked to this email yet."}</h2>
        <p className="muted">Empty states are intentional; they are not treated as application errors.</p>
      </section>
    );
  }

  return (
    <div className="table-scroll" tabIndex={0} aria-label={staff ? "Application review queue" : "Your applications"}>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Track</th>
            <th>Game</th>
            <th>State</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((application) => (
            <tr key={application.id}>
              <td>{application.display_name}</td>
              <td>{application.requested_track}</td>
              <td>{application.game_title ?? "—"}</td>
              <td><span className="badge">{application.state}</span></td>
              <td>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(application.submitted_at))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ApplicationsPage() {
  return (
    <ProtectedApp>
      {async (principal) => {
        const staffAccess = await tryPermission("applications:read");
        const rows = staffAccess.allowed ? await getStaffQueue() : await getOwnApplications(principal.email);

        return (
          <>
            <header className="page-header">
              <div>
                <p className="eyebrow">Talent</p>
                <h1>{staffAccess.allowed ? "Application queue" : "Your application history"}</h1>
                <p className="muted page-lead">
                  {staffAccess.allowed
                    ? "Review access is role-controlled. This list intentionally omits unnecessary contact PII from the overview."
                    : "You can see applications submitted with the same email as your authenticated account."}
                </p>
              </div>
              <span className="badge" data-tone={staffAccess.allowed ? "good" : undefined}>
                {staffAccess.allowed ? "Reviewer view" : "Member view"}
              </span>
            </header>
            <ApplicationsTable rows={rows} staff={staffAccess.allowed} />
          </>
        );
      }}
    </ProtectedApp>
  );
}
