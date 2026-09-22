import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReportToc } from "./ReportToc";

describe("ReportToc", () => {
  it("renders nothing for a report with no ## sections", () => {
    const { container } = render(<ReportToc headings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links each heading to its anchor, in order", () => {
    render(
      <ReportToc
        headings={[
          { id: "summary", text: "Summary" },
          { id: "cost-by-agent", text: "Cost by agent" },
        ]}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Summary", "Cost by agent"]);
    expect(links[0]).toHaveAttribute("href", "#summary");
    expect(links[1]).toHaveAttribute("href", "#cost-by-agent");
  });
});
