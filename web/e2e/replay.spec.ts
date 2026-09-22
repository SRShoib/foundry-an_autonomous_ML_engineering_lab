import { expect, test, type Page } from "@playwright/test";

/** SPEC M9's verification path, on replay mode, in full: start → feed streams → budget gate
 * appears → approve → red-team finding shows → final sign-off → the report renders. The API is NOT
 * running throughout: every assertion here holds with nothing listening on :8000, and the first
 * test proves no request was even attempted — including for the report, which M9f made reachable
 * from a finished replay without ever touching the live API (ReplayReportRoute.tsx folds it
 * straight out of the same committed JSONL the player itself reads). */

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
  // 4×, not 16×: the recording's own final-gate interrupt lands only 9.4 replay-seconds after the
  // red-team catch (frames 12 and 29 of the committed demo-churn-leaky.jsonl) — 0.6 REAL seconds at
  // 16×, too tight for this test's own click-pause-click-resume sequence to reliably win against it
  // once anything else is contending for the CPU. 4× leaves ~2.4s, a real margin. SPEC's 16× speed
  // itself is exercised elsewhere (the speed-picker and theme tests), so nothing goes unverified.
  await pickSpeed(page, "4×");

  // GateDialog.tsx is a real modal (Radix's hideOthers) — everything outside it, aria-live
  // regions excepted, is aria-hidden while it is open (§6: "a gate is answered, not dismissed"),
  // so `includeHidden` is needed to see the transport button at all here. `.click()` on Approve
  // waits out its own 400ms arm on its own — Playwright auto-waits for a control to be enabled.
  await expect(page.getByRole("heading", { name: "budget gate" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Play replay", includeHidden: true })).toBeDisabled();
  await page.getByRole("button", { name: "Approve" }).click();

  await expect(feed(page).getByText("red_team: 3 audited, 3 invalidated")).toBeVisible({ timeout: 15_000 });
  // Pause BEFORE switching tabs, not after: the replay clock is frozen the instant this click
  // lands, so there is no window left for the final gate to race ahead of the tab switch below
  // (proven safe by screenshots.spec.ts's identical ordering; a mobile tab switch alone, with
  // nothing pausing first, was seen to lose exactly this race under load — the transport controls
  // live in the top bar, not inside a tab panel, so "Pause replay" is reachable regardless of tab).
  await page.getByRole("button", { name: "Pause replay" }).click();
  await showDockTab(page, testInfo, "audit");
  // §8's moment: SOME category renders at display size — distinct from the same word in the audit
  // strip's own compact rows (AuditPanel.tsx's CompactRow names a category too, just not at that
  // size). Three invalidations land in one red_team pass here, and the choreography animates only
  // the first of a batch (useInvalidationChoreography.ts) — which one is not asserted, only that
  // the moment happens at all.
  await expect(page.locator(".text-display")).toBeVisible();

  // Switch back to "activity" WHILE STILL PAUSED — free of any race, since nothing can advance —
  // then resume. Only after this is the final gate free to arrive at any moment.
  if (testInfo.project.name === "mobile") await page.getByRole("tab", { name: "activity" }).click();
  await page.getByRole("button", { name: "Play replay" }).click();

  // A GateDialog is a full-screen portal, reachable regardless of which mobile tab is selected
  // (it is not inside any tabpanel) — no tab switch needed to reach or answer it.
  await expect(page.getByRole("heading", { name: "final gate" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Approve" }).click();

  await expect(feed(page).getByText("run complete")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("replay ended").locator("visible=true").first()).toBeVisible();
  await expect(feed(page).getByRole("listitem")).toHaveCount(33);

  // SPEC's last step: "final sign-off → report renders." Follows the "View report" link RunView
  // shows once report_md exists (RunView.tsx), rather than navigating there directly, so this also
  // proves the link itself is offered at the right moment.
  await page.getByRole("link", { name: "View report" }).click();
  await expect(page).toHaveURL(/\/replay\/demo-churn-leaky\/report$/);
  // The hero metric and a `##` heading from the recording's OWN report_md, not a fixture's.
  await expect(page.locator(".text-display")).toHaveText("0.7262");
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
  await expect(page.locator(".recharts-bar-rectangle")).not.toHaveCount(0);
  // The model card appendix, appended below report_md (ReportBody.tsx).
  await expect(page.getByText("Winning experiment:")).toBeVisible();

  expect(apiRequests, "replay mode must make zero API calls, including for the report").toEqual([]);
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
  // 4×, not 16×: see the "runs end to end" test's own note — the recording's final-gate interrupt
  // lands only 0.6 REAL seconds after the red-team catch at 16×, too tight for a pause-then-inspect
  // sequence to reliably win under any real load. 4× leaves a real margin (~2.4s).
  await pickSpeed(page, "4×");
  await expect(page.getByRole("heading", { name: "budget gate" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Approve" }).click();

  // Same sync point as the "runs end to end" test above, since it is proven reliable there: below
  // the `frame:` breakpoint a role-based locator cannot match anything in the dock until its tab
  // is actually shown (`display: none`, not merely CSS-hidden in a way `getByRole` still sees), so
  // waiting on an "Open experiment" button directly — before switching to its tab — never
  // resolves. PAUSE FIRST, then switch tabs: pausing freezes the replay clock immediately, leaving
  // no window at all for the final gate to race ahead and arrive before the drawer does (RunView.tsx:
  // a gate always wins, and closes the drawer if one becomes pending mid-inspection). Switching tabs
  // before pausing was tried first and left exactly that window open — under any real load, the
  // final gate reliably won the race and its overlay intercepted the tab click.
  await expect(feed(page).getByText("red_team: 3 audited, 3 invalidated")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Pause replay" }).click();
  await showDockTab(page, testInfo, "audit");

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

/** design-plan.md §7: "prefers-reduced-motion: reduce ... the red-team sequence becomes a single
 * state change with the connector drawn statically. No motion is removed silently; the information
 * each moment carries is always still present." Only unit-tested before M9f (useInvalidationChoreography,
 * useAnimatedNumber, GateDialog's own arm) — never walked end to end. This proves the full SPEC path
 * still works under `prefers-reduced-motion: reduce`, and that §8's connector (a real information
 * carrier — it says which leaderboard row maps to which audit entry) still renders, just without
 * the phased choreography. */
test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the full replay path works, and the red-team connector still renders statically", async ({ page }, testInfo) => {
    await page.goto("/replay/demo-churn-leaky");
    await expect(feed(page)).toBeVisible();
    await pickSpeed(page, "4×");

    await expect(page.getByRole("heading", { name: "budget gate" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Approve" }).click();

    await expect(feed(page).getByText("red_team: 3 audited, 3 invalidated")).toBeVisible({ timeout: 15_000 });
    if (testInfo.project.name === "mobile") await page.getByRole("tab", { name: "audit" }).click();
    // §8's category, at display size, present immediately, not mid-sequence.
    await expect(page.locator(".text-display")).toBeVisible();
    // The connector is a genuinely vertical line here (the leaderboard slot sits directly above its
    // audit entry), so its own geometric bounding box is zero-WIDTH — Playwright's `toBeVisible`
    // treats that as "hidden" regardless of the 2px stroke a person actually sees (confirmed by eye
    // against a real render), so this asserts it rendered at all rather than fighting that heuristic.
    await expect(page.locator(".stroke-team-redteam")).toBeAttached();

    await expect(page.getByRole("heading", { name: "final gate" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Approve" }).click();
    if (testInfo.project.name === "mobile") await page.getByRole("tab", { name: "activity" }).click();
    await expect(feed(page).getByText("run complete")).toBeVisible({ timeout: 15_000 });
  });
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
