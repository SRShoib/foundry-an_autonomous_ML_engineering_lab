import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AblationGroup } from "./ablations";
import { AblationChart } from "./AblationChart";

const GROUPS: AblationGroup[] = [
  { category: "churn", series: [{ label: "red team on", value: 0.73 }, { label: "red team off", value: 0.99 }] },
  { category: "energy", series: [{ label: "red team on", value: 0.6 }, { label: "red team off", value: 0.65 }] },
];

describe("AblationChart", () => {
  it("renders nothing for an empty ablation", () => {
    const { container } = render(<AblationChart groups={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws one bar per series per category — a small multiple, not a combined chart", () => {
    const { container } = render(<AblationChart groups={GROUPS} />);
    // 2 categories x 2 series = 4 bars
    expect(container.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(4);
  });

  it("legends each series label exactly once", () => {
    const { container } = render(<AblationChart groups={GROUPS} />);
    const legendText = [...container.querySelectorAll(".recharts-legend-item-text")].map((el) => el.textContent);
    expect(legendText.sort()).toEqual(["red team off", "red team on"]);
  });
});
