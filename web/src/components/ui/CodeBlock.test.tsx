import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeBlock } from "./CodeBlock";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CodeBlock", () => {
  it("renders the text in a monospace, wrapped well", () => {
    render(<CodeBlock>{"print('hi')"}</CodeBlock>);
    const pre = screen.getByText("print('hi')");
    expect(pre.tagName).toBe("PRE");
    expect(pre).toHaveClass("num", "whitespace-pre-wrap");
  });

  it("says (empty) rather than render a blank well", () => {
    render(<CodeBlock>{""}</CodeBlock>);
    expect(screen.getByText("(empty)")).toBeInTheDocument();
  });

  it("shows its label when given one", () => {
    render(<CodeBlock label="python">x = 1</CodeBlock>);
    expect(screen.getByText("python")).toBeInTheDocument();
  });

  it("copies the text and confirms, visibly and to a screen reader", async () => {
    render(<CodeBlock>{"x = 1"}</CodeBlock>);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("x = 1");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");
  });

  it("goes back to 'Copy' after a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CodeBlock>{"x = 1"}</CodeBlock>);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("does nothing, and does not throw, when the clipboard refuses", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<CodeBlock>{"x = 1"}</CodeBlock>);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
