import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Client, type QueryResultRow } from "pg";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

const baseOrigin = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").origin;
const databaseUrl = process.env.DATABASE_URL ?? "";
const migratorDatabaseUrl = process.env.T0_MIGRATOR_DATABASE_URL ?? "";
const privacyHashSecret = process.env.PRIVACY_HASH_SECRET ?? "";
const hasT0FixtureContract =
  process.env.E2E_T0_INTAKE === "true" &&
  Boolean(databaseUrl) &&
  Boolean(migratorDatabaseUrl) &&
  Boolean(privacyHashSecret);

interface CountRow extends QueryResultRow {
  count: string;
}

interface ApplicationProofRow extends QueryResultRow {
  id: string;
  email: string;
  display_name: string;
  requested_track: string;
  state: string;
  privacy_notice_version: string;
  goals: string;
  experience: string;
}

interface RateLimitProofRow extends QueryResultRow {
  key_hash: string;
  request_count: number;
}

interface RawHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function validPayload(suffix: string) {
  return {
    displayName: `T0 Applicant ${suffix}`,
    email: `t0-${suffix}@example.test`,
    requestedTrack: "competitive",
    gameTitle: "NBA 2K27",
    goals: "I want to improve through structured competition and accountable review.",
    experience: "I have competed with organized teams and documented my work over multiple seasons.",
    portfolioUrls: ["https://example.test/portfolio"],
    companyWebsite: "",
  };
}

function privateHeaders(response: APIResponse) {
  const headers = response.headers();
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["x-correlation-id"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
}

function rawHeader(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function privateRawHeaders(response: RawHttpResponse) {
  expect(rawHeader(response.headers, "cache-control")).toBe("no-store");
  expect(rawHeader(response.headers, "x-correlation-id")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
}

async function appQuery<T extends QueryResultRow>(text: string, values: string[] = []) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await client.query<T>(text, values);
  } finally {
    await client.end();
  }
}

async function migratorQuery(text: string) {
  const client = new Client({ connectionString: migratorDatabaseUrl });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

async function postApplication(
  request: APIRequestContext,
  payload: ReturnType<typeof validPayload>,
  options?: { key?: string; ip?: string; origin?: string | null },
) {
  const headers: Record<string, string> = {
    "x-real-ip": options?.ip ?? "203.0.113.10",
  };
  if (options?.origin !== null) headers.origin = options?.origin ?? baseOrigin;
  if (options?.key) headers["idempotency-key"] = options.key;

  return request.post("/api/applications", { headers, data: payload });
}

async function postChunkedJson(body: string, headers: Record<string, string>) {
  const target = new URL("/api/applications", baseOrigin);
  return new Promise<RawHttpResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);

    for (let offset = 0; offset < body.length; offset += 4096) {
      request.write(body.slice(offset, offset + 4096));
    }
    request.end();
  });
}

