"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

interface TotpSetup {
  totpURI: string;
  backupCodes: string[];
}

export function SecurityCenter({ twoFactorEnabled }: { twoFactorEnabled: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [verified, setVerified] = useState(false);
  const [pending, setPending] = useState<"enable" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function enableTotp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("enable");
    setError(null);

    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") ?? "");
    const result = await authClient.twoFactor.enable({ password, method: "totp" });

    if (result.error || !result.data) {
      setError("Two-factor setup could not be started. Check your password and try again.");
      setPending(null);
      return;
    }

    const data = result.data as { method?: string; totpURI?: string; backupCodes?: string[] };
    if (data.method !== "totp" || !data.totpURI || !data.backupCodes?.length) {
      setError("The authenticator setup response was incomplete. No security setting was assumed active.");
      setPending(null);
      return;
    }

    event.currentTarget.reset();
    setSetup({ totpURI: data.totpURI, backupCodes: data.backupCodes });
    setPending(null);
  }

  async function verifyTotp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("verify");
    setError(null);

    const formData = new FormData(event.currentTarget);
    const code = String(formData.get("code") ?? "").trim();
    const result = await authClient.twoFactor.verifyTotp({ code, trustDevice: false });

    if (result.error) {
      setError("That authenticator code was not accepted. Two-factor protection is not treated as enabled yet.");
      setPending(null);
      return;
    }

    setVerified(true);
    setPending(null);
  }

  if (twoFactorEnabled && !setup) {
    return (
      <section className="card stack">
        <span className="badge" data-tone="good">Protected</span>
        <h2>Two-factor authentication is enabled.</h2>
        <p className="muted">
          Privileged Org OS writes require this account-level protection in addition to an authorized Org role.
        </p>
      </section>
    );
  }

  if (!setup) {
    return (
      <form className="card stack" onSubmit={enableTotp}>
        <div>
          <span className="badge">Action required for privileged roles</span>
          <h2>Enroll an authenticator</h2>
          <p className="muted">
            Enter your current password to begin TOTP enrollment. Enabling identity-admin access alone does not grant Org authority.
          </p>
        </div>
        <div className="field">
          <label htmlFor="security-password">Current password</label>
          <input
            className="input"
            id="security-password"
            name="password"
            type="password"
            autoComplete="current-password"
            minLength={12}
            maxLength={128}
            required
          />
        </div>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <button className="button button-primary" type="submit" disabled={pending !== null}>
          {pending === "enable" ? "Starting setup…" : "Set up two-factor authentication"}
        </button>
      </form>
    );
  }

  return (
    <section className="card stack">
      <div>
        <span className="badge" data-tone={verified ? "good" : undefined}>{verified ? "Verified" : "Enrollment pending"}</span>
        <h2>{verified ? "Save your backup codes" : "Add Org OS to your authenticator"}</h2>
      </div>

      {!verified ? (
        <>
          <p className="muted">
            Open the authenticator setup URI on a compatible device, then enter the current six-digit code. Org OS does not treat setup as complete until verification succeeds.
          </p>
          <div className="field">
            <label htmlFor="totp-uri">Authenticator setup URI</label>
            <textarea className="input" id="totp-uri" value={setup.totpURI} readOnly rows={4} />
          </div>
          <a className="button" href={setup.totpURI}>Open authenticator setup</a>
          <form className="stack" onSubmit={verifyTotp}>
            <div className="field">
              <label htmlFor="verify-code">6-digit authenticator code</label>
              <input
                className="input"
                id="verify-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            </div>
            {error ? <div className="form-error" role="alert">{error}</div> : null}
            <button className="button button-primary" type="submit" disabled={pending !== null}>
              {pending === "verify" ? "Verifying…" : "Verify and enable"}
            </button>
          </form>
        </>
      ) : (
        <>
          <p className="muted">
            Store these recovery codes somewhere secure and outside this browser session. They are intentionally shown here only as part of this setup flow.
          </p>
          <ul className="stack" aria-label="Two-factor backup codes">
            {setup.backupCodes.map((code) => <li key={code}><code>{code}</code></li>)}
          </ul>
          <button
            className="button button-primary"
            type="button"
            onClick={() => {
              setSetup(null);
              setVerified(false);
              router.refresh();
            }}
          >
            I saved the backup codes
          </button>
        </>
      )}
    </section>
  );
}
