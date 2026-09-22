import { expect, test, type Page, type Route } from "@playwright/test";

import { makeDatasetOption, makeFinding, makeRunStatus, makeTaskResult } from "../src/test/fixtures";

/** Screenshots of every M9b screen at 1440 and 390, dark and light — CLAUDE.md: "take screenshots,
 * and critique them" before a UI stage is done. They land in test-results/screenshots and are
 * read by a person, not diffed: at this stage they exist to be looked at.
 *
 * M9f: three of SPEC's seven screens (runs home, eval results, report) had only ever been shot in
 * an error/empty state — their populated form had never actually been looked at. Those three mock
 * the API at the network layer via page.route(), using the SAME typed factories (src/test/fixtures)
 * the vitest suite builds its own fixtures from, so a field the generated schema drops here fails a
 * type check rather than silently shipping a screenshot of a shape the real API can't produce. The
 * demo replay's own report is reached without any mock at all — it is folded straight from the
 * committed JSONL, the same as the live-run screens above it. */

const feed = (page: Page) => page.getByRole("list", { name: "Activity feed" });
const pickSpeed = (page: Page, speed: string) => page.locator("label", { hasText: speed }).click();

function fulfillJson(route: Route, json: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
}

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

    test("runs home, populated", async ({ page }, testInfo) => {
      await page.route("**/api/datasets", (route) =>
        fulfillJson(route, [
          makeDatasetOption({ key: "churn", name: "churn" }),
          makeDatasetOption({ key: "credit", name: "credit" }),
          makeDatasetOption({ key: "titanic", name: "titanic" }),
        ]),
      );
      await page.route("**/api/runs", (route) =>
        fulfillJson(route, [
          makeRunStatus({
            thread_id: "5c255737-39db-4a2e-9c11-1a2b3c4d5e01",
            status: "running",
            dataset_ref: "churn",
            goal: "predict churn",
            spent_usd: 12.84,
            budget_usd: 20,
            leaderboard: [
              { experiment_id: "exp-003", mlflow_run_id: null, primary_metric_name: "roc_auc", primary_metric_value: 0.8814, rank: 1 },
            ],
            invalidations: [makeFinding("exp-002")],
            updated_at: new Date().toISOString(),
          }),
          makeRunStatus({
            thread_id: "9a112233-4455-6677-8899-2b3c4d5e6f02",
            status: "completed",
            dataset_ref: "credit",
            goal: "predict default",
            spent_usd: 19.02,
            budget_usd: 20,
            leaderboard: [
              { experiment_id: "exp-007", mlflow_run_id: null, primary_metric_name: "roc_auc", primary_metric_value: 0.7741, rank: 1 },
            ],
            stop_reason: "diminishing_returns",
            updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          }),
          makeRunStatus({
            thread_id: "aa334455-6677-8899-0011-3c4d5e6f7a03",
            status: "failed",
            dataset_ref: "titanic",
            goal: "predict survived",
            spent_usd: 8.1,
            budget_usd: 20,
            leaderboard: [],
            invalidations: [makeFinding("exp-001", "invalidated"), makeFinding("exp-002", "invalidated", { category: "validation_overfitting" })],
            stop_reason: "human_decision",
            error: "docker daemon went away",
            updated_at: new Date(Date.now() - 26 * 3_600_000).toISOString(),
          }),
        ]),
      );
      await page.goto("/runs");
      await expect(page.getByRole("cell", { name: "churn", exact: true })).toBeVisible();
      await shot(page, "1b-runs-home-populated", testInfo);
    });

    test("replay: mid-run, then the budget gate, then the finished run", async ({ page }, testInfo) => {
      await page.goto("/replay/demo-churn-leaky");
      await expect(feed(page).getByRole("listitem").first()).toBeVisible();
      await shot(page, "2-replay-start", testInfo);

      // 4×, not 16×: the recording's own final-gate interrupt lands only ~0.6 REAL seconds after the
      // red-team catch at 16× (9.4 replay-seconds apart in the committed demo-churn-leaky.jsonl) —
      // too tight for this test's pause/inspect/resume sequence under any real load. 4× leaves a
      // real margin (~2.4s). SPEC's 16× itself is exercised by the dedicated speed-picker tests.
      await pickSpeed(page, "4×");
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
      // Switch tabs WHILE STILL PAUSED, then resume — the same lesson as the pause above: doing it
      // in the other order (resume, then switch) leaves a window for the final gate to arrive and
      // its overlay to intercept the tab click, which it reliably did under load.
      if (testInfo.project.name === "mobile") await page.getByRole("tab", { name: "activity" }).click();
      await page.getByRole("button", { name: "Play replay" }).click();

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

    // report_md's real Markdown/model card, read straight off the committed recording — the same
    // path the "View report" link on a finished replay uses, with no mock and no API involved.
    test("the demo replay's own report", async ({ page }, testInfo) => {
      await page.goto("/replay/demo-churn-leaky/report");
      await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
      // Recharts animates each bar in from zero height (~1.5s default) — LeaderboardChart.tsx has
      // no isAnimationActive={false}, and a shot taken immediately catches the bars mid-grow rather
      // than at their real, data-proportional height.
      await page.waitForTimeout(1800);
      await shot(page, "5b-replay-report", testInfo);
    });

    test("eval with no results, and not-found", async ({ page }, testInfo) => {
      await page.goto("/eval");
      await expect(page.getByRole("alert")).toBeVisible();
      await shot(page, "7-eval-error", testInfo);

      await page.goto("/nowhere");
      await expect(page.getByText("Nothing at this address")).toBeVisible();
      await shot(page, "8-not-found", testInfo);
    });

    test("eval results, populated", async ({ page }, testInfo) => {
      // The same combination routes.test.tsx already proved exercises all four ablation panels,
      // not just the per-task table.
      await page.route("**/api/eval", (route) =>
        fulfillJson(route, [
          makeTaskResult({ dataset_ref: "churn", config: "full", primary_metric_value: 0.85 }),
          makeTaskResult({ dataset_ref: "churn", config: "no_red_team", primary_metric_value: 0.99 }),
          makeTaskResult({ dataset_ref: "churn", config: "memory_run_2", first_model_family: "lightgbm" }),
          makeTaskResult({ dataset_ref: "churn", config: "monolith", primary_metric_value: 0.79 }),
          makeTaskResult({ dataset_ref: "churn", config: "uniform_model" }),
        ]),
      );
      await page.goto("/eval");
      await expect(page.getByRole("heading", { name: "ablation: red team on/off" })).toBeVisible();
      // Same entry-animation settle as the report charts below.
      await page.waitForTimeout(1800);
      await shot(page, "7b-eval-populated", testInfo);
    });

    test("report view, populated", async ({ page }, testInfo) => {
      const reportMd = [
        "# Experiment Report — predict churn",
        "",
        "**Stop reason:** target_met  ",
        "**Experiments run:** 4 (4 successful)  ",
        "**Total cost:** $12.84",
        "",
        "## Summary",
        "",
        "Ran 4 experiments on churn for the goal 'predict churn'. Stopped: target_met.",
        "",
        "## Leaderboard",
        "",
        "| rank | experiment | metric | value |",
        "|---|---|---|---|",
        "| 1 | exp-003 | roc_auc | 0.8814 |",
        "| 2 | exp-001 | roc_auc | 0.8642 |",
        "",
        "## Recommendation",
        "",
        "exp-003 is the strongest candidate; promote it.",
        "",
        "## Sign-off",
        "",
        "**APPROVED**",
      ].join("\n");
      const modelCardMd = "# Model Card — predict churn\n\n## Notes\n\nShips as the production model.";
      await page.route("**/api/runs/t-1", (route) =>
        fulfillJson(
          route,
          makeRunStatus({
            thread_id: "t-1",
            status: "completed",
            report_md: reportMd,
            model_card_md: modelCardMd,
            leaderboard: [
              { experiment_id: "exp-003", mlflow_run_id: "abc123", primary_metric_name: "roc_auc", primary_metric_value: 0.8814, rank: 1 },
              { experiment_id: "exp-001", mlflow_run_id: "def456", primary_metric_name: "roc_auc", primary_metric_value: 0.8642, rank: 2 },
            ],
          }),
        ),
      );
      await page.goto("/runs/t-1/report");
      await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
      await page.waitForTimeout(1800);
      await shot(page, "9-report-populated", testInfo);
    });
  });
}
