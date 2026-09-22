import { expect, test, type Page } from "@playwright/test";

/** Screenshots of every M9b screen at 1440 and 390, dark and light — CLAUDE.md: "take screenshots,
 * and critique them" before a UI stage is done. They land in test-results/screenshots and are
 * read by a person, not diffed: at this stage they exist to be looked at. */

const feed = (page: Page) => page.getByRole("list", { name: "Activity feed" });
const pickSpeed = (page: Page, speed: string) => page.locator("label", { hasText: speed }).click();

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("foundry.theme", value), theme);
    });

    const shot = async (page: Page, name: string, testInfo: { project: { name: string } }) => {
      await page.screenshot({
        path: `test-results/screenshots/${testInfo.project.name}-${theme}-${name}.png`,
        fullPage: false,
      });
    };

    test("runs home, with the API down", async ({ page }, testInfo) => {
      await page.goto("/runs");
      await expect(page.getByRole("alert")).toBeVisible();
      await shot(page, "1-runs-home-api-down", testInfo);
    });

    test("replay: mid-run, then the budget gate, then the finished run", async ({ page }, testInfo) => {
      await page.goto("/replay/demo-churn-leaky");
      await expect(feed(page).getByRole("listitem").first()).toBeVisible();
      await shot(page, "2-replay-start", testInfo);

      await pickSpeed(page, "16×");
      await expect(page.getByRole("heading", { name: "budget gate" })).toBeVisible({ timeout: 15_000 });
      await shot(page, "3-replay-budget-gate", testInfo);

      await page.getByRole("button", { name: "Approve" }).click();
      await expect(feed(page).getByText("red_team: 3 audited, 3 invalidated")).toBeVisible({ timeout: 15_000 });
      await shot(page, "4-replay-red-team", testInfo);

      await expect(page.getByRole("heading", { name: "final gate" })).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: "Approve" }).click();
      await expect(feed(page).getByRole("listitem")).toHaveCount(33);
      await shot(page, "5-replay-complete", testInfo);
    });

    test("a recording that is missing", async ({ page }, testInfo) => {
      await page.goto("/replay/never-recorded");
      await expect(page.getByRole("alert")).toBeVisible();
      await shot(page, "6-replay-missing", testInfo);
    });

    test("eval with no results, and not-found", async ({ page }, testInfo) => {
      await page.goto("/eval");
      await expect(page.getByRole("alert")).toBeVisible();
      await shot(page, "7-eval-error", testInfo);

      await page.goto("/nowhere");
      await expect(page.getByText("Nothing at this address")).toBeVisible();
      await shot(page, "8-not-found", testInfo);
    });
  });
}
