import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@/lib/env";
import { ApplicationForm } from "./application-form";

export const metadata: Metadata = {
  title: "Apply",
};

export default function ApplyPage() {
  return (
    <main id="main-content" className="narrow-page">
      <Link className="back-link" href="/">← Back</Link>
      <div className="page-header apply-header">
        <div>
          <p className="eyebrow">Talent network</p>
          <h1>Earn the chance to be seen.</h1>
          <p className="muted page-lead">
            Applications are evaluated by track and evidence. Existing audience size is not the universal gate, and application does not guarantee selection.
          </p>
        </div>
      </div>

      {env.applicationIntakeEnabled ? (
        <ApplicationForm />
      ) : (
        <section className="card stack" aria-live="polite">
          <span className="badge" data-tone="warn">Intake closed</span>
          <h2>Public applications are not open yet.</h2>
          <p className="muted">
            The application API is also disabled server-side until the privacy, safeguarding, member-rights, and operational launch gates are satisfied.
          </p>
        </section>
      )}
    </main>
  );
}
