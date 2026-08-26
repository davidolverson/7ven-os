import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

const requiredFixtureKeys = [
  "E2E_GOV_REQUESTER_EMAIL",
  "E2E_GOV_REQUESTER_PASSWORD",
  "E2E_GOV_REQUESTER_PERSON_ID",
  "E2E_GOV_COUNCIL_EMAIL",
  "E2E_GOV_COUNCIL_PASSWORD",
  "E2E_GOV_COUNCIL_PERSON_ID",
  "E2E_GOV_SELF_REVIEWER_EMAIL",
  "E2E_GOV_SELF_REVIEWER_PASSWORD",
  "E2E_GOV_SELF_REVIEWER_PERSON_ID",
  "E2E_GOV_BREAKER_EMAIL",
  "E2E_GOV_BREAKER_PASSWORD",
  "E2E_GOV_BREAKER_PERSON_ID",
  "E2E_GOV_SCOPED_COUNCIL_EMAIL",
  "E2E_GOV_SCOPED_COUNCIL_PASSWORD",
  "E2E_GOV_SCOPED_COUNCIL_PERSON_ID",
  "E2E_GOV_TARGET_PERSON_ID",
  "E2E_GOV_REVOKE_ASSIGNMENT_ID",
  "E2E_GOV_TEAM_A_ID",
  "E2E_GOV_TEAM_B_ID",
] as const;

const hasFixtureContract = requiredFixtureKeys.every((key) => Boolean(process.env[key]));
const baseOrigin = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").origin;

const requester = {
  email: process.env.E2E_GOV_REQUESTER_EMAIL ?? "",
  password: process.env.E2E_GOV_REQUESTER_PASSWORD ?? "",
  personId: process.env.E2E_GOV_REQUESTER_PERSON_ID ?? "",
};
const council = {
  email: process.env.E2E_GOV_COUNCIL_EMAIL ?? "",
  password: process.env.E2E_GOV_COUNCIL_PASSWORD ?? "",
  personId: process.env.E2E_GOV_COUNCIL_PERSON_ID ?? "",
};
const selfReviewer = {
  email: process.env.E2E_GOV_SELF_REVIEWER_EMAIL ?? "",
  password: process.env.E2E_GOV_SELF_REVIEWER_PASSWORD ?? "",
  personId: process.env.E2E_GOV_SELF_REVIEWER_PERSON_ID ?? "",
};
const breaker = {
  email: process.env.E2E_GOV_BREAKER_EMAIL ?? "",
  password: process.env.E2E_GOV_BREAKER_PASSWORD ?? "",
  personId: process.env.E2E_GOV_BREAKER_PERSON_ID ?? "",
};
const scopedCouncil = {
  email: process.env.E2E_GOV_SCOPED_COUNCIL_EMAIL ?? "",
  password: process.env.E2E_GOV_SCOPED_COUNCIL_PASSWORD ?? "",
  personId: process.env.E2E_GOV_SCOPED_COUNCIL_PERSON_ID ?? "",
};
const targetPersonId = process.env.E2E_GOV_TARGET_PERSON_ID ?? "";
const revokeAssignmentId = process.env.E2E_GOV_REVOKE_ASSIGNMENT_ID ?? "";
const teamAId = process.env.E2E_GOV_TEAM_A_ID ?? "";
const teamBId = process.env.E2E_GOV_TEAM_B_ID ?? "";

type Credentials = { email: string; password: string; personId: string };

function decodeBase32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = value.toUpperCase().replace(/=+$/u, "").replace(/[^A-Z2-7]/gu, "");
  let bits = "";

  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("TOTP secret contains an invalid Base32 character.");
    bits += index.toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCode(totpURI: string, windowOffset = 0) {
  const uri = new URL(totpURI);
  const secret = uri.searchParams.get("secret");
  if (uri.protocol !== "otpauth:" || !secret) throw new Error("Expected a valid otpauth TOTP URI.");

  const digits = Number(uri.searchParams.get("digits") ?? "6");
  const period = Number(uri.searchParams.get("period") ?? "30");
  const algorithm = (uri.searchParams.get("algorithm") ?? "SHA1").toLowerCase().replaceAll("-", "");
  const counter = Math.floor(Date.now() / 1000 / period) + windowOffset;
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, decodeBase32(secret)).update(counterBuffer).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary =
    ((digest[offset] ?? 0) & 0x7f) * 0x1000000 +
    (digest[offset + 1] ?? 0) * 0x10000 +
    (digest[offset + 2] ?? 0) * 0x100 +
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

async function submitPasswordSignIn(page: import("@playwright/test").Page, credentials: Credentials) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
}

