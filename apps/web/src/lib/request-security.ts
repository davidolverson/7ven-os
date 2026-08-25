import { NextResponse } from "next/server";
import { AccessDeniedError, AuthenticationRequiredError } from "@/lib/access";
import { env } from "@/lib/env";

export function requestIsSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(env.NEXT_PUBLIC_APP_URL).origin;
  } catch {
    return false;
  }
}

export function jsonError(status: number, code: string, message: string, headers?: HeadersInit) {
  const merged = new Headers(headers);
  merged.set("Cache-Control", "no-store");
  return NextResponse.json({ error: { code, message } }, { status, headers: merged });
}

export function accessErrorResponse(error: unknown) {
  if (error instanceof AuthenticationRequiredError) {
    return jsonError(401, "AUTHENTICATION_REQUIRED", error.message);
  }
  if (error instanceof AccessDeniedError) {
    return jsonError(403, "ACCESS_DENIED", error.message);
  }
  return null;
}
