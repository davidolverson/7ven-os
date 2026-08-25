import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { evaluateSessionAssurance } from "@/lib/session-assurance";

const handlers = toNextJsHandler(auth);
const identityAdminPrefix = "/api/auth/admin/";

function isIdentityAdminRequest(request: Request) {
  return new URL(request.url).pathname.startsWith(identityAdminPrefix);
}

async function identityAdminStrongAuthGate(request: Request): Promise<Response | null> {
  if (!isIdentityAdminRequest(request)) return null;

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    // Preserve Better Auth's native unauthenticated behavior and error contract.
    return null;
  }

  const user = session.user as typeof session.user & { twoFactorEnabled?: boolean };
  const sessionRecord = session.session as typeof session.session & { strongAuthAt?: Date | string | null };
  const assurance = evaluateSessionAssurance(user, sessionRecord);

  if (assurance.strongAuthVerified) return null;

  return Response.json(
    {
      error: {
        code: "IDENTITY_STRONG_AUTH_REQUIRED",
        message: "A verified two-factor session is required for identity administration. Sign in again and complete the second-factor challenge.",
      },
    },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

export async function GET(request: Request) {
  const denied = await identityAdminStrongAuthGate(request);
  if (denied) return denied;
  return handlers.GET(request);
}

export async function POST(request: Request) {
  const denied = await identityAdminStrongAuthGate(request);
  if (denied) return denied;
  return handlers.POST(request);
}
