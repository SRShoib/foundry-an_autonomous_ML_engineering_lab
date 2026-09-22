import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders, AppRoutes } from "../App";
import { createApiClient } from "../api/client";
import { createQueryClient } from "../api/queryClient";
import { demoReplayText } from "../test/demoReplay";
import { fakeApi, TEST_BASE_URL, type FakeRoutes } from "../test/fakeApi";
import { makeDatasetOption, makeEvent, makeRunStatus, makeTaskResult } from "../test/fixtures";
import { sseBody, sseText } from "../test/sseBody";

/** The console's whole vertical slice in jsdom: routes, providers, the replay player against the
 * REAL committed recording, and the live stream against a fake API. Only the network is faked. */

function renderAt(path: string, routes: FakeRoutes = {}, { strict = false } = {}) {
  const fake = fakeApi(routes);
  // The app calls the global fetch: a recording is served from /replays (a static file), everything
  // else is the API. Relative URLs are made absolute because Node's Request cannot parse them.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (raw.startsWith("/replays/demo-churn-leaky.jsonl")) {
      return new Response(demoReplayText(), { status: 200 });
    }
    if (raw.startsWith("/replays/")) {
      return new Response("<!doctype html><html></html>", { status: 200 }); // the SPA fallback
    }
    return fake.fetch(new Request(new URL(raw, "http://api.test"), init));
  });

  const tree = (
    <AppProviders
      queryClient={createQueryClient()}
      apiClient={createApiClient({ baseUrl: TEST_BASE_URL, fetch: fake.fetch })}
    >
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { fake };
}

beforeEach(() => {
  document.documentElement.setAttribute("data-theme", "dark");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const feed = () => screen.findByRole("list", { name: "Activity feed" }, { timeout: 4000 });
const slow = { timeout: 5000 } as const;

/** Every "runs home" test renders StartRunPanel, which calls useDatasets() on mount — routed
 * here so a test that omits it doesn't fall through to fakeApi's 500-and-retry path. */
const withDatasets: FakeRoutes = { "GET /datasets": () => ({ json: [makeDatasetOption()] }) };

/** GateDialog.tsx's 400ms arm: Approve is disabled until it fills. Polls for real — this suite
 * uses real timers throughout, not fake ones. */
async function waitForArmed() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(), slow);
}

/** Waits for a feed ROW with this text. Queries are scoped to the list on purpose: the sr-only live
 * region announces the same summary, so an unscoped findByText sees two matches — and findBy*
 * quietly retries on "multiple elements" until it times out, which reads as a hang. */
async function inFeed(text: string) {
  await waitFor(
    () => {
      const list = screen.getByRole("list", { name: "Activity feed" });
      expect(within(list).getByText(text)).toBeInTheDocument();
    },
    slow,
  );
}

