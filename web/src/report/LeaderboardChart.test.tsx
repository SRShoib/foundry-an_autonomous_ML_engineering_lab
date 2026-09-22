import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LeaderboardChart } from "./LeaderboardChart";

const ENTRIES = [
  { experiment_id: "exp-001", mlflow_run_id: null, primary_metric_name: "roc_auc", primary_metric_value: 0.86, rank: 2 },
  { experiment_id: "exp-004", mlflow_run_id: null, primary_metric_name: "roc_auc", primary_metric_value: 0.8814, rank: 1 },
];

describe("LeaderboardChart", () => {
  it("renders nothing for an empty leaderboard", () => {
    const { container } = render(<LeaderboardChart leaderboard={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws a bar per experiment and captions the best metric", () => {
    const { container } = render(<LeaderboardChart leaderboard={ENTRIES} />);
    expect(container.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(2);
    expect(screen.getByText(/best is 0\.8814/)).toBeInTheDocument();
  });

  it("orders bars by rank, not by the array's own order", () => {
    // Recharts v3 renders axis tick text into its own z-index layer rather than nesting it under
    // the .xAxis group, so this filters by content (an experiment id) instead of DOM position.
    const { container } = render(<LeaderboardChart leaderboard={ENTRIES} />);
    const labels = [...container.querySelectorAll(".recharts-cartesian-axis-tick-value")]
      .map((el) => el.textContent)
      .filter((text): text is string => text !== null && text.startsWith("exp-"));
    expect(labels).toEqual(["exp-004", "exp-001"]);
  });
});
