import { expect, test } from "@playwright/test";

async function expectNoPageOverflow(page: import("@playwright/test").Page) {
  const dimensions = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          className: typeof element.className === "string" ? element.className : "",
          text: (element.textContent ?? "").trim().slice(0, 120),
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          minWidth: style.minWidth,
          widthStyle: style.width,
          whiteSpace: style.whiteSpace,
          overflowWrap: style.overflowWrap,
          wordBreak: style.wordBreak,
        };
      })
      .filter((entry) => entry.right > clientWidth + 1 || entry.left < -1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 12);

    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders,
    };
  });

  expect(
    dimensions.scrollWidth,
    `Page overflow diagnostics: ${JSON.stringify(dimensions)}`,
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

const invalidFields = [
  "displayName",
  "email",
  "requestedTrack",
  "gameTitle",
  "goals",
  "experience",
  "portfolioUrls",
] as const;

test("server validation errors are programmatically associated with every invalid application field", async ({ page }) => {
  await page.goto("/apply");
  await expect(page.getByRole("button", { name: "Submit application" })).toBeVisible();

  await page.getByLabel("Display name").fill("x");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel("What are you trying to become or accomplish?").fill("short");
  await page.getByLabel("What have you already done?").fill("short");
  await page.getByLabel(/Portfolio \/ clips \/ profiles/i).fill("not-a-url");
  await page.locator("#gameTitle").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "G".repeat(81);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/applications") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Submit application" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(422);

  for (const field of invalidFields) {
    const control = page.locator(`#${field}`);
    const errorId = `${field}-error`;
    await expect(control).toHaveAttribute("aria-invalid", "true");
    await expect(control).toHaveAttribute("aria-describedby", errorId);
    const error = page.locator(`#${errorId}`);
    await expect(error).toBeVisible();
    await expect(error).not.toHaveText("");
  }

  await expectNoPageOverflow(page);
});

test("application form remains reachable in reduced-height mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 430 });
  await page.goto("/apply");
  const portfolio = page.getByLabel(/Portfolio \/ clips \/ profiles/i);
  await portfolio.focus();
  const submit = page.getByRole("button", { name: "Submit application" });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeVisible();
  const box = await submit.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await expectNoPageOverflow(page);
});
