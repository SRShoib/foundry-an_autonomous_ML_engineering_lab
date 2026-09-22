import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "./ThemeProvider";
import { ThemeToggle } from "./ThemeToggle";
import { THEME_STORAGE_KEY, currentTheme, readStoredTheme, systemTheme } from "./theme";

function mockSystemPrefersLight(light: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) => ({ matches: light && query.includes("light"), media: query }) as MediaQueryList,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("theme", () => {
  it("is dark unless the viewer chose otherwise or the system asks for light", () => {
    mockSystemPrefersLight(false);
    expect(currentTheme()).toBe("dark");
  });

  it("honours the system preference only when nothing is stored", () => {
    mockSystemPrefersLight(true);
    expect(systemTheme()).toBe("light");
    expect(currentTheme()).toBe("light");

    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(currentTheme()).toBe("dark"); // a stored choice beats the system
  });

  it("takes the theme the pre-paint script already applied, so there is no flash", () => {
    document.documentElement.setAttribute("data-theme", "light");
    mockSystemPrefersLight(false);
    expect(currentTheme()).toBe("light");
  });

  it("ignores a stored value that is not a theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readStoredTheme()).toBeNull();
  });

  it("survives storage that throws (private windows, blocked site data)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(readStoredTheme()).toBeNull();
    expect(() => currentTheme()).not.toThrow();
  });
});

describe("ThemeToggle", () => {
  it("switches the theme on <html>, persists it, and names the action it will take", async () => {
    mockSystemPrefersLight(false);
    document.documentElement.setAttribute("data-theme", "dark");
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    await userEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("still switches when storage refuses the write", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