async function applicationCountByEmail(email: string) {
  const result = await appQuery<CountRow>(
    "SELECT count(*)::text AS count FROM app.application WHERE lower(email) = lower($1)",
    [email],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function applicationCountByKey(key: string) {
  const result = await appQuery<CountRow>(
    "SELECT count(*)::text AS count FROM app.application WHERE idempotency_key = $1::uuid",
    [key],
  );
  return Number(result.rows[0]?.count ?? "0");
}

test.describe("T0 open application intake Red Room", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(() => {
    test.skip(!hasT0FixtureContract, "T0 intake tests require the dedicated open-intake fixture contract.");
  });

  test("missing and forged origins fail before mutation with private correlation", async ({ request }) => {
    const payload = validPayload("origin-boundary");

    const missing = await postApplication(request, payload, {
      key: randomUUID(),
      ip: "203.0.113.11",
      origin: null,
    });
    expect(missing.status()).toBe(403);
    privateHeaders(missing);

    const forged = await postApplication(request, payload, {
      key: randomUUID(),
      ip: "203.0.113.11",
      origin: "https://attacker.example",
    });
    expect(forged.status()).toBe(403);
    privateHeaders(forged);

    expect(await applicationCountByEmail(payload.email)).toBe(0);
  });

  test("invalid JSON and actual oversized bodies fail without mutation", async ({ request }) => {
    const invalid = await request.post("/api/applications", {
      headers: {
        origin: baseOrigin,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-real-ip": "203.0.113.12",
      },
      data: "{not-json",
    });
    expect(invalid.status()).toBe(400);
    privateHeaders(invalid);
    expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_JSON" } });

    const oversizedPayload = validPayload("oversized");
    oversizedPayload.goals = "X".repeat(40_000);
    const oversizedBody = JSON.stringify(oversizedPayload);

    const declared = await request.post("/api/applications", {
      headers: {
        origin: baseOrigin,
        "idempotency-key": randomUUID(),
        "x-real-ip": "203.0.113.13",
      },
      data: oversizedPayload,
    });
    expect(declared.status()).toBe(413);
    privateHeaders(declared);

    const chunked = await postChunkedJson(oversizedBody, {
      origin: baseOrigin,
      "idempotency-key": randomUUID(),
      "x-real-ip": "203.0.113.14",
    });
    expect(chunked.status).toBe(413);
    privateRawHeaders(chunked);
    expect(JSON.parse(chunked.body)).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });

    expect(await applicationCountByEmail(oversizedPayload.email)).toBe(0);
  });

  test("valid writes require an explicit UUID idempotency key", async ({ request }) => {
    const payload = validPayload("idempotency-contract");

    const missing = await postApplication(request, payload, { ip: "203.0.113.15" });
    expect(missing.status()).toBe(400);
    privateHeaders(missing);
    expect(await missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

    const malformed = await postApplication(request, payload, {
      key: "not-a-uuid",
      ip: "203.0.113.15",
    });
    expect(malformed.status()).toBe(400);
    privateHeaders(malformed);
    expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_IDEMPOTENCY_KEY" } });

    expect(await applicationCountByEmail(payload.email)).toBe(0);
  });

  test("schema rejects malformed and excess portfolio URLs without persistence", async ({ request }) => {
    const payload = validPayload("validation");
    payload.portfolioUrls = [
      "not-a-url",
      "https://example.test/2",
      "https://example.test/3",
      "https://example.test/4",
      "https://example.test/5",
      "https://example.test/6",
    ];

    const response = await postApplication(request, payload, {
      key: randomUUID(),
      ip: "203.0.113.16",
    });
    expect(response.status()).toBe(422);
    privateHeaders(response);
    expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(await applicationCountByEmail(payload.email)).toBe(0);
  });

  test("honeypot silently accepts but creates no application or submission audit", async ({ request }) => {
    const payload = validPayload("honeypot");
    payload.companyWebsite = "https://bot.example";

    const auditBefore = await appQuery<CountRow>(
      "SELECT count(*)::text AS count FROM app.audit_event WHERE domain = 'talent' AND action = 'application.submitted'",
    );
    const response = await postApplication(request, payload, { ip: "203.0.113.17" });
    expect(response.status()).toBe(202);
    privateHeaders(response);
    expect(await response.json()).toEqual({ ok: true, state: "submitted" });
    expect(await applicationCountByEmail(payload.email)).toBe(0);

    const auditAfter = await appQuery<CountRow>(
      "SELECT count(*)::text AS count FROM app.audit_event WHERE domain = 'talent' AND action = 'application.submitted'",
    );
    expect(auditAfter.rows[0]?.count).toBe(auditBefore.rows[0]?.count);
  });

  test("successful intake treats Unicode, XSS-looking text, and SQL metacharacters as data without PII echo", async ({ request }) => {
    const payload = validPayload("data-safety");
    payload.displayName = "Ω Player 🎮 O'Reilly";
    payload.goals = "<script>alert('x')</script> I want disciplined improvement and measurable review.";
    payload.experience = "Robert'); DROP TABLE app.application;-- is inert text inside a parameterized application field.";
    const key = randomUUID();

    const response = await postApplication(request, payload, {
      key,
      ip: "203.0.113.18",
    });
    expect(response.status()).toBe(201);
    privateHeaders(response);

    const body = await response.json();
    expect(body).toMatchObject({ ok: true, state: "submitted", replay: false });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(payload.email);
    expect(serialized).not.toContain(payload.goals);
    expect(serialized).not.toContain(payload.experience);
    expect(serialized).not.toContain("portfolioUrls");

    const persisted = await appQuery<ApplicationProofRow>(
      `SELECT id, email, display_name, requested_track, state, privacy_notice_version,
              payload->>'goals' AS goals,
              payload->>'experience' AS experience
         FROM app.application
        WHERE idempotency_key = $1::uuid`,
      [key],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      email: payload.email,
      display_name: payload.displayName,
      requested_track: payload.requestedTrack,
      state: "submitted",
      privacy_notice_version: "prelaunch-internal-0.1",
      goals: payload.goals,
      experience: payload.experience,
    });
  });

  test("sequential replay returns the original reference and creates one row and one audit event", async ({ request }) => {
    const payload = validPayload("sequential-replay");
    const key = randomUUID();

    const first = await postApplication(request, payload, { key, ip: "203.0.113.19" });
    const second = await postApplication(request, payload, { key, ip: "203.0.113.19" });
    expect(first.status()).toBe(201);
    expect(second.status()).toBe(200);
    privateHeaders(first);
    privateHeaders(second);

    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.replay).toBe(false);
    expect(secondBody.replay).toBe(true);
    expect(secondBody.applicationId).toBe(firstBody.applicationId);
    expect(await applicationCountByKey(key)).toBe(1);

    const audits = await appQuery<CountRow>(
      `SELECT count(*)::text AS count
         FROM app.audit_event
        WHERE domain = 'talent'
          AND action = 'application.submitted'
          AND target_id = $1::uuid`,
      [firstBody.applicationId as string],
    );
    expect(Number(audits.rows[0]?.count ?? "0")).toBe(1);
  });

  test("concurrent same-key submissions converge to one application without generic failure", async ({ request }) => {
    const payload = validPayload("concurrent-replay");
    const key = randomUUID();

    const responses = await Promise.all(
      [0, 1, 2].map(() =>
        postApplication(request, payload, {
          key,
          ip: "203.0.113.20",
        }),
      ),
    );
    const statuses = responses.map((response) => response.status()).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 200, 201]);
    responses.forEach(privateHeaders);

    const bodies = await Promise.all(responses.map((response) => response.json()));
    const applicationIds = new Set(bodies.map((body) => body.applicationId));
    expect(applicationIds.size).toBe(1);
    expect(bodies.filter((body) => body.replay === false)).toHaveLength(1);
    expect(bodies.filter((body) => body.replay === true)).toHaveLength(2);
    expect(await applicationCountByKey(key)).toBe(1);

    const applicationId = String(bodies[0]?.applicationId ?? "");
    const audits = await appQuery<CountRow>(
      `SELECT count(*)::text AS count
         FROM app.audit_event
        WHERE domain = 'talent'
          AND action = 'application.submitted'
          AND target_id = $1::uuid`,
      [applicationId],
    );
    expect(Number(audits.rows[0]?.count ?? "0")).toBe(1);
  });

  test("concurrent rate limiting is atomic and persists only the HMAC pseudonym", async ({ request }) => {
    const payload = validPayload("rate-limit");
    const ip = "203.0.113.21";

    const responses = await Promise.all(
      [0, 1, 2, 3].map(() =>
        postApplication(request, payload, {
          key: randomUUID(),
          ip,
        }),
      ),
    );
    const statuses = responses.map((response) => response.status()).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 201, 201, 429]);
    responses.forEach(privateHeaders);

    const expectedHash = createHmac("sha256", privacyHashSecret)
      .update(`${ip}|${payload.email}`)
      .digest("hex");
    const limiter = await appQuery<RateLimitProofRow>(
      `SELECT key_hash, request_count
         FROM app.rate_limit_bucket
        WHERE bucket = 'application-submit'
          AND key_hash = $1`,
      [expectedHash],
    );
    expect(limiter.rows).toHaveLength(1);
    expect(limiter.rows[0]?.key_hash).toBe(expectedHash);
    expect(limiter.rows[0]?.request_count).toBe(4);
    expect(limiter.rows[0]?.key_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(limiter.rows[0]?.key_hash).not.toContain(payload.email);
    expect(limiter.rows[0]?.key_hash).not.toContain(ip);
  });

  test("audit-write database failure rolls application persistence back and remains correlated", async ({ request }) => {
    const payload = validPayload("rollback");
    const key = randomUUID();

    await migratorQuery("REVOKE INSERT ON app.audit_event FROM org_app");
    let response: APIResponse;
    try {
      response = await postApplication(request, payload, {
        key,
        ip: "203.0.113.22",
      });
    } finally {
      await migratorQuery("GRANT INSERT ON app.audit_event TO org_app");
    }

    expect(response!.status()).toBe(500);
    privateHeaders(response!);
    expect(await response!.json()).toMatchObject({ error: { code: "APPLICATION_SUBMIT_FAILED" } });
    expect(await applicationCountByKey(key)).toBe(0);
    expect(await applicationCountByEmail(payload.email)).toBe(0);
  });
});
