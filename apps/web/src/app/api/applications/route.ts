import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { QueryResultRow } from "pg";
import { env } from "@/lib/env";
import { transaction } from "@/lib/db";
import { consumeRateLimit } from "@/lib/rate-limit";
import { writeAuditEvent } from "@/lib/audit";

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

function jsonError(status: number, code: string, message: string, headers?: HeadersInit) {
  const init: ResponseInit = headers ? { status, headers } : { status };
  return NextResponse.json({ error: { code, message } }, init);
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
  if (!env.applicationIntakeEnabled) {
    return jsonError(503, "APPLICATION_INTAKE_CLOSED", "Applications are not open yet.", {
      "Retry-After": "3600",
    });
  }

  if (!requestIsSameOrigin(request)) {
    return jsonError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.");
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 32_768) {
    return jsonError(413, "PAYLOAD_TOO_LARGE", "Application payload is too large.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
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
      { status: 422 },
    );
  }

  // Honeypot: return a normal-looking response without creating data.
  if (parsed.data.companyWebsite) {
    return NextResponse.json({ ok: true, state: "submitted" }, { status: 202 });
  }

  const rateLimit = await consumeRateLimit({
    bucket: "application-submit",
    rawKey: clientRateLimitKey(request, parsed.data.email),
    limit: 3,
    windowSeconds: 60 * 60,
  });

  if (!rateLimit.allowed) {
    return jsonError(429, "RATE_LIMITED", "Too many application attempts. Try again later.", {
      "Retry-After": String(rateLimit.retryAfterSeconds),
      "X-RateLimit-Remaining": "0",
    });
  }

  const rawIdempotencyKey = request.headers.get("idempotency-key") ?? randomUUID();
  const idempotency = z.string().uuid().safeParse(rawIdempotencyKey);
  if (!idempotency.success) {
    return jsonError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a UUID.");
  }

  const correlationId = randomUUID();

  try {
    const result = await transaction(async (client) => {
      const existing = await client.query<ApplicationRow>(
        `SELECT id, state FROM app.application WHERE idempotency_key = $1 LIMIT 1`,
        [idempotency.data],
      );

      if (existing.rows[0]) {
        return { application: existing.rows[0], replay: true };
      }

      const inserted = await client.query<ApplicationRow>(
        `INSERT INTO app.application (
           email, display_name, requested_track, game_title, payload,
           state, privacy_notice_version, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5::jsonb, 'submitted', $6, $7)
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
      if (!application) throw new Error("Application insert did not return a record.");

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
        headers: {
          "X-RateLimit-Remaining": String(rateLimit.remaining),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("application intake failed", { correlationId, error });
    return jsonError(500, "APPLICATION_SUBMIT_FAILED", "The application could not be submitted. Try again later.");
  }
}
