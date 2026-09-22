import { expect, test, type Page } from "@playwright/test";

/** Screenshots of every M9b screen at 1440 and 390, dark and light — CLAUDE.md: "take screenshots,
 * and critique them" before a UI stage is done. They land in test-results/screenshots and are
 * read by a person, not diffed: at this stage they exist to be looked at. */

const feed = (page: Page) => page.getByRole("list", { name: "Activity feed" });
const pickSpeed = (page: Page, speed: string) => page.locator("label", { hasText: speed }).click();

/** Below the `frame:` breakpoint the dock (leaderboard, budget, audit) is `display: none` — not
 * merely CSS-hidden in a way a role-based locator still matches — until its own mobile tab is
 * selected (AppFrame.tsx's docstring: "mobile keeps a 44px sticky instrument bar ... and moves
 * everything else into tabs"). The tab strip itself does not exist in the desktop accessibility
 * tree at all (`frame:hidden` on its container), so this is a no-op there. */
async function showDockTab(page: Page, testInfo: { project: { name: string } }, tab: "board" | "audit") {
  if (testInfo.project.name !== "mobile") return;
  await page.getByRole("tab", { name: tab }).click();
}

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
      // See the drawer's own note below: `toBeVisible` does not wait out GateDialog's entry fade.
      await page.waitForTimeout(400);
      await shot(page, "3-replay-budget-gate", testInfo);

      await page.getByRole("button", { name: "Approve" }).click();
      await expect(feed(page).getByText("red_team: 3 audited, 3 invalidated")).toBeVisible({ timeout: 15_000 });
      // Paused as the very next action, BEFORE even taking the screenshot below — the whole demo
      // run completes in well under 20s at 16×, and a screenshot capture alone was enough real
      // time for the final gate to arrive first otherwise. Once paused, its own full-screen
      // overlay can no longer race ahead and intercept the click meant for the audit row
      // (RunView.tsx: a gate always wins, and closes the drawer if one becomes pending).
      await page.getByRole("button", { name: "Pause replay" }).click();
      // On mobile, §8's moment lives on the "audit" tab, not "activity" — switch before the shot
      // so the screenshot actually shows what it is named for.
      await showDockTab(page, testInfo, "audit");
      await shot(page, "4-replay-red-team", testInfo);

      await page.getByRole("button", { name: /^Open experiment/ }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      // `toBeVisible` only checks that the element has a box and isn't display:none/hidden — it
      // does not wait out Dialog.tsx's own entry fade (320ms, starting from opacity 0), so a shot
      // taken immediately would catch it mid-fade rather than settled.
      await page.waitForTimeout(400);
      await shot(page, "4b-replay-experiment-drawer", testInfo);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Play replay" }).click();
      if (testInfo.project.name === "mobile") await page.getByRole("tab", { name: "activity" }).click();

      await expect(page.getByRole("heading", { name: "final gate" })).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);
      await shot(page, "4c-replay-final-gate", testInfo);
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