async function signInWithoutSecondFactor(page: import("@playwright/test").Page, credentials: Credentials) {
  await submitPasswordSignIn(page, credentials);
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function enrollCurrentSessionAndChallenge(page: import("@playwright/test").Page, credentials: Credentials) {
  await page.goto("/security");
  await page.getByLabel("Current password").fill(credentials.password);
  await page.getByRole("button", { name: "Set up two-factor authentication" }).click();
  const totpURI = await page.getByLabel("Authenticator setup URI").inputValue();
  await page.getByLabel("6-digit authenticator code").fill(totpCode(totpURI));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page.getByText("Enrollment verified", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /sign out and verify session/i }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await submitPasswordSignIn(page, credentials);
  await expect(page).toHaveURL(/\/two-factor$/);
  await page.getByLabel("6-digit code").fill(totpCode(totpURI, 1));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function createGrantRequest(
  page: import("@playwright/test").Page,
  input: { personId: string; roleKey: string; scopeType?: string; scopeId?: string | null; reason: string },
) {
  return page.request.post("/api/admin/governance/role-changes", {
    headers: { origin: baseOrigin },
    data: {
      operation: "grant",
      personId: input.personId,
      roleKey: input.roleKey,
      scopeType: input.scopeType ?? "organization",
      scopeId: input.scopeId ?? null,
      reason: input.reason,
      endsAt: null,
    },
  });
}

async function decide(
  page: import("@playwright/test").Page,
  requestId: string,
  decision: "approve" | "reject",
  reason: string,
) {
  return page.request.post(`/api/admin/governance/role-changes/${requestId}/decision`, {
    headers: { origin: baseOrigin },
    data: { decision, reason },
  });
}

async function expectRequestCreated(response: import("@playwright/test").APIResponse) {
  expect(response.status()).toBe(201);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, state: "pending" });
  expect(typeof body.roleChangeRequestId).toBe("string");
  return body.roleChangeRequestId as string;
}

test.describe.configure({ mode: "serial", retries: 0 });

