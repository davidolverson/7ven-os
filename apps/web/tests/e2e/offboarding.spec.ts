import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

const operatorEmail = process.env.E2E_OFFBOARD_ADMIN_EMAIL ?? "e2e-offboard-admin@example.test";
const operatorPassword = process.env.E2E_OFFBOARD_ADMIN_PASSWORD ?? "E2E-Offboard-Admin-2026!";
const targetEmail = process.env.E2E_OFFBOARD_TARGET_EMAIL ?? "e2e-offboard-target@example.test";
const targetPassword = process.env.E2E_OFFBOARD_TARGET_PASSWORD ?? "E2E-Offboard-Target-2026!";
const targetPersonId = process.env.E2E_OFFBOARD_TARGET_PERSON_ID ?? "00000000-0000-4000-8000-000000000020";
const phantomPersonId = process.env.E2E_OFFBOARD_PHANTOM_PERSON_ID ?? "00000000-0000-4000-8000-000000000021";
const baseOrigin = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").origin;

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

async function passwordSignIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
}

async function enrollAndChallengeTotp(page: import("@playwright/test").Page) {
  await passwordSignIn(page, operatorEmail, operatorPassword);
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto("/security");
  await page.getByLabel("Current password").fill(operatorPassword);
  await page.getByRole("button", { name: "Set up two-factor authentication" }).click();
  const totpURI = await page.getByLabel("Authenticator setup URI").inputValue();
  await page.getByLabel("6-digit authenticator code").fill(totpCode(totpURI));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page.getByText("Enrollment verified", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /sign out and verify session/i }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await passwordSignIn(page, operatorEmail, operatorPassword);
  await expect(page).toHaveURL(/\/two-factor$/);
  await page.getByLabel("6-digit code").fill(totpCode(totpURI, 1));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return totpURI;
}

test.describe.configure({ mode: "serial", retries: 0 });

test("offboarding disables Org access before identity cleanup and preserves retryable failure state", async ({ browser, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Stateful offboarding acceptance proof runs once on isolated Chromium identities.");

  const targetContext = await browser.newContext();
  const targetPage = await targetContext.newPage();
  await passwordSignIn(targetPage, targetEmail, targetPassword);
  await expect(targetPage).toHaveURL(/\/dashboard$/);

  await enrollAndChallengeTotp(page);

  const successResponse = await page.request.post("/api/admin/access/offboard", {
    headers: { origin: baseOrigin },
    data: {
      targetPersonId,
      decisionRef: "E2E-OFFBOARD-SUCCESS",
      reason: "E2E successful offboarding must disable Org access before identity cleanup.",
    },
  });
  expect(successResponse.status()).toBe(200);
  expect(successResponse.headers()["cache-control"]).toContain("no-store");
  const successBody = await successResponse.json();
  expect(successBody).toMatchObject({
    ok: true,
    replay: false,
    targetPersonId,
    state: "complete",
    orgAccessDisabled: true,
    identityAccessDisabled: true,
  });

  await targetPage.goto("/dashboard");
  await expect(targetPage).toHaveURL(/\/sign-in$/);

  await passwordSignIn(targetPage, targetEmail, targetPassword);
  await expect(targetPage).toHaveURL(/\/sign-in$/);
  await expect(targetPage.getByRole("alert")).toContainText("Sign-in failed. Check your credentials or account status.");

  const replayResponse = await page.request.post("/api/admin/access/offboard", {
    headers: { origin: baseOrigin },
    data: {
      targetPersonId,
      decisionRef: "E2E-OFFBOARD-SUCCESS",
      reason: "E2E successful offboarding must disable Org access before identity cleanup.",
    },
  });
  expect(replayResponse.status()).toBe(200);
  expect(await replayResponse.json()).toMatchObject({ ok: true, replay: true, state: "complete" });

  const failedIdentityResponse = await page.request.post("/api/admin/access/offboard", {
    headers: { origin: baseOrigin },
    data: {
      targetPersonId: phantomPersonId,
      decisionRef: "E2E-OFFBOARD-PARTIAL",
      reason: "E2E missing auth identity must leave Org access disabled and identity cleanup retryable.",
    },
  });
  expect(failedIdentityResponse.status()).toBe(502);
  const failedBody = await failedIdentityResponse.json();
  expect(failedBody).toMatchObject({
    error: { code: "IDENTITY_REVOCATION_PENDING" },
    orgAccessDisabled: true,
    identityRevocationPending: true,
    retryable: true,
  });
  expect(typeof failedBody.executionId).toBe("string");

  const retryResponse = await page.request.post("/api/admin/access/offboard", {
    headers: { origin: baseOrigin },
    data: {
      targetPersonId: phantomPersonId,
      decisionRef: "E2E-OFFBOARD-PARTIAL",
      reason: "E2E missing auth identity must leave Org access disabled and identity cleanup retryable.",
    },
  });
  expect(retryResponse.status()).toBe(502);
  const retryBody = await retryResponse.json();
  expect(retryBody.executionId).toBe(failedBody.executionId);
  expect(retryBody).toMatchObject({
    orgAccessDisabled: true,
    identityRevocationPending: true,
    retryable: true,
  });

  await targetContext.close();
});
