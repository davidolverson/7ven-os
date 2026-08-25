import type { Metadata } from "next";
import Link from "next/link";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function SignInPage() {
  return (
    <main id="main-content" className="narrow-page">
      <Link className="back-link" href="/">← Back</Link>
      <div className="page-header apply-header">
        <div>
          <p className="eyebrow">Org OS</p>
          <h1>Member access</h1>
          <p className="muted page-lead">Authentication is separate from organizational authorization. A valid login alone does not grant staff or admin permissions.</p>
        </div>
      </div>
      <SignInForm />
    </main>
  );
}
