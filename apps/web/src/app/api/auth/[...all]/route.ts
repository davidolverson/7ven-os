import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { evaluateSessionAssurance } from "@/lib/session-assurance";

const handlers = toNextJsHandler(auth);
const identityAdminPrefix = "/api/auth/admin/";
const appOrigin = new URL(env.NEXT_PUBLIC_APP_URL).origin;

function isIdentityAdminRequest(request: Request) {
  return new URL(request.url).pathname.startsWith(identityAdminPrefix);
}

function requestHasTrustedOrigin(request: Request) {
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!origin || origin === "null") return false;

  try {
    return new URL(origin).origin === appOrigin;
  } catch {
    return false;
  }
}

function identityAdminOriginGate(request: Request): Response | null {
  if (!isIdentityAdminRequest(request)) return null;
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return null;

  // Better Auth validates Origin/Referer for mutating cookie-authenticated requests.
  // This outer MFA wrapper can return before the Better Auth router runs, so preserve
  // that same fail-closed property here instead of allowing MFA errors to short-circuit CSRF checks.
  if (!request.headers.has("cookie")) return null;
  if (requestHasTrustedOrigin(request)) return null;

  return Response.json(
    {
      error: {
        code: "IDENTITY_ORIGIN_NOT_ALLOWED",
        message: "This identity-administration request origin is not allowed.",
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
  const originDenied = identityAdminOriginGate(request);
  if (originDenied) return originDenied;

  const assuranceDenied = await identityAdminStrongAuthGate(request);
  if (assuranceDenied) return assuranceDenied;
  return handlers.GET(request);
}

export async function POST(request: Request) {
  const originDenied = identityAdminOriginGate(request);
  if (originDenied) return originDenied;

  const assuranceDenied = await identityAdminStrongAuthGate(request);
  if (assuranceDenied) return assuranceDenied;
  return handlers.POST(request);
}
