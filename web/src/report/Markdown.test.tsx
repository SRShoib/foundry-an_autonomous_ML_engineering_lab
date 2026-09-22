import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders GFM pipe tables from report_md", () => {
    render(
      <Markdown>{"| rank | experiment |\n|---|---|\n| 1 | exp-004 |"}</Markdown>,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "exp-004" })).toBeInTheDocument();
  });

  it("gives every ## heading an id matching headings.ts's slugify, for ReportToc.tsx", () => {
    render(<Markdown>{"## Cost by agent\n\nsome text"}</Markdown>);
    expect(screen.getByRole("heading", { name: "Cost by agent", level: 2 })).toHaveAttribute(
      "id",
      "cost-by-agent",
    );
  });

  it("never renders raw HTML as elements — LLM narrative text is untrusted", () => {
    const { container } = render(<Markdown>{"before <strong>injected</strong> after"}</Markdown>);
    expect(container.querySelector("strong")).toBeNull();
  });
});
