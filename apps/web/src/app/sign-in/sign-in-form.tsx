"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignInForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function completeSignIn() {
    router.replace("/dashboard");
    router.refresh();
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    const result = await authClient.signIn.email({ email, password });

    if (result.error) {
      setError("Sign-in failed. Check your credentials or account status.");
      setPending(false);
      return;
    }

    // The Better Auth two-factor client redirects challenged credential sign-ins to /two-factor.
    if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect === true) {
      return;
    }

    completeSignIn();
  }

  return (
    <form className="card stack" method="post" action="/sign-in" onSubmit={onSubmit}>
      <div>
        <p className="eyebrow">Member access</p>
        <h2>Sign in</h2>
        <p className="muted form-intro">Public account creation is disabled until the onboarding gates are cleared.</p>
      </div>

      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          className="input"
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email webauthn"
          maxLength={254}
          required
        />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          className="input"
          id="password"
          name="password"
          type="password"
          autoComplete="current-password webauthn"
          minLength={12}
          maxLength={128}
          required
        />
      </div>

      {error ? <div className="form-error" role="alert">{error}</div> : null}

      <button className="button button-primary" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in with password"}
      </button>
      <p className="muted">
        Passkey sign-in remains gated during the MOC security phase. Existing passkey support is not treated as a launch claim yet.
      </p>
    </form>
  );
}
