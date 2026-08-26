import type { Metadata } from "next";
import Link from "next/link";
import type { QueryResultRow } from "pg";
import { ProtectedApp } from "@/components/protected-app";
import { query } from "@/lib/db";
import { tryPermission } from "@/lib/permission-query";

export const metadata: Metadata = {
  title: "Talent",
};

const STAFF_PAGE_SIZE = 50;
const MEMBER_HISTORY_LIMIT = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ApplicationRow extends QueryResultRow {
  id: string;
  display_name: string;
  requested_track: string;
  game_title: string | null;
  state: string;
  submitted_at: Date;
}

interface StaffQueueResult {
  rows: ApplicationRow[];
  nextCursor: { submittedAt: string; id: string } | null;
}

function parseQueueCursor(before: string | undefined, beforeId: string | undefined) {
  if (!before || !beforeId || !UUID_PATTERN.test(beforeId)) return null;
  const submittedAt = new Date(before);
  if (Number.isNaN(submittedAt.getTime())) return null;
  return { submittedAt, id: beforeId };
}

async function getStaffQueue(cursor: ReturnType<typeof parseQueueCursor>): Promise<StaffQueueResult> {
  const result = cursor
    ? await query<ApplicationRow>(
        `SELECT id, display_name, requested_track, game_title, state, submitted_at
           FROM app.application
          WHERE state <> 'withdrawn'
            AND (submitted_at < $1 OR (submitted_at = $1 AND id < $2::uuid))
          ORDER BY submitted_at DESC, id DESC
          LIMIT $3`,
        [cursor.submittedAt, cursor.id, STAFF_PAGE_SIZE + 1],
      )
    : await query<ApplicationRow>(
        `SELECT id, display_name, requested_track, game_title, state, submitted_at
           FROM app.application
          WHERE state <> 'withdrawn'
          ORDER BY submitted_at DESC, id DESC
          LIMIT $1`,
        [STAFF_PAGE_SIZE + 1],
      );

  const hasMore = result.rows.length > STAFF_PAGE_SIZE;
  const rows = result.rows.slice(0, STAFF_PAGE_SIZE);
  const lastVisible = rows.at(-1);

  return {
    rows,
    nextCursor:
      hasMore && lastVisible
        ? { submittedAt: new Date(lastVisible.submitted_at).toISOString(), id: lastVisible.id }
        : null,
  };
}

async function getOwnApplications(email: string) {
  const result = await query<ApplicationRow>(
    `SELECT id, display_name, requested_track, game_title, state, submitted_at
       FROM app.application
      WHERE lower(email) = lower($1)
      ORDER BY submitted_at DESC, id DESC
      LIMIT $2`,
    [email, MEMBER_HISTORY_LIMIT],
  );
  return result.rows;
}

function ApplicationsTable({ rows, staff }: { rows: ApplicationRow[]; staff: boolean }) {
  if (!rows.length) {
    return (
      <section className="card stack">
        <span className="badge">Empty</span>
        <h2>{staff ? "No active applications in the queue." : "No application is linked to this email yet."}</h2>
        <p className="muted">Empty states are intentional; they are not treated as application errors.</p>
      </section>
    );
  }

  return (
    <div className="table-scroll" tabIndex={0} aria-label={staff ? "Active application review queue" : "Your applications"}>
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

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string | string[]; beforeId?: string | string[] }>;
}) {
  const params = await searchParams;
  const before = typeof params.before === "string" ? params.before : undefined;
  const beforeId = typeof params.beforeId === "string" ? params.beforeId : undefined;
  const cursor = parseQueueCursor(before, beforeId);

  return (
    <ProtectedApp>
      {async (principal) => {
        const staffAccess = await tryPermission("applications:read");
        const staffQueue = staffAccess.allowed ? await getStaffQueue(cursor) : null;
        const rows = staffQueue?.rows ?? await getOwnApplications(principal.email);

        const nextHref = staffQueue?.nextCursor
          ? `/applications?${new URLSearchParams({
              before: staffQueue.nextCursor.submittedAt,
              beforeId: staffQueue.nextCursor.id,
            }).toString()}`
          : null;

        return (
          <>
            <header className="page-header">
              <div>
                <p className="eyebrow">Talent</p>
                <h1>{staffAccess.allowed ? "Application queue" : "Your application history"}</h1>
                <p className="muted page-lead">
                  {staffAccess.allowed
                    ? "Reviewer access is role-controlled. The active queue intentionally omits contact details and application narrative from the overview. Withdrawn applications are excluded from this queue but remain part of the applicant's own history."
                    : "You can see applications submitted with the same email as your authenticated account. Reviewer-only queue controls and other applicants' records are not exposed here."}
                </p>
              </div>
              <span className="badge" data-tone={staffAccess.allowed ? "good" : undefined}>
                {staffAccess.allowed ? "Reviewer view" : "Member view"}
              </span>
            </header>

            <ApplicationsTable rows={rows} staff={staffAccess.allowed} />

            {staffAccess.allowed ? (
              <section className="card stack" aria-label="Application queue pagination">
                <p className="muted">
                  Showing up to {STAFF_PAGE_SIZE} active applications in deterministic newest-first order.
                </p>
                {nextHref ? (
                  <Link className="button" href={nextHref}>View older applications</Link>
                ) : (
                  <span className="badge">End of active queue</span>
                )}
              </section>
            ) : null}
          </>
        );
      }}
    </ProtectedApp>
  );
}
