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

test("viewport metadata preserves user zoom and safe-area support", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Metadata contract only needs one browser engine.");
  await page.goto("/");
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).toContain("width=device-width");
  expect(viewport).toContain("initial-scale=1");
  expect(viewport).toContain("viewport-fit=cover");
  expect(viewport ?? "").not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i);
});

test("keyboard focus remains visibly rendered", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Computed focus proof only needs one engine.");
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  const focusStyle = await skip.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(3);
});

test("reduced-motion preference clamps authored animation and transition durations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Reduced-motion computed-style proof only needs one engine.");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const durations = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.animationDuration = "10s";
    probe.style.animationIterationCount = "99";
    probe.style.transitionDuration = "10s";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = {
      animationDuration: style.animationDuration,
      animationIterationCount: style.animationIterationCount,
      transitionDuration: style.transitionDuration,
    };
    probe.remove();
    return result;
  });
  expect(durations.animationDuration).toBe("0.00001s");
  expect(durations.transitionDuration).toBe("0.00001s");
  expect(durations.animationIterationCount).toBe("1");
});

test("current primary route is programmatically identified and browser history works", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Navigation history proof only needs one engine.");
  await signIn(page);

  const dashboard = page.locator(".sidebar").getByRole("link", { name: "Dashboard" });
  await expect(dashboard).toHaveAttribute("aria-current", "page");

  await page.locator(".sidebar").getByRole("link", { name: "Talent" }).click();
  await expect(page).toHaveURL(/\/applications$/);
  await expect(page.locator(".sidebar").getByRole("link", { name: "Talent" })).toHaveAttribute("aria-current", "page");

  await page.locator(".sidebar").getByRole("link", { name: "Competition" }).click();
  await expect(page).toHaveURL(/\/competition$/);
  await expect(page.locator(".sidebar").getByRole("link", { name: "Competition" })).toHaveAttribute("aria-current", "page");

  await page.goBack();
  await expect(page).toHaveURL(/\/applications$/);
  await expect(page.locator(".sidebar").getByRole("link", { name: "Talent" })).toHaveAttribute("aria-current", "page");

  await page.goForward();
  await expect(page).toHaveURL(/\/competition$/);
  await expect(page.locator(".sidebar").getByRole("link", { name: "Competition" })).toHaveAttribute("aria-current", "page");
});

test("all mobile primary navigation targets remain at least 44 by 44 CSS pixels", async ({ page }, testInfo) => {
  const width = page.viewportSize()?.width ?? 9999;
  test.skip(width > 920, "Mobile target test only applies to mobile/tablet shell.");
  await signIn(page);

  const links = page.locator(".mobile-nav a");
  await expect(links).toHaveCount(5);
  for (let index = 0; index < 5; index += 1) {
    const link = links.nth(index);
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  await expect(page.locator(".mobile-nav").getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  await expectNoPageOverflow(page);
});

test("fixed mobile navigation does not cover end-of-content sentinel", async ({ page }, testInfo) => {
  const width = page.viewportSize()?.width ?? 9999;
  test.skip(width > 920, "Fixed bottom navigation test only applies to the mobile shell.");
  await signIn(page);

  await page.evaluate(() => {
    const sentinel = document.createElement("div");
    sentinel.id = "u0-end-sentinel";
    sentinel.textContent = "End of content";
    sentinel.style.height = "44px";
    document.querySelector("main#main-content")?.append(sentinel);
  });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

  const geometry = await page.evaluate(() => {
    const sentinel = document.querySelector("#u0-end-sentinel")!.getBoundingClientRect();
    const nav = document.querySelector(".mobile-nav")!.getBoundingClientRect();
    return { sentinelBottom: sentinel.bottom, navTop: nav.top };
  });
  expect(geometry.sentinelBottom).toBeLessThanOrEqual(geometry.navTop + 1);
});

test("narrow, reduced-height, and long-content stress layouts remain reachable without page overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Deterministic viewport stress runs once in Chromium.");
  await signIn(page);

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 360, height: 430 },
    { width: 375, height: 500 },
    { width: 390, height: 430 },
    { width: 412, height: 480 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/dashboard");
    await page.evaluate(() => {
      const stress = document.createElement("p");
      stress.id = "u0-long-content";
      stress.textContent = `Player-${"X".repeat(260)}-🎮-Ω-测试`;
      document.querySelector("main#main-content")?.append(stress);
    });
    await expectNoPageOverflow(page);
    await expect(page.locator("#u0-long-content")).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 430 });
  await page.goto("/sign-in");
  await page.getByLabel("Password").focus();
  const submit = page.getByRole("button", { name: "Sign in with password" });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeVisible();
  await expectNoPageOverflow(page);
});

test("authenticated deep links resolve after a valid session exists", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Deep-link proof only needs one engine.");
  await signIn(page);
  for (const route of ["/applications", "/competition", "/studio", "/security"]) {
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(`${route.replace("/", "\\/")}$`));
    await expect(page.locator("main#main-content")).toBeVisible();
  }
});
