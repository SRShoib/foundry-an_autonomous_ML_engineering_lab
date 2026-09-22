import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";

import { ApiClientContext } from "../api/ApiClientContext";
import { createApiClient } from "../api/client";
import { createQueryClient } from "../api/queryClient";
import { fakeApi, TEST_BASE_URL, type FakeRoutes } from "../test/fakeApi";
import { makeDatasetOption } from "../test/fixtures";
import { StartRunPanel } from "./StartRunPanel";

function renderPanel(routes: FakeRoutes) {
  const fake = fakeApi(routes);
  const client = createApiClient({ baseUrl: TEST_BASE_URL, fetch: fake.fetch });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createQueryClient()}>
      <ApiClientContext value={client}>{children}</ApiClientContext>
    </QueryClientProvider>
  );
  render(
    <MemoryRouter initialEntries={["/runs"]}>
      <Routes>
        <Route
          path="/runs"
          element={
            <Wrapper>
              <StartRunPanel />
            </Wrapper>
          }
        />
        <Route path="/runs/:threadId" element={<p>landed on the run</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return { fake };
}

const DATASETS: FakeRoutes = {
  "GET /datasets": () => ({
    json: [
      makeDatasetOption({ key: "churn", description: "Synthetic telecom churn dataset." }),
      makeDatasetOption({ key: "energy", name: "energy", description: "Building energy usage." }),
    ],
  }),
};

describe("StartRunPanel", () => {
  it("populates the dataset select from GET /datasets and shows the selected one's description", async () => {
    renderPanel(DATASETS);
    await screen.findByRole("option", { name: "energy" });
    expect(screen.getByText("Synthetic telecom churn dataset.")).toBeInTheDocument();
  });

  it("posts the chosen dataset, goal and budget, and lands on the new run", async () => {
    const user = userEvent.setup();
    const { fake } = renderPanel({
      ...DATASETS,
      "POST /runs": () => ({ status: 202, json: { thread_id: "t-9", status: "running" } }),
    });
    await screen.findByRole("option", { name: "churn" });

    await user.type(screen.getByLabelText("goal"), "predict widget failure");
    await user.clear(screen.getByLabelText("budget"));
    await user.type(screen.getByLabelText("budget"), "5");
    await user.click(screen.getByRole("button", { name: "Start run" }));

    await screen.findByText("landed on the run");
    expect(fake.callsTo("POST /runs")[0]?.body).toEqual({
      task: "churn",
      goal: "predict widget failure",
      budget_usd: 5,
    });
  });

  it("sends a null goal when left blank, so the API falls back to its own default", async () => {
    const user = userEvent.setup();
    const { fake } = renderPanel({
      ...DATASETS,
      "POST /runs": () => ({ status: 202, json: { thread_id: "t-9", status: "running" } }),
    });
    await screen.findByRole("option", { name: "churn" });
    await user.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(fake.callsTo("POST /runs")).toHaveLength(1));
    expect(fake.callsTo("POST /runs")[0]?.body).toMatchObject({ goal: null });
  });

  it("shows the API's own error message when starting a run fails", async () => {
    const user = userEvent.setup();
    renderPanel({
      ...DATASETS,
      "POST /runs": () => ({ status: 404, json: { detail: "unknown dataset 'churn'" } }),
    });
    await screen.findByRole("option", { name: "churn" });
    await user.click(screen.getByRole("button", { name: "Start run" }));
    expect(await screen.findByText("unknown dataset 'churn'")).toBeInTheDocument();
  });
});
