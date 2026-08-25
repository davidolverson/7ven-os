import { expect, test } from "@playwright/test";

const email = process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.test";
const password = process.env.E2E_ADMIN_PASSWORD ?? "E2E-Only-Password-2026!";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
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

test("identity admin does not automatically receive Org authority", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("No staff or member role has been assigned.")).toBeVisible();
  await expect(page.getByText("community", { exact: true })).toBeVisible();
});

test("all primary authenticated navigation destinations resolve", async ({ page }) => {
  await signIn(page);

  for (const route of ["/dashboard", "/applications", "/competition", "/studio"]) {
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
    for (const label of ["Dashboard", "Talent", "Competition", "Studio"]) {
      await expect(page.locator(".mobile-nav").getByRole("link", { name: label })).toBeVisible();
    }
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
