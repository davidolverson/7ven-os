import { expect, test } from "@playwright/test";

const email = process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.test";
const password = process.env.E2E_ADMIN_PASSWORD ?? "E2E-Only-Password-2026!";
const privilegedEmail = process.env.E2E_PRIVILEGED_EMAIL ?? "e2e-privileged@example.test";
const privilegedPassword = process.env.E2E_PRIVILEGED_PASSWORD ?? "E2E-Privileged-Password-2026!";
const baseOrigin = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").origin;

async function signIn(
  page: import("@playwright/test").Page,
  credentials: { email: string; password: string } = { email, password },
) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function expectNoPageOverflow(page: import("@playwright/test").Page) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

const validRolePayload = {
  personId: "00000000-0000-4000-8000-000000000001",
  roleKey: "member",
  scopeType: "organization",
  scopeId: null,
  reason: "E2E authorization boundary test only.",
  endsAt: null,
};

test("identity admin does not automatically receive Org authority", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("No staff or member role has been assigned.")).toBeVisible();
  await expect(page.getByText("community", { exact: true })).toBeVisible();

  const response = await page.request.post("/api/admin/roles", {
    headers: { origin: baseOrigin },
    data: validRolePayload,
  });
  expect(response.status()).toBe(403);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await response.json()).toMatchObject({ error: { code: "ACCESS_DENIED" } });
});

test("identity admin browser APIs require origin protection and challenged MFA", async ({ page }) => {
  await signIn(page);

  const listUsers = await page.request.get("/api/auth/admin/list-users?limit=1");
  expect(listUsers.status()).toBe(403);
  expect(listUsers.headers()["cache-control"]).toContain("no-store");
  expect(await listUsers.json()).toMatchObject({
    error: {
      code: "IDENTITY_STRONG_AUTH_REQUIRED",
      message:
        "A verified two-factor session is required for identity administration. Sign in again and complete the second-factor challenge.",
    },
  });

  const crossOrigin = await page.request.post("/api/auth/admin/revoke-user-sessions", {
    headers: { origin: "https://attacker.invalid" },
    data: { userId: "e2e-target-must-not-be-reached" },
  });
  expect(crossOrigin.status()).toBe(403);
  expect(crossOrigin.headers()["cache-control"]).toContain("no-store");
  expect(await crossOrigin.json()).toMatchObject({
    error: { code: "IDENTITY_ORIGIN_NOT_ALLOWED" },
  });

  const nullOrigin = await page.request.post("/api/auth/admin/revoke-user-sessions", {
    headers: { origin: "null" },
    data: { userId: "e2e-target-must-not-be-reached" },
  });
  expect(nullOrigin.status()).toBe(403);
  expect(await nullOrigin.json()).toMatchObject({
    error: { code: "IDENTITY_ORIGIN_NOT_ALLOWED" },
  });

  const revokeSessions = await page.request.post("/api/auth/admin/revoke-user-sessions", {
    headers: { origin: baseOrigin },
    data: { userId: "e2e-target-must-not-be-reached" },
  });
  expect(revokeSessions.status()).toBe(403);
  expect(revokeSessions.headers()["cache-control"]).toContain("no-store");
  expect(await revokeSessions.json()).toMatchObject({
    error: { code: "IDENTITY_STRONG_AUTH_REQUIRED" },
  });
});

test("privileged Org role without 2FA cannot perform protected writes", async ({ page }) => {
  await signIn(page, { email: privilegedEmail, password: privilegedPassword });

  const response = await page.request.post("/api/admin/roles", {
    headers: { origin: baseOrigin },
    data: validRolePayload,
  });

  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({
    error: {
      code: "ACCESS_DENIED",
      message:
        "A verified two-factor session is required for this privileged action. Sign in again and complete the second-factor challenge.",
    },
  });
});

test("protected role writes reject cross-origin requests before mutation", async ({ page }) => {
  await signIn(page);

  const response = await page.request.post("/api/admin/roles", {
    headers: { origin: "https://attacker.invalid" },
    data: validRolePayload,
  });

  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
});

test("normal role-management API cannot grant break-glass", async ({ page }) => {
  await signIn(page);

  const response = await page.request.post("/api/admin/roles", {
    headers: { origin: baseOrigin },
    data: { ...validRolePayload, roleKey: "break_glass" },
  });

  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
});

test("security center is available before Org authority and passkey sign-in stays gated", async ({ page }) => {
  await signIn(page);
  await page.goto("/security");
  await expect(page.getByRole("heading", { name: "Protect privileged access" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up two-factor authentication" })).toBeVisible();

  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: /passkey/i })).toHaveCount(0);
  await expect(page.getByText(/Passkey sign-in remains gated/i)).toBeVisible();
});

test("zero-role identity cannot enumerate access-management records", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/access");
  await expect(page.getByRole("heading", { name: "Access management unavailable" })).toBeVisible();
  await expect(page.getByText("No role data was loaded.")).toBeVisible();
});

test("all primary authenticated navigation destinations resolve", async ({ page }) => {
  await signIn(page);

  for (const route of ["/dashboard", "/applications", "/competition", "/studio", "/security"]) {
    await page.goto(route);
    await expect(page.locator("main#main-content")).toBeVisible();
    await expect(page.getByText(/404|not found/i)).toHaveCount(0);
    await expectNoPageOverflow(page);
  }
});

test("mobile authenticated navigation replaces the desktop sidebar", async ({ page, isMobile }) => {
  await signIn(page);

  if (isMobile || (page.viewportSize()?.width ?? 9999) <= 920) {
    await expect(page.locator(".mobile-nav")).toBeVisible();
    await expect(page.locator(".sidebar")).toBeHidden();
    for (const label of ["Dashboard", "Talent", "Competition", "Studio", "Security"]) {
      await expect(page.locator(".mobile-nav").getByRole("link", { name: label })).toBeVisible();
    }
    await expectNoPageOverflow(page);
  } else {
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".mobile-nav")).toBeHidden();
  }
});

test("empty states are explicit rather than broken", async ({ page }) => {
  await signIn(page);

  await page.goto("/applications");
  await expect(page.getByText(/No application is linked|Application queue/)).toBeVisible();

  await page.goto("/competition");
  await expect(page.getByText("No competition events are available.")).toBeVisible();

  await page.goto("/studio");
  await expect(page.getByText("No creator assignments.")).toBeVisible();
});
