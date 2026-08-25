import type { Metadata } from "next";
import { ProtectedApp } from "@/components/protected-app";
import { SecurityCenter } from "./security-center";

export const metadata: Metadata = {
  title: "Account Security",
};

export default function SecurityPage() {
  return (
    <ProtectedApp>
      {async (principal) => (
        <>
          <header className="page-header">
            <div>
              <p className="eyebrow">Account security</p>
              <h1>Protect privileged access</h1>
              <p className="muted page-lead">
                Identity authentication and Org authorization stay separate. Privileged writes require both an authorized Org role and a current session that actually completed a second-factor challenge.
              </p>
            </div>
            <span className="badge" data-tone={principal.strongAuthVerified ? "good" : undefined}>
              {principal.strongAuthVerified
                ? "2FA session verified"
                : principal.twoFactorEnabled
                  ? "2FA enrolled · session not verified"
                  : "2FA not enabled"}
            </span>
          </header>
          <SecurityCenter
            twoFactorEnabled={principal.twoFactorEnabled}
            strongAuthVerified={principal.strongAuthVerified}
            strongAuthAt={principal.strongAuthAt?.toISOString() ?? null}
          />
        </>
      )}
    </ProtectedApp>
  );
}
