"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { assignableRoleKeys, scopeTypes } from "@/lib/authorization-model";

export interface AccessPersonOption {
  id: string;
  displayName: string;
}

export interface AccessAssignment {
  id: string;
  personId: string;
  displayName: string;
  roleKey: string;
  scopeType: string;
  scopeId: string | null;
  startsAt: string;
  endsAt: string | null;
}

function responseMessage(payload: unknown, fallback: string) {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return fallback;
}

export function AccessManager({
  people,
  assignments,
  canRevokeBreakGlass,
}: {
  people: AccessPersonOption[];
  assignments: AccessAssignment[];
  canRevokeBreakGlass: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [scopeType, setScopeType] = useState<(typeof scopeTypes)[number]>("organization");
  const [revokeReason, setRevokeReason] = useState("");

  async function assignRole(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("assign");
    setError(null);
    setSuccess(null);

    const form = event.currentTarget;
    const formData = new FormData(form);
    const endsAtRaw = String(formData.get("endsAt") ?? "").trim();
    const scopeIdRaw = String(formData.get("scopeId") ?? "").trim();

    const response = await fetch("/api/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personId: String(formData.get("personId") ?? ""),
        roleKey: String(formData.get("roleKey") ?? ""),
        scopeType,
        scopeId: scopeType === "organization" ? null : scopeIdRaw || null,
        reason: String(formData.get("reason") ?? ""),
        endsAt: endsAtRaw ? new Date(endsAtRaw).toISOString() : null,
      }),
    });

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setError(responseMessage(payload, "The role assignment could not be completed."));
      setPending(null);
      return;
    }

    form.reset();
    setScopeType("organization");
    setSuccess(response.status === 200 ? "That active role assignment already exists." : "Role assignment created and audited.");
    setPending(null);
    router.refresh();
  }

  async function revokeRole(id: string) {
    if (revokeReason.trim().length < 10) {
      setError("Enter a revocation reason of at least 10 characters first.");
      return;
    }

    setPending(id);
    setError(null);
    setSuccess(null);

    const response = await fetch(`/api/admin/roles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: revokeReason.trim() }),
    });
    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      setError(responseMessage(payload, "The role assignment could not be revoked."));
      setPending(null);
      return;
    }

    setRevokeReason("");
    setSuccess("Role access ended without deleting its history.");
    setPending(null);
    router.refresh();
  }

  return (
    <div className="stack">
      <form className="card stack" onSubmit={assignRole}>
        <div>
          <span className="badge">Protected write</span>
          <h2>Grant scoped role</h2>
          <p className="muted">
            Break-glass cannot be granted here. Every grant requires an authorized Org role, enrolled two-factor protection, a scope, and an audit reason.
          </p>
        </div>

        <div className="field">
          <label htmlFor="access-person">Person</label>
          <select className="input" id="access-person" name="personId" required defaultValue="">
            <option value="" disabled>Select a person</option>
            {people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="access-role">Role</label>
          <select className="input" id="access-role" name="roleKey" required defaultValue="member">
            {assignableRoleKeys.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="access-scope-type">Scope type</label>
          <select
            className="input"
            id="access-scope-type"
            name="scopeType"
            value={scopeType}
            onChange={(event) => setScopeType(event.target.value as (typeof scopeTypes)[number])}
          >
            {scopeTypes.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
          </select>
        </div>

        {scopeType !== "organization" ? (
          <div className="field">
            <label htmlFor="access-scope-id">Scope UUID</label>
            <input className="input" id="access-scope-id" name="scopeId" type="text" inputMode="text" required />
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="access-ends-at">Optional expiry</label>
          <input className="input" id="access-ends-at" name="endsAt" type="datetime-local" />
        </div>

        <div className="field">
          <label htmlFor="access-reason">Grant reason</label>
          <textarea className="input" id="access-reason" name="reason" minLength={10} maxLength={500} rows={3} required />
        </div>

        <button className="button button-primary" type="submit" disabled={pending !== null || people.length === 0}>
          {pending === "assign" ? "Granting…" : "Grant role"}
        </button>
      </form>

      <section className="card stack">
        <div>
          <h2>Active and historical assignments</h2>
          <p className="muted">Revocation sets an end time; it never deletes assignment or audit history.</p>
        </div>

        <div className="field">
          <label htmlFor="revoke-reason">Revocation reason</label>
          <textarea
            className="input"
            id="revoke-reason"
            value={revokeReason}
            onChange={(event) => setRevokeReason(event.target.value)}
            minLength={10}
            maxLength={500}
            rows={2}
          />
        </div>

        {assignments.length ? (
          <div className="table-scroll" tabIndex={0} aria-label="Role assignments">
            <table className="table">
              <thead>
                <tr><th>Person</th><th>Role</th><th>Scope</th><th>State</th><th>Action</th></tr>
              </thead>
              <tbody>
                {assignments.map((assignment) => {
                  const ended = assignment.endsAt ? new Date(assignment.endsAt).getTime() <= Date.now() : false;
                  const mayRevoke = !ended && (assignment.roleKey !== "break_glass" || canRevokeBreakGlass);
                  return (
                    <tr key={assignment.id}>
                      <td>{assignment.displayName}</td>
                      <td>{assignment.roleKey}</td>
                      <td>{assignment.scopeType}{assignment.scopeId ? ` · ${assignment.scopeId}` : ""}</td>
                      <td><span className="badge" data-tone={ended ? undefined : "good"}>{ended ? "Ended" : "Active"}</span></td>
                      <td>
                        {mayRevoke ? (
                          <button className="button" type="button" disabled={pending !== null} onClick={() => void revokeRole(assignment.id)}>
                            {pending === assignment.id ? "Revoking…" : "Revoke"}
                          </button>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No role assignments exist yet.</p>
        )}
      </section>

      {error ? <div className="form-error" role="alert">{error}</div> : null}
      {success ? <div className="card" role="status">{success}</div> : null}
    </div>
  );
}
