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
                Identity authentication and Org authorization stay separate. Two-factor protection strengthens the account; scoped Org roles still decide what it may do.
              </p>
            </div>
            <span className="badge" data-tone={principal.twoFactorEnabled ? "good" : undefined}>
              {principal.twoFactorEnabled ? "2FA enabled" : "2FA not enabled"}
            </span>
          </header>
          <SecurityCenter twoFactorEnabled={principal.twoFactorEnabled} />
        </>
      )}
    </ProtectedApp>
  );
}
