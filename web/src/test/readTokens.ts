import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type TokenMap = Readonly<Record<string, string>>;

// import.meta.dirname, not new URL(..., import.meta.url): under Vitest's jsdom environment the
// latter is not a file: URL.
const TOKENS_CSS = resolve(import.meta.dirname, "../styles/tokens.css");

function declarations(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) out[name] = value.trim();
  }
  return out;
}

/**
 * Reads the REAL tokens.css and returns the dark block (`:root`) and the light block's own
 * declarations (`:root[data-theme="light"]`) — not jsdom's getComputedStyle, which does not
 * resolve custom properties reliably. `light` holds only what the light block declares; callers
 * that need a complete light theme decide how omissions are treated (the contrast test refuses to
 * let any colour be inherited from dark).
 */
export function readTokens(css: string = readFileSync(TOKENS_CSS, "utf8")): {
  dark: TokenMap;
  light: TokenMap;
} {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let dark: Record<string, string> = {};
  let light: Record<string, string> = {};
  for (const match of stripped.matchAll(/(:root(?:\[data-theme="light"\])?)\s*\{([^}]*)\}/g)) {
    const [, selector, body] = match;
    if (selector === undefined || body === undefined) continue;
    if (selector === ":root") dark = declarations(body);
    else light = declarations(body);
  }
  return { dark, light };
}

/** A colour token is one whose value is a literal colour, as opposed to a size, font or duration. */
export function isColour(value: string): boolean {
  return value.startsWith("#") || value.startsWith("rgb(") || value.startsWith("rgba(");
}
