import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dialog, DialogTitle } from "./Dialog";

function renderDialog(props: Partial<Parameters<typeof Dialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  render(
    <Dialog open variant="centered" onOpenChange={onOpenChange} {...props}>
      <DialogTitle>a dialog</DialogTitle>
      <button type="button">inside</button>
    </Dialog>,
  );
  return onOpenChange;
}

describe("Dialog", () => {
  it("renders nothing when closed", () => {
    render(
      <Dialog open={false} variant="centered" onOpenChange={vi.fn()}>
        <DialogTitle>hidden</DialogTitle>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders as an accessible, labelled dialog when open", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "a dialog" })).toBeInTheDocument();
  });

  it("dismissible (the default): Escape closes it", async () => {
    const onOpenChange = renderDialog();
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismissible={false} (a gate): Escape is swallowed", async () => {
    const onOpenChange = renderDialog({ dismissible: false });
    screen.getByRole("button", { name: "inside" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("dismissible={false} (a gate): an outside pointer down is swallowed", () => {
    // Radix's modal Dialog sets `pointer-events: none` on <body> while open (real background-lock
    // behaviour), which userEvent's actionability checks correctly refuse to click through —
    // fireEvent dispatches the DOM event directly, the same way Radix's own outside-click
    // detector (a document-level pointerdown listener) observes it.
    const onOpenChange = renderDialog({ dismissible: false });
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
