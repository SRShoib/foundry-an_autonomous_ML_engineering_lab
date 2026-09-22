import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppFrame } from "./AppFrame";

describe("AppFrame", () => {
  it("renders the rail, main and dock regions without the desaturate class by default", () => {
    render(
      <AppFrame topBar={<div>top</div>} rail={<div>rail</div>} dock={<div>dock</div>}>
        <div>main</div>
      </AppFrame>,
    );
    expect(screen.getByRole("main")).not.toHaveClass("saturate-[.4]");
  });

  it("§7's gate entry: deenergized dims rail, main and dock, never the top bar", () => {
    render(
      <AppFrame topBar={<div>top</div>} rail={<div>rail</div>} dock={<div>dock</div>} deenergized>
        <div>main</div>
      </AppFrame>,
    );
    expect(screen.getByRole("main")).toHaveClass("saturate-[.4]");
    expect(screen.getByRole("banner")).not.toHaveClass("saturate-[.4]");
  });
});
