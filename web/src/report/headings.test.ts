import { describe, expect, it } from "vitest";

import { extractHeadings, slugify, textContent } from "./headings";

describe("slugify", () => {
  it("lowercases and hyphenates, trimming stray hyphens", () => {
    expect(slugify("Cost by agent")).toBe("cost-by-agent");
    expect(slugify("Red team findings")).toBe("red-team-findings");
    expect(slugify("  Sign-off  ")).toBe("sign-off");
  });
});

describe("extractHeadings", () => {
  it("finds every ## heading in reading order, ignoring the # title", () => {
    const markdown = [
      "# Experiment Report — predict churn",
      "",
      "## Summary",
      "some text",
      "## Cost by agent",
      "| agent | usd |",
      "## Red team findings",
    ].join("\n");
    expect(extractHeadings(markdown)).toEqual([
      { id: "summary", text: "Summary" },
      { id: "cost-by-agent", text: "Cost by agent" },
      { id: "red-team-findings", text: "Red team findings" },
    ]);
  });

  it("returns nothing for markdown with no ## headings", () => {
    expect(extractHeadings("# Title\n\njust a paragraph")).toEqual([]);
  });
});

describe("textContent", () => {
  it("flattens plain text, numbers, arrays and nested elements", () => {
    expect(textContent("Sign-off")).toBe("Sign-off");
    expect(textContent(42)).toBe("42");
    expect(textContent(["a", "b"])).toBe("ab");
    expect(textContent({ props: { children: "nested" } } as never)).toBe("nested");
  });

  it("ignores null, undefined and booleans", () => {
    expect(textContent(null)).toBe("");
    expect(textContent(undefined)).toBe("");
    expect(textContent(true)).toBe("");
    expect(textContent(["a", null, "b", false])).toBe("ab");
  });
});