describe("replay of the committed demo", () => {
  it(
    "plays through the budget gate, the red-team catch and the final gate to the end",
    async () => {
      const user = userEvent.setup();
      renderAt("/replay/demo-churn-leaky");

      await feed();
      expect(screen.getByText("dataset")).toBeInTheDocument();
      expect(screen.getByText("churn_leaky")).toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: "16×" }));

      // the budget gate: the run has stopped and is waiting for a person. GateDialog.tsx is a
      // real modal (Radix's `hideOthers`, "we should not hide aria-live elements") — everything
      // outside it, aria-live regions excepted, is aria-hidden while it is open, by design (§6:
      // "a gate is answered, not dismissed"), so the transport button needs `hidden: true` to be
      // queryable at all here.
      await screen.findByRole("heading", { name: "budget gate" }, slow);
      expect(screen.getByRole("status", { name: "" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Play replay", hidden: true })).toBeDisabled();
      await waitForArmed();
      await user.click(screen.getByRole("button", { name: "Approve" }));

      // the moment the whole product is built around: the red team overruling the experiments
      await inFeed("red_team: 3 audited, 3 invalidated");

      await screen.findByRole("heading", { name: "final gate" }, slow);
      await waitForArmed();
      await user.click(screen.getByRole("button", { name: "Approve" }));

      // shown in the top bar AND the mobile instrument bar (jsdom applies no CSS to hide either)
      expect(await screen.findAllByText("replay ended", {}, slow)).not.toHaveLength(0);
      // The source has finished, but the feed releases its last events on its next 100ms flush
      // (useEventFeed) — the batching working as designed — so wait for the screen to catch up.
      await waitFor(() => {
        const list = screen.getByRole("list", { name: "Activity feed" });
        expect(within(list).getAllByRole("listitem")).toHaveLength(33);
      }, slow);
      await inFeed("run complete");
      expect(screen.getAllByText("completed").length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    },
    20_000,
  );

  it(
    "says so plainly when the operator rejects what the recording approved, and carries on",
    async () => {
      const user = userEvent.setup();
      renderAt("/replay/demo-churn-leaky");
      await feed();
      await user.click(screen.getByRole("radio", { name: "16×" }));
      await screen.findByRole("heading", { name: "budget gate" }, slow);

      // §6: "Reject requires a note."
      await user.type(screen.getByLabelText("note"), "not ready");
      await user.click(screen.getByRole("button", { name: "Reject" }));

      expect(await screen.findByText(/You rejected the budget gate; the recording approved it/)).toBeInTheDocument();
      await inFeed("red_team: 3 audited, 3 invalidated");
    },
    20_000,
  );

  it(
    "offers a way to the report only once the run has produced one",
    async () => {
      const user = userEvent.setup();
      renderAt("/replay/demo-churn-leaky");
      await feed();
      expect(screen.queryByRole("link", { name: "View report" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: "16×" }));
      await screen.findByRole("heading", { name: "budget gate" }, slow);
      await waitForArmed();
      await user.click(screen.getByRole("button", { name: "Approve" }));
      await inFeed("red_team: 3 audited, 3 invalidated");
      await screen.findByRole("heading", { name: "final gate" }, slow);
      await waitForArmed();
      await user.click(screen.getByRole("button", { name: "Approve" }));
      await inFeed("run complete");

      expect(await screen.findByRole("link", { name: "View report" }, slow)).toHaveAttribute(
        "href",
        "/replay/demo-churn-leaky/report",
      );
    },
    20_000,
  );

  it("names the fix when there is no such recording", async () => {
    renderAt("/replay/never-recorded");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('No recorded run named "never-recorded"');
    expect(alert).toHaveTextContent("make record-replay");
    expect(alert).not.toHaveTextContent("make api"); // a missing FILE is not the API being down
  });

  it("shows the frame's skeleton while the recording loads, so nothing reflows", () => {
    renderAt("/replay/demo-churn-leaky");
    expect(screen.getByRole("heading", { name: "activity" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "budget" })).toBeInTheDocument();
  });

  it("survives React StrictMode's mount, unmount, remount", async () => {
    renderAt("/replay/demo-churn-leaky", {}, { strict: true });
    const list = await feed();
    const before = within(list).getAllByRole("listitem").length;
    expect(before).toBeGreaterThan(0);
    // no duplicated frames: sequence numbers are strictly increasing
    const seqs = within(list)
      .getAllByRole("listitem")
      .map((li) => Number(li.textContent?.slice(0, 3)));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe("a live run", () => {
  const events = Array.from({ length: 4 }, (_, i) => makeEvent(i, { summary: `live event ${i}` }));

  it("streams its events and settles when the run completes", { timeout: 15_000 }, async () => {
    renderAt("/runs/t-1", {
      "GET /runs/t-1/events": () => ({ body: sseBody(sseText(events)) }),
      "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "completed", spent_usd: 0.32, budget_usd: 1 }) }),
    });

    await feed();
    await inFeed("live event 3");
    expect((await screen.findAllByText("stream ended", {}, slow)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("completed").length).toBeGreaterThan(0);
    expect(screen.queryByRole("radio", { name: "16×" })).not.toBeInTheDocument(); // no transport when live
  });

  it("shows the API's message verbatim when the run does not exist", async () => {
    renderAt("/runs/nope", {
      "GET /runs/nope/events": () => ({ status: 404, json: { detail: "unknown thread_id 'nope'" } }),
    });
    const alert = await screen.findByRole("alert", {}, slow);
    expect(alert).toHaveTextContent("The event stream failed");
    expect(alert).toHaveTextContent("unknown thread_id 'nope'");
  });

  it("carries a failed run's own error message onto the screen", async () => {
    renderAt("/runs/t-1", {
      "GET /runs/t-1/events": () => ({ body: sseBody(sseText(events)) }),
      "GET /runs/t-1": () => ({ json: makeRunStatus({ status: "failed", error: "docker daemon went away" }) }),
    });
    const alert = await screen.findByText("docker daemon went away", {}, slow);
    expect(alert).toBeInTheDocument();
    expect(screen.getByText("The run failed")).toBeInTheDocument();
  });
});

describe("runs home", () => {
  it("always offers the demo recording, even with the API down", async () => {
    renderAt("/runs", {
      ...withDatasets,
      "GET /runs": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(screen.getByRole("link", { name: "demo-churn-leaky" })).toHaveAttribute(
      "href",
      "/replay/demo-churn-leaky",
    );
    const alert = await screen.findByRole("alert", {}, { timeout: 8000 });
    expect(alert).toHaveTextContent("Could not list runs");
    expect(alert).toHaveTextContent("make api");
  }, 15_000);

  it("tells the operator to start the API when a proxy answers a bare 502 for it", { timeout: 15_000 }, async () => {
    // With `make web` and no API, Vite's dev proxy answers 502 with no FastAPI body. This is what
    // the operator really sees, and a screenshot showed it rendering just "Bad Gateway". A 5xx is
    // retried twice with backoff first (about 3s), so the error state takes a moment to appear.
    renderAt("/runs", { ...withDatasets, "GET /runs": () => ({ status: 502, body: "Bad Gateway" }) });
    const alert = await screen.findByRole("alert", {}, { timeout: 8000 });
    expect(alert).toHaveTextContent("Could not list runs");
    expect(alert).toHaveTextContent("make api");
  });

  it("tells the operator what to do next when there are no runs", async () => {
    renderAt("/runs", { ...withDatasets, "GET /runs": () => ({ json: [] }) });
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
    expect(screen.getByText(/Pick a dataset above/)).toBeInTheDocument();
  });

  it("lists live runs with their status, dataset, goal and spend", async () => {
    renderAt("/runs", {
      ...withDatasets,
      "GET /runs": () => ({
        json: [
          makeRunStatus({
            thread_id: "5c255737-39db",
            status: "completed",
            spent_usd: 12.84,
            dataset_ref: "churn",
            goal: "predict churn",
          }),
        ],
      }),
    });
    expect(await screen.findByRole("link", { name: "predict churn" })).toHaveAttribute(
      "href",
      "/runs/5c255737-39db",
    );
    expect(screen.getByRole("cell", { name: "churn" })).toBeInTheDocument();
    expect(screen.getByText("$12.84")).toBeInTheDocument();
  });

  it("the start-a-run panel posts the form and lands on the new run", async () => {
    const user = userEvent.setup();
    renderAt("/runs", {
      ...withDatasets,
      "GET /runs": () => ({ json: [] }),
      "POST /runs": () => ({ status: 202, json: { thread_id: "t-9", status: "running" } }),
      "GET /runs/t-9/events": () => ({ body: sseBody("") }),
      "GET /runs/t-9": () => ({ json: makeRunStatus({ thread_id: "t-9" }) }),
    });
    await screen.findByText("No runs yet");

    await user.type(screen.getByLabelText("goal"), "predict widget failure");
    await user.click(screen.getByRole("button", { name: "Start run" }));

    // navigated off "runs" home and onto the new run's own view (RunView.tsx's own h1)
    await waitFor(() => expect(screen.getByRole("heading", { name: "activity" })).toBeInTheDocument(), slow);
    expect(screen.queryByRole("heading", { name: "runs" })).not.toBeInTheDocument();
  });

  it("redirects / to /runs", () => {
    renderAt("/", { ...withDatasets, "GET /runs": () => ({ json: [] }) });
    expect(screen.getByRole("heading", { name: "runs" })).toBeInTheDocument();
  });
});

describe("other screens", () => {
  it("shows the eval endpoint's fix-naming message verbatim", async () => {
    renderAt("/eval", {
      "GET /eval": () => ({ status: 404, json: { detail: "no eval results yet; run `make eval`" } }),
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("no eval results yet; run `make eval`");
    expect(alert).not.toHaveTextContent("make api"); // the API answered; it is not down
  });

  it("renders the per-task table and the ablations once results exist", async () => {
    renderAt("/eval", {
      "GET /eval": () => ({
        json: [
          makeTaskResult({ dataset_ref: "churn", config: "full", primary_metric_value: 0.85 }),
          makeTaskResult({ dataset_ref: "churn", config: "no_red_team", primary_metric_value: 0.99 }),
          makeTaskResult({
            dataset_ref: "churn", config: "memory_run_2", first_model_family: "lightgbm",
          }),
          makeTaskResult({ dataset_ref: "churn", config: "monolith", primary_metric_value: 0.79 }),
          makeTaskResult({ dataset_ref: "churn", config: "uniform_model" }),
        ],
      }),
    });
    expect(await screen.findByRole("cell", { name: "churn" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ablation: red team on/off" })).toBeInTheDocument();
    expect(screen.getByText("differs")).toBeInTheDocument(); // memory ablation: full plans logistic_regression, run 2 plans lightgbm
    expect(screen.getByRole("heading", { name: "ablation: model split vs. uniform" })).toBeInTheDocument();
  });

  it("says a run has no report yet, and offers the way back to it", async () => {
    renderAt("/runs/t-1/report", { "GET /runs/t-1": () => ({ json: makeRunStatus() }) });
    expect(await screen.findByText("No report yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the run" })).toHaveAttribute("href", "/runs/t-1");
  });

  it("shows a report once there is one, with its TOC, hero metric and model card", async () => {
    renderAt("/runs/t-1/report", {
      "GET /runs/t-1": () => ({
        json: makeRunStatus({
          report_md: "# Report\n\n## Summary\n\nbest roc_auc 0.85",
          model_card_md: "# Model Card\n\n## Notes\n\nships it",
          leaderboard: [
            { experiment_id: "exp-004", mlflow_run_id: null, primary_metric_name: "roc_auc", primary_metric_value: 0.8814, rank: 1 },
          ],
        }),
      }),
    });
    expect(await screen.findByText(/best roc_auc 0.85/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Summary" })).toHaveAttribute("href", "#summary");
    expect(screen.getByText("0.8814")).toBeInTheDocument(); // the hero metric
    expect(screen.getByText("ships it")).toBeInTheDocument(); // the model card, below the report
  });

  it(
    "renders a recording's own report, folded straight from its JSONL with no API involved",
    { timeout: 8000 },
    async () => {
      renderAt("/replay/demo-churn-leaky/report");
      // "exp-004 is the strongest candidate..." appears in BOTH report_md's Recommendation section
      // and model_card_md's own Notes (the recorded reporter repeats itself there) — so this picks
      // sign-off text unique to the report, to prove report_md rendered without a false match.
      expect(await screen.findByText(/approved while recording \(final gate\)/, {}, slow)).toBeInTheDocument();
      // "0.7262" also appears in the leaderboard table and the model card, so scope to the hero.
      expect(screen.getByText("0.7262", { selector: ".text-display" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Summary" })).toHaveAttribute("href", "#summary");
    },
  );

  it("names the fix when the recording named in a report URL does not exist", async () => {
    renderAt("/replay/never-recorded/report");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('No recorded run named "never-recorded"');
  });

  it("has a not-found screen that leads somewhere", () => {
    renderAt("/nowhere");
    expect(screen.getByText("Nothing at this address")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open runs" })).toHaveAttribute("href", "/runs");
  });

  it("toggles the theme from any screen", async () => {
    renderAt("/nowhere");
    await userEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("offers a skip link that lands on the main content", () => {
    renderAt("/nowhere");
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main");
    expect(document.getElementById("main")).not.toBeNull();
  });
});
