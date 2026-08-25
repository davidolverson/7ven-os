"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function TwoFactorForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const code = String(formData.get("code") ?? "").trim();

    const result = mode === "totp"
      ? await authClient.twoFactor.verifyTotp({ code, trustDevice: false })
      : await authClient.twoFactor.verifyBackupCode({ code, trustDevice: false, disableSession: false });

    if (result.error) {
      setError("That verification code was not accepted.");
      setPending(false);
      return;
    }

    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <form className="card stack" onSubmit={onSubmit}>
      <div>
        <p className="eyebrow">Second factor</p>
        <h2>{mode === "totp" ? "Authenticator code" : "Backup code"}</h2>
        <p className="muted form-intro">
          Privileged Org OS actions require stronger account protection. This verification does not grant any Org role by itself.
        </p>
      </div>

      <div className="field">
        <label htmlFor="code">{mode === "totp" ? "6-digit code" : "Backup code"}</label>
        <input
          className="input"
          id="code"
          name="code"
          inputMode={mode === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          pattern={mode === "totp" ? "[0-9]{6}" : undefined}
          maxLength={mode === "totp" ? 6 : 128}
          required
          autoFocus
        />
      </div>

      {error ? <div className="form-error" role="alert">{error}</div> : null}

      <button className="button button-primary" type="submit" disabled={pending}>
        {pending ? "Verifying…" : "Verify"}
      </button>
      <button
        className="button"
        type="button"
        onClick={() => {
          setMode((current) => (current === "totp" ? "backup" : "totp"));
          setError(null);
        }}
      >
        {mode === "totp" ? "Use a backup code" : "Use authenticator code"}
      </button>
    </form>
  );
}
