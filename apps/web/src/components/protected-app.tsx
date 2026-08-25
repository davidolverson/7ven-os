import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  getCurrentPrincipal,
  OrganizationalAccessDisabledError,
  type Principal,
} from "@/lib/access";

export async function ProtectedApp({
  children,
}: Readonly<{
  children: (principal: Principal) => React.ReactNode | Promise<React.ReactNode>;
}>) {
  let principal: Principal | null;

  try {
    principal = await getCurrentPrincipal();
  } catch (error) {
    if (error instanceof OrganizationalAccessDisabledError) {
      return (
        <main id="main-content" className="public-shell">
          <section className="card stack" role="alert">
            <span className="badge">Access disabled</span>
            <h1>Organizational access disabled</h1>
            <p className="muted">
              This identity is authenticated, but Org OS access has been disabled. No organizational data or navigation was loaded.
            </p>
          </section>
        </main>
      );
    }
    throw error;
  }

  if (!principal) redirect("/sign-in");

  const content = await children(principal);
  return <AppShell>{content}</AppShell>;
}
