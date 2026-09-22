import { expect, test, type Page } from "@playwright/test";

/** SPEC M9's verification path, on replay mode: start → feed streams → budget gate appears →
 * approve → red-team finding shows → final sign-off → the run completes. (The report renders in
 * M9e; this stage stops at the run completing.) The API is NOT running: every assertion here holds
 * with nothing listening on :8000, and the first test proves no request was even attempted. */

const feed = (page: Page) => page.getByRole("list", { name: "Activity feed" });

/** The 16× radio is visually hidden, so click its label — as a person would. */
const pickSpeed = (page: Page, speed: string) => page.locator("label", { hasText: speed }).click();

/** Below the `frame:` breakpoint, the dock (leaderboard, budget, audit) lives behind the "board"
 * and "audit" mobile tabs (AppFrame.tsx's docstring: "mobile keeps a 44px sticky instrument bar
 * ... and moves everything else into tabs") — the tab strip itself does not exist in the desktop
 * accessibility tree at all (`frame:hidden` on its container), so this is a no-op there. */
async function showDockTab(page: Page, testInfo: { project: { name: string } }, tab: "board" | "audit") {
  if (testInfo.project.name !== "mobile") return;
  await page.getByRole("tab", { name: tab }).click();
}

test("the demo replay runs end to end with the API stopped", async ({ page }, testInfo) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api")) apiRequests.push(request.url());
  });

  await page.goto("/replay/demo-churn-leaky");
  await expect(feed(page)).toBeVisible();
  await pickSpeed(page, "16×");

  // GateDialog.tsx is a real modal (Radix's hideOthers) — everything outside it, aria-live
  // regions excepted, is aria-hidden while it is open (§6: "a gate is answered, not dismissed"),
  // so `includeHidden` is needed to see the transport button at all here. `.click()` on Approve
  // waits out its own 400ms arm on its own — Playwright auto-waits for a control to be enabled.
  await expect(page.getByRole("heading", { name: "budget gate" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Play replay", includeHidden: true })).toBeDisabled();
  await page.getByRole("button", { name: "Approve" }).click();

  await expect(feed(page).getByText("red_team: 3 audited, 3 invalidated")).toBeVisible({ timeout: 15_000 });
  await showDockTab(page, testInfo, "audit");
  // §8's moment: SOME category renders at display size — distinct from the same word in the audit
  // strip's own compact rows (AuditPanel.tsx's CompactRow names a category too, just not at that
  // size). Three invalidations land in one red_team pass here, and the choreography animates only
  // the first of a batch (useInvalidationChoreography.ts) — which one is not asserted, only that
  // the moment happens at all.
  await expect(page.locator(".text-display")).toBeVisible();

  // A GateDialog is a full-screen portal, reachable regardless of which mobile tab is selected
  // (it is not inside any tabpanel) — no tab switch needed to reach or answer it.
  await expect(page.getByRole("heading", { name: "final gate" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Approve" }).click();

  // Below the `frame:` breakpoint the feed is a separate tab from "audit" (switched to above) —
  // switch back to it now that there is no gate in the way.
  if (testInfo.project.name === "mobile") await page.getByRole("tab", { name: "activity" }).click();

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

  // §6: "Reject requires a note" — inline validation, not a disabled control (GateDialog.tsx).
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("A rejection needs a note.")).toBeVisible();
  await page.getByLabel("note").fill("not ready");
  await page.getByRole("button", { name: "Reject" }).click();

  await expect(page.getByText(/You rejected the budget gate; the recording approved it/)).toBeVisible();
  await expect(feed(page).getByText("red_team: 3 audited, 3 invalidated")).toBeVisible({ timeout: 15_000 });
});

test("the experiment drawer opens from the leaderboard with all four tabs populated", async ({ page }, testInfo) => {
  await page.goto("/replay/demo-churn-leaky");
  await expect(feed(page)).toBeVisible();
  await pickSpeed(page, "16×");
  await expect(page.getByRole("heading", { name: "budget gate" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Approve" }).click();

  // Same sync point as the "runs end to end" test above, since it is proven reliable there: below
  // the `frame:` breakpoint a role-based locator cannot match anything in the dock until its tab
  // is actually shown (`display: none`, not merely CSS-hidden in a way `getByRole` still sees), so
  // waiting on an "Open experiment" button directly — before switching to its tab — never
  // resolves. Switch tabs, then pause IMMEDIATELY (before any further assertion), to leave the
  // least possible window for the final gate to race ahead and arrive before the drawer does
  // (RunView.tsx: a gate always wins, and closes the drawer if one becomes pending mid-inspection)
  // — the whole demo run completes in well under 20s at 16×.
  await expect(feed(page).getByText("red_team: 3 audited, 3 invalidated")).toBeVisible({ timeout: 15_000 });
  await showDockTab(page, testInfo, "audit");
  await page.getByRole("button", { name: "Pause replay" }).click();

  const firstRow = page.getByRole("button", { name: /^Open experiment/ }).first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();

  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  for (const tabName of ["spec", "code", "output", "attempts"]) {
    await drawer.getByRole("tab", { name: tabName }).click();
    // Even against a pre-M9d replay (missing spec/attempt_history), the panel renders a "not
    // recorded" message rather than nothing — it is never truly empty.
    await expect(drawer.getByRole("tabpanel")).toBeVisible();
  }

  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
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
