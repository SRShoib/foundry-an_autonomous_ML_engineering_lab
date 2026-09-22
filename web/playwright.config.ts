import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the Vite dev server with the API DELIBERATELY NOT RUNNING: the demo
 * replay must work with zero API calls (SPEC M9, CLAUDE.md "develop and test against replay mode,
 * not live runs"), and that is only proven if nothing is listening on :8000.
 *
 * Two viewports, the two the design is specified at: 1440 (three-column frame) and 390 (instrument
 * bar and tabs). The full run-to-report script and screenshot critique are M9f; M9b's specs prove
 * the harness, the replay path, and give the screenshots its stage is critiqued with.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  // replayRunSource schedules ticks against the real wall clock (by design: see its own docstring
  // on why elapsed() is recomputed from performance.now() rather than accumulated timer intervals).
  // That self-heals against a SLOW tick, but a worker count sized to this machine's core count runs
  // enough concurrent Chromium instances to starve the main thread badly enough that 15s assertion
  // budgets expire before a 16x replay reaches its next gate. CI gets one worker; local keeps some
  // parallelism without full oversubscription.
  workers: process.env["CI"] ? 1 : 4,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
