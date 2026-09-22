import { expect, test, type Page } from "@playwright/test";

/** SPEC M9's verification path, on replay mode: start → feed streams → budget gate appears →
 * approve → red-team finding shows → final sign-off → the run completes. (The report renders in
 * M9e; this stage stops at the run completing.) The API is NOT running: every assertion here holds
 * with nothing listening on :8000, and the first test proves no request was even attempted. */

const feed = (page: Page) => page.getByRole("list", { name: "Activity feed" });

/** The 16× radio is visually hidden, so click its label — as a person would. */
const pickSpeed = (page: Page, speed: string) => page.locator("label", { hasText: speed }).click();

test("the demo replay runs end to end with the API stopped", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api")) apiRequests.push(request.url());
  });

  await page.goto("/replay/demo-churn-leaky");
  await expect(feed(page)).toBeVisible();
  await pickSpeed(page, "16×");

  await expect(page.getByRole("heading", { name: "budget gate" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Play replay" })).toBeDisabled();
  await page.getByRole("button", { name: "Approve" }).click();

  await expect(feed(page).getByText("red_team: 3 audited, 3 invalidated")).toBeVisible({ timeout: 15_000 });

  await expect(page.getByRole("heading", { name: "final gate" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Approve" }).click();

  await expect(feed(page).getByText("run complete")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("replay ended").locator("visible=true").first()).toBeVisible();
  await expect(feed(page).getByRole("listitem")).toHaveCount(33);

  expect(apiRequests, "replay mode must make zero API calls").toEqual([]);
});

test("a rejected gate is called out, and playback carries on", async ({ page }) => {
  await page.goto("/replay/demo-churn-leaky");
  await expect(feed(page)).toBeVisible();
  await pickSpeed(page, "16×");
  await expect(page.getByRole("heading", { name: "budget gate" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Reject" }).click();

  await expect(page.getByText(/You rejected the budget gate; the recording approved it/)).toBeVisible();
  await expect(feed(page).getByText("red_team: 3 audited, 3 invalidated")).toBeVisible({ timeout: 15_000 });
});

test("pausing freezes the feed", async ({ page }) => {
  await page.goto("/replay/demo-churn-leaky");
  await expect(feed(page)).toBeVisible();
  await page.getByRole("button", { name: "Pause replay" }).click();
  const before = await feed(page).getByRole("listitem").count();
  await page.waitForTimeout(1500);
  expect(await feed(page).getByRole("listitem").count()).toBe(before);
});

test("a recording that does not exist names the fix", async ({ page }) => {
  await page.goto("/replay/never-recorded");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText('No recorded run named "never-recorded"');
  await expect(alert).toContainText("make record-replay");
});

/** Playwright's Chromium emulates `prefers-color-scheme: light` unless told otherwise, so each
 * theme test pins the system preference it is about. Dark is primary (docs/design-plan.md §3):
 * the system preference is honoured only when the viewer has not chosen. */
test.describe("theme", () => {
  test.describe("on a system that prefers dark", () => {
    test.use({ colorScheme: "dark" });

    test("starts dark, switches, and survives a reload", async ({ page }) => {
      await page.goto("/replay/demo-churn-leaky");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.getByRole("button", { name: "Switch to light theme" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    });
  });

  test.describe("on a system that prefers light", () => {
    test.use({ colorScheme: "light" });

    test("follows the system until the viewer chooses", async ({ page }) => {
      await page.goto("/replay/demo-churn-leaky");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); // the choice beats the system
    });
  });
});
