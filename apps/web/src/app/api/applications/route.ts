import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { QueryResultRow } from "pg";
import { env } from "@/lib/env";
import { transaction } from "@/lib/db";
import { consumeRateLimit } from "@/lib/rate-limit";
import { writeAuditEvent } from "@/lib/audit";

const MAX_APPLICATION_BYTES = 32_768;

const applicationSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  requestedTrack: z.enum(["competitive", "creator", "builder", "community", "leadership"]),
  gameTitle: z.string().trim().max(80).optional(),
  goals: z.string().trim().min(20).max(2_000),
  experience: z.string().trim().min(20).max(4_000),
  portfolioUrls: z.array(z.string().url().max(2_048)).max(5).default([]),
  companyWebsite: z.string().max(200).optional(),
});

interface ApplicationRow extends QueryResultRow {
  id: string;
  state: string;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Application payload exceeds the configured byte limit.");
    this.name = "PayloadTooLargeError";
  }
}

function responseHeaders(correlationId: string, headers?: HeadersInit) {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  result.set("X-Correlation-ID", correlationId);
  return result;
}

function jsonError(
  correlationId: string,
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: responseHeaders(correlationId, headers) },
  );
}

async function readBoundedRequestText(request: Request) {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_APPLICATION_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function requestIsSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(env.NEXT_PUBLIC_APP_URL).origin;
  } catch {
    return false;
  }
}

function clientRateLimitKey(request: Request, email: string) {
  // x-real-ip must be set/overwritten by the trusted deployment edge. It is never persisted raw.
  const trustedEdgeIp = request.headers.get("x-real-ip") ?? "no-trusted-edge-ip";
  return `${trustedEdgeIp}|${email.trim().toLowerCase()}`;
}

export async function POST(request: Request) {
  const correlationId = randomUUID();

  if (!env.applicationIntakeEnabled) {
    return jsonError(
      correlationId,
      503,
      "APPLICATION_INTAKE_CLOSED",
      "Applications are not open yet.",
      { "Retry-After": "3600" },
    );
  }

  if (!requestIsSameOrigin(request)) {
    return jsonError(correlationId, 403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.");
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_APPLICATION_BYTES) {
    return jsonError(correlationId, 413, "PAYLOAD_TOO_LARGE", "Application payload is too large.");
  }

  let bodyText: string;
  try {
    bodyText = await readBoundedRequestText(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonError(correlationId, 413, "PAYLOAD_TOO_LARGE", "Application payload is too large.");
    }
    console.error("application intake body read failed", { correlationId, error });
    return jsonError(
      correlationId,
      500,
      "APPLICATION_SUBMIT_FAILED",
      "The application could not be submitted. Try again later.",
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return jsonError(correlationId, 400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  const parsed = applicationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Please review the highlighted application fields.",
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 422, headers: responseHeaders(correlationId) },
    );
  }

  // Honeypot: return a normal-looking response without creating data.
  if (parsed.data.companyWebsite) {
    return NextResponse.json(
      { ok: true, state: "submitted" },
      { status: 202, headers: responseHeaders(correlationId) },
    );
  }

  const rawIdempotencyKey = request.headers.get("idempotency-key");
  if (!rawIdempotencyKey) {
    return jsonError(
      correlationId,
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key is required for application submissions.",
    );
  }

  const idempotency = z.string().uuid().safeParse(rawIdempotencyKey);
  if (!idempotency.success) {
    return jsonError(
      correlationId,
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be a UUID.",
    );
  }

  const rateLimit = await consumeRateLimit({
    bucket: "application-submit",
    rawKey: clientRateLimitKey(request, parsed.data.email),
    limit: 3,
    windowSeconds: 60 * 60,
  });

  if (!rateLimit.allowed) {
    return jsonError(
      correlationId,
      429,
      "RATE_LIMITED",
      "Too many application attempts. Try again later.",
      {
        "Retry-After": String(rateLimit.retryAfterSeconds),
        "X-RateLimit-Remaining": "0",
      },
    );
  }

  try {
    const result = await transaction(async (client) => {
      const inserted = await client.query<ApplicationRow>(
        `INSERT INTO app.application (
           email, display_name, requested_track, game_title, payload,
           state, privacy_notice_version, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5::jsonb, 'submitted', $6, $7)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING id, state`,
        [
          parsed.data.email.toLowerCase(),
          parsed.data.displayName,
          parsed.data.requestedTrack,
          parsed.data.gameTitle ?? null,
          JSON.stringify({
            goals: parsed.data.goals,
            experience: parsed.data.experience,
            portfolioUrls: parsed.data.portfolioUrls,
          }),
          "prelaunch-internal-0.1",
          idempotency.data,
        ],
      );

      const application = inserted.rows[0];
      if (application) {
        await writeAuditEvent(
          {
            actorKind: "system",
            domain: "talent",
            action: "application.submitted",
            targetType: "application",
            targetId: application.id,
            correlationId,
            metadata: {
              requestedTrack: parsed.data.requestedTrack,
              gameTitle: parsed.data.gameTitle ?? null,
            },
          },
          client,
        );

        return { application, replay: false };
      }

      const existing = await client.query<ApplicationRow>(
        `SELECT id, state FROM app.application WHERE idempotency_key = $1 LIMIT 1`,
        [idempotency.data],
      );
      const replay = existing.rows[0];
      if (!replay) {
        throw new Error("Idempotency conflict did not resolve to an existing application.");
      }
      return { application: replay, replay: true };
    });

    return NextResponse.json(
      {
        ok: true,
        applicationId: result.application.id,
        state: result.application.state,
        replay: result.replay,
      },
      {
        status: result.replay ? 200 : 201,
        headers: responseHeaders(correlationId, {
          "X-RateLimit-Remaining": String(rateLimit.remaining),
        }),
      },
    );
  } catch (error) {
    console.error("application intake failed", { correlationId, error });
    return jsonError(
      correlationId,
      500,
      "APPLICATION_SUBMIT_FAILED",
      "The application could not be submitted. Try again later.",
    );
  }
}
