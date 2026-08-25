import { expect, test } from "@playwright/test";

async function expectNoPageOverflow(page: import("@playwright/test").Page) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test("landing is brand-neutral and does not leak the old pitch", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Opportunity");
  await expect(page.getByText(/Built by David, for 7VEN/i)).toHaveCount(0);
  await expect(page.getByText(/business@7ven\.club/i)).toHaveCount(0);
  await expect(page.getByText(/JeffTheMVP/i)).toHaveCount(0);
  await expectNoPageOverflow(page);
});

test("production response exposes hardened security headers", async ({ page }) => {
  const response = await page.goto("/");
  expect(response).not.toBeNull();
  const headers = response!.headers();

  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["strict-transport-security"]).toContain("max-age=31536000");
  expect(headers["permissions-policy"]).toContain("camera=()");

  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  if (process.env.CI) {
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toMatch(/nonce-[A-Za-z0-9+/=]+/);
  }
});

test("application intake is visibly and server-side closed by default", async ({ page, request }) => {
  await page.goto("/apply");
  await expect(page.getByText("Public applications are not open yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit application" })).toHaveCount(0);
  await expectNoPageOverflow(page);

  const response = await request.post("/api/applications", {
    headers: { origin: "http://127.0.0.1:3000" },
    data: {
      displayName: "Test User",
      email: "test@example.com",
      requestedTrack: "competitive",
      goals: "This payload should never be accepted while intake is closed.",
      experience: "This payload should never be accepted while intake is closed.",
      portfolioUrls: [],
    },
  });

  expect(response.status()).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: "APPLICATION_INTAKE_CLOSED" },
  });
});

test("skip link and keyboard focus are usable", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await skip.press("Enter");
  await expect(page.locator("#main-content")).toBeVisible();
});

test("mobile public routes do not overflow", async ({ page }) => {
  for (const route of ["/", "/apply", "/sign-in", "/two-factor"]) {
    await page.goto(route);
    await expectNoPageOverflow(page);
  }
});

test("unauthenticated member route redirects to sign in", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Member access" })).toBeVisible();
});
