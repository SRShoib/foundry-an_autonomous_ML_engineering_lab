import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InlineMeter } from "./InlineMeter";

describe("InlineMeter", () => {
  it("exposes spend as a progressbar sized to the fraction of cap spent", () => {
    render(<InlineMeter spent={5} cap={20} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "5");
    expect(bar).toHaveAttribute("aria-valuemax", "20");
    expect(bar.firstChild).toHaveStyle({ width: "25%" });
  });

  it("never disagrees with lib/meter.ts's shared thresholds — a run over cap fills to 100%", () => {
    render(<InlineMeter spent={25} cap={20} />);
    expect(screen.getByRole("progressbar").firstChild).toHaveStyle({ width: "100%" });
  });
});
