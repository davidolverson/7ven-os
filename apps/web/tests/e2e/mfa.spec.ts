import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

const mfaEmail = process.env.E2E_MFA_EMAIL ?? "e2e-mfa@example.test";
const mfaPassword = process.env.E2E_MFA_PASSWORD ?? "E2E-MFA-Password-2026!";
const mfaPersonId = process.env.E2E_MFA_PERSON_ID ?? "00000000-0000-4000-8000-000000000010";
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
  if (uri.protocol !== "otpauth:") throw new Error("Expected an otpauth TOTP URI.");

  const secret = uri.searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI is missing a secret.");

  const digits = Number(uri.searchParams.get("digits") ?? "6");
  const period = Number(uri.searchParams.get("period") ?? "30");
  const algorithm = (uri.searchParams.get("algorithm") ?? "SHA1").toLowerCase().replaceAll("-", "");
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error("Unsupported TOTP digit count.");
  if (!Number.isFinite(period) || period <= 0) throw new Error("Unsupported TOTP period.");

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

async function passwordSignIn(page: import("@playwright/test").Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(mfaEmail);
  await page.getByLabel("Password").fill(mfaPassword);
  await page.getByRole("button", { name: "Sign in with password" }).click();
}

test.describe.configure({ mode: "serial", retries: 0 });

test("real TOTP challenge creates session assurance before a privileged write", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Stateful MFA acceptance proof runs once on isolated Chromium identity.");

  await passwordSignIn(page);
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto("/security");
  await page.getByLabel("Current password").fill(mfaPassword);
  await page.getByRole("button", { name: "Set up two-factor authentication" }).click();

  const totpURI = await page.getByLabel("Authenticator setup URI").inputValue();
  expect(totpURI).toMatch(/^otpauth:\/\/totp\//u);

  await page.getByLabel("6-digit authenticator code").fill(totpCode(totpURI));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page.getByText("Enrollment verified", { exact: true })).toBeVisible();

  const staleSessionWrite = await page.request.post("/api/admin/roles", {
    headers: { origin: baseOrigin },
    data: {
      personId: mfaPersonId,
      roleKey: "member",
      scopeType: "organization",
      scopeId: null,
      reason: "E2E stale pre-enrollment session must remain denied.",
      endsAt: null,
    },
  });
  expect(staleSessionWrite.status()).toBe(403);
  expect(await staleSessionWrite.json()).toMatchObject({
    error: {
      code: "ACCESS_DENIED",
      message:
        "A verified two-factor session is required for this privileged action. Sign in again and complete the second-factor challenge.",
    },
  });

  await page.getByRole("button", { name: /sign out and verify session/i }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await passwordSignIn(page);
  await expect(page).toHaveURL(/\/two-factor$/);
  await page.getByLabel("6-digit code").fill(totpCode(totpURI, 1));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto("/security");
  await expect(page.getByText("Verified session", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This session completed two-factor authentication." })).toBeVisible();

  const successfulWrite = await page.request.post("/api/admin/roles", {
    headers: { origin: baseOrigin },
    data: {
      personId: mfaPersonId,
      roleKey: "member",
      scopeType: "organization",
      scopeId: null,
      reason: "E2E positive strong-auth audit proof.",
      endsAt: null,
    },
  });
  expect(successfulWrite.status()).toBe(201);
  expect(successfulWrite.headers()["cache-control"]).toContain("no-store");
  expect(await successfulWrite.json()).toMatchObject({ ok: true, replay: false });

  const protectedEscalation = await page.request.post("/api/admin/roles", {
    headers: { origin: baseOrigin },
    data: {
      personId: mfaPersonId,
      roleKey: "safeguarding_officer",
      scopeType: "organization",
      scopeId: null,
      reason: "E2E technical admin must not self-escalate into safeguarding.",
      endsAt: null,
    },
  });
  expect(protectedEscalation.status()).toBe(403);
  expect(await protectedEscalation.json()).toMatchObject({
    error: { code: "GOVERNANCE_APPROVAL_REQUIRED" },
  });
});
