import type { Metadata } from "next";
import Link from "next/link";
import { TwoFactorForm } from "./two-factor-form";

export const metadata: Metadata = {
  title: "Two-factor verification",
};

export default function TwoFactorPage() {
  return (
    <main id="main-content" className="narrow-page">
      <Link className="back-link" href="/sign-in">← Back to sign in</Link>
      <div className="page-header apply-header">
        <div>
          <p className="eyebrow">Security</p>
          <h1>Verify your sign-in</h1>
          <p className="muted page-lead">Use your authenticator app or one of your stored backup codes.</p>
        </div>
      </div>
      <TwoFactorForm />
    </main>
  );
}