test("protected role governance requires distinct challenged Council approval and proves negative non-mutation", async ({ browser }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chrome" || !hasFixtureContract,
    "Stateful protected-role governance proof runs only in its dedicated fixture lane.",
  );

  const requesterContext = await browser.newContext();
  const requesterPage = await requesterContext.newPage();
  await signInWithoutSecondFactor(requesterPage, requester);

  const noMfaRequest = await createGrantRequest(requesterPage, {
    personId: targetPersonId,
    roleKey: "safeguarding_officer",
    reason: "E2E request without challenged MFA must fail before persistence.",
  });
  expect(noMfaRequest.status()).toBe(403);
  expect(await noMfaRequest.json()).toMatchObject({ error: { code: "ACCESS_DENIED" } });

  await enrollCurrentSessionAndChallenge(requesterPage, requester);

  const directGrant = await requesterPage.request.post("/api/admin/roles", {
    headers: { origin: baseOrigin },
    data: {
      personId: targetPersonId,
      roleKey: "safeguarding_officer",
      scopeType: "organization",
      scopeId: null,
      reason: "E2E direct protected grant must remain governance-gated.",
      endsAt: null,
    },
  });
  expect(directGrant.status()).toBe(403);
  expect(await directGrant.json()).toMatchObject({ error: { code: "GOVERNANCE_APPROVAL_REQUIRED" } });

  const positiveGrantRequestId = await expectRequestCreated(
    await createGrantRequest(requesterPage, {
      personId: targetPersonId,
      roleKey: "safeguarding_officer",
      reason: "E2E distinct Council approval positive protected grant.",
    }),
  );

  const councilContext = await browser.newContext();
  const councilPage = await councilContext.newPage();
  await signInWithoutSecondFactor(councilPage, council);

  const noMfaApproval = await decide(
    councilPage,
    positiveGrantRequestId,
    "approve",
    "E2E unchallenged Council approval must fail closed.",
  );
  expect(noMfaApproval.status()).toBe(403);
  expect(await noMfaApproval.json()).toMatchObject({ error: { code: "ACCESS_DENIED" } });

  await enrollCurrentSessionAndChallenge(councilPage, council);
  const approved = await decide(
    councilPage,
    positiveGrantRequestId,
    "approve",
    "E2E distinct challenged Council approves protected grant.",
  );
  expect(approved.status()).toBe(200);
  const approvedBody = await approved.json();
  expect(approvedBody).toMatchObject({ ok: true, roleChangeRequestId: positiveGrantRequestId, state: "executed" });
  expect(typeof approvedBody.roleAssignmentId).toBe("string");

  const selfReviewerContext = await browser.newContext();
  const selfReviewerPage = await selfReviewerContext.newPage();
  await signInWithoutSecondFactor(selfReviewerPage, selfReviewer);
  await enrollCurrentSessionAndChallenge(selfReviewerPage, selfReviewer);

  const selfReviewRequestId = await expectRequestCreated(
    await createGrantRequest(selfReviewerPage, {
      personId: targetPersonId,
      roleKey: "finance_reconciler",
      reason: "E2E dual-role requester must not review their own request.",
    }),
  );
  const selfReview = await decide(
    selfReviewerPage,
    selfReviewRequestId,
    "approve",
    "E2E requester self-review must be rejected before mutation.",
  );
  expect(selfReview.status()).toBe(409);
  expect(await selfReview.json()).toMatchObject({ error: { code: "REQUESTER_CANNOT_REVIEW" } });

  const selfElevationRequestId = await expectRequestCreated(
    await createGrantRequest(requesterPage, {
      personId: council.personId,
      roleKey: "privileged_admin",
      reason: "E2E Council member cannot approve their own protected elevation.",
    }),
  );
  const selfElevation = await decide(
    councilPage,
    selfElevationRequestId,
    "approve",
    "E2E self-elevation attempt must fail without role mutation.",
  );
  expect(selfElevation.status()).toBe(409);
  expect(await selfElevation.json()).toMatchObject({ error: { code: "SELF_ELEVATION_NOT_ALLOWED" } });

  const rejectionRequestId = await expectRequestCreated(
    await createGrantRequest(requesterPage, {
      personId: targetPersonId,
      roleKey: "finance_submitter",
      reason: "E2E rejected protected grant must persist decision without role mutation.",
    }),
  );
  const rejected = await decide(
    councilPage,
    rejectionRequestId,
    "reject",
    "E2E Council rejects this protected role request with recorded reason.",
  );
  expect(rejected.status()).toBe(200);
  expect(await rejected.json()).toMatchObject({ ok: true, roleChangeRequestId: rejectionRequestId, state: "rejected" });

  const directRevoke = await requesterPage.request.patch(`/api/admin/roles/${revokeAssignmentId}`, {
    headers: { origin: baseOrigin },
    data: { reason: "E2E direct protected revocation must remain governance-gated." },
  });
  expect(directRevoke.status()).toBe(403);
  expect(await directRevoke.json()).toMatchObject({ error: { code: "GOVERNANCE_APPROVAL_REQUIRED" } });

  const revokeRequest = await requesterPage.request.post("/api/admin/governance/role-changes", {
    headers: { origin: baseOrigin },
    data: {
      operation: "revoke",
      roleAssignmentId: revokeAssignmentId,
      reason: "E2E governed protected revocation must preserve historical assignment row.",
    },
  });
  const revokeRequestId = await expectRequestCreated(revokeRequest);
  const revoked = await decide(
    councilPage,
    revokeRequestId,
    "approve",
    "E2E distinct Council approves protected revocation with history preserved.",
  );
  expect(revoked.status()).toBe(200);
  expect(await revoked.json()).toMatchObject({
    ok: true,
    roleChangeRequestId: revokeRequestId,
    roleAssignmentId: revokeAssignmentId,
    state: "executed",
  });

  const breakGlassRequestId = await expectRequestCreated(
    await createGrantRequest(requesterPage, {
      personId: targetPersonId,
      roleKey: "finance_approver",
      reason: "E2E active break-glass must not act as normal Council approval.",
    }),
  );
  const breakerContext = await browser.newContext();
  const breakerPage = await breakerContext.newPage();
  await signInWithoutSecondFactor(breakerPage, breaker);
  await enrollCurrentSessionAndChallenge(breakerPage, breaker);
  const breakGlassDecision = await decide(
    breakerPage,
    breakGlassRequestId,
    "approve",
    "E2E break-glass normal governance approval must fail closed.",
  );
  expect(breakGlassDecision.status()).toBe(403);
  expect(await breakGlassDecision.json()).toMatchObject({ error: { code: "BREAK_GLASS_NOT_NORMAL_GOVERNANCE" } });

  const scopedRequestId = await expectRequestCreated(
    await createGrantRequest(requesterPage, {
      personId: targetPersonId,
      roleKey: "safeguarding_officer",
      scopeType: "team",
      scopeId: teamBId,
      reason: "E2E Team B protected grant must reject Team A Council approval.",
    }),
  );
  const duplicateScoped = await createGrantRequest(requesterPage, {
    personId: targetPersonId,
    roleKey: "safeguarding_officer",
    scopeType: "team",
    scopeId: teamBId,
    reason: "E2E duplicate pending Team B request must be rejected atomically.",
  });
  expect(duplicateScoped.status()).toBe(409);
  expect(await duplicateScoped.json()).toMatchObject({ error: { code: "ROLE_CHANGE_ALREADY_PENDING" } });

  const scopedCouncilContext = await browser.newContext();
  const scopedCouncilPage = await scopedCouncilContext.newPage();
  await signInWithoutSecondFactor(scopedCouncilPage, scopedCouncil);
  await enrollCurrentSessionAndChallenge(scopedCouncilPage, scopedCouncil);
  const crossScopeDecision = await decide(
    scopedCouncilPage,
    scopedRequestId,
    "approve",
    "E2E Team A Council cannot approve a Team B protected role request.",
  );
  expect(crossScopeDecision.status()).toBe(403);
  expect(await crossScopeDecision.json()).toMatchObject({ error: { code: "ACCESS_DENIED" } });

  expect(teamAId).not.toBe(teamBId);

  await Promise.all([
    requesterContext.close(),
    councilContext.close(),
    selfReviewerContext.close(),
    breakerContext.close(),
    scopedCouncilContext.close(),
  ]);
});
