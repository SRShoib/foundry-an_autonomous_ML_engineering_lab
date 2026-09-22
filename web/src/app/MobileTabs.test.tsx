import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { MobileTabs, panelId, tabId, type Tab } from "./MobileTabs";

const TABS: readonly Tab<"activity" | "board" | "audit">[] = [
  { id: "activity", label: "activity" },
  { id: "board", label: "board" },
  { id: "audit", label: "audit" },
];

function Harness() {
  const [active, setActive] = useState<"activity" | "board" | "audit">("activity");
  return <MobileTabs tabs={TABS} active={active} onChange={setActive} label="Run view" />;
}

describe("MobileTabs", () => {
  it("follows the ARIA tabs pattern", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Run view" })).toBeInTheDocument();
    const activity = screen.getByRole("tab", { name: "activity" });
    expect(activity).toHaveAttribute("aria-selected", "true");
    expect(activity).toHaveAttribute("id", tabId("activity"));
    expect(activity).toHaveAttribute("aria-controls", panelId("activity"));
  });

  it("puts exactly one tab in the tab order (roving tabindex)", () => {
    render(<Harness />);
    const indexes = screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex"));
    expect(indexes).toEqual(["0", "-1", "-1"]);
  });

  it("selects on click", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("tab", { name: "board" }));
    expect(screen.getByRole("tab", { name: "board" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "activity" })).toHaveAttribute("aria-selected", "false");
  });

  it("moves with Left/Right/Home/End, wraps around, and moves focus with the selection", async () => {
    render(<Harness />);
    screen.getByRole("tab", { name: "activity" }).focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "board" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "board" })).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "audit" })).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}"); // wraps to the first
    expect(screen.getByRole("tab", { name: "activity" })).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}"); // and back round the other way
    expect(screen.getByRole("tab", { name: "audit" })).toHaveFocus();

    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "activity" })).toHaveFocus();
  });

  it("leaves other keys alone", async () => {
    render(<Harness />);
    screen.getByRole("tab", { name: "activity" }).focus();
    await userEvent.keyboard("a");
    expect(screen.getByRole("tab", { name: "activity" })).toHaveAttribute("aria-selected", "true");
  });
});
