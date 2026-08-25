import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentPrincipal, type Principal } from "@/lib/access";

export async function ProtectedApp({
  children,
}: Readonly<{
  children: (principal: Principal) => React.ReactNode | Promise<React.ReactNode>;
}>) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/sign-in");

  const content = await children(principal);
  return <AppShell>{content}</AppShell>;
}
