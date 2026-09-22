import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApiError } from "../../api/client";
import { ReplayLoadError } from "../../replay/loadReplay";
import { EmptyState } from "./EmptyState";
import { ErrorState, QueryErrorState } from "./ErrorState";
import { Skeleton, SkeletonLines } from "./Skeleton";

describe("EmptyState", () => {
  it("says what is empty AND what to do about it", () => {
    render(
      <EmptyState
        title="No runs yet"
        hint="Start one with POST /runs."
        action={<button type="button">Start</button>}
      />,
    );
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
    expect(screen.getByText("Start one with POST /runs.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("is an alert that shows the API's own message verbatim", () => {
    render(
      <ErrorState
        title="Could not load this run"
        detail="unknown thread_id 'nope'"
        fix="Check the address."
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not load this run");
    expect(alert).toHaveTextContent("unknown thread_id 'nope'");
    expect(alert).toHaveTextContent("Check the address.");
  });

  it("preserves the whitespace of a multi-line message such as a traceback", () => {
    render(<ErrorState title="t" detail={"line one\n  line two"} />);
    expect(screen.getByText(/line one/)).toHaveClass("whitespace-pre-wrap");
  });
});

describe("QueryErrorState", () => {
  it("shows an ApiError's detail as-is and adds no advice of its own", () => {
    render(
      <QueryErrorState
        title="No eval results to show"
        error={new ApiError(404, "no eval results yet; run `make eval`")}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("no eval results yet; run `make eval`");
    expect(alert).not.toHaveTextContent("make api"); // the API answered; it is not down
  });

  it("tells the operator the API is down, and that recordings still replay, on a network fault", () => {
    render(<QueryErrorState title="Could not list runs" error={new TypeError("Failed to fetch")} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Failed to fetch");
    expect(alert).toHaveTextContent("make api");
    expect(alert).toHaveTextContent("still replay");
  });

  it("copes with a thrown non-Error", () => {
    render(<QueryErrorState title="t" error="boom" />);
    expect(screen.getByRole("alert")).toHaveTextContent("The request did not complete.");
  });

  it("recognises a gateway answering for a dead API: a bare 502 carries no FastAPI detail", () => {
    // What Vite's dev proxy and Caddy actually answer with when nothing is listening on :8000. A
    // screenshot caught this rendering "Bad Gateway" with no advice, because only a network
    // rejection had been tested.
    render(<QueryErrorState title="Could not list runs" error={new ApiError(502, "Bad Gateway", false)} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Bad Gateway");
    expect(alert).toHaveTextContent("make api");
    expect(alert).toHaveTextContent("still replay");
  });

  it("does NOT tell the operator to start the API for a problem that is not the API being down", () => {
    // Also caught by a screenshot: a missing recording was captioned "The API did not answer.
    // Start it with `make api`" — advice that is wrong for a file that does not exist.
    const notApiDown: [string, unknown][] = [
      ["a missing recording", new ReplayLoadError('No recorded run named "x". Make one with `make record-replay`.')],
      ["the API's own 500, with its own detail", new ApiError(500, "docker daemon went away", true)],
      ["an API refusal", new ApiError(409, "no pending approval", true)],
      ["a 404 with no detail", new ApiError(404, "Not Found", false)],
      ["an arbitrary error", new Error("something else")],
    ];
    for (const [label, error] of notApiDown) {
      const { unmount } = render(<QueryErrorState title="t" error={error} />);
      expect(screen.getByRole("alert"), label).not.toHaveTextContent("make api");
      unmount();
    }
  });
});

describe("Skeleton", () => {
  it("holds a place without being announced", () => {
    const { container } = render(<Skeleton className="h-4" />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("does not shimmer: no animation classes (design-plan §9)", () => {
    const { container } = render(<SkeletonLines lines={3} />);
    expect(container.innerHTML).not.toMatch(/animate-|shimmer|pulse/);
    expect(container.querySelectorAll("[aria-hidden]")).toHaveLength(3);
  });
});
