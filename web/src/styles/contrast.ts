/** WCAG 2.x contrast (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio), used by the §11 token
 * check in tokens.contrast.test.ts. Pure and dependency-free so the test can run it over the real
 * CSS variables. Only opaque hex is handled: every token the test checks is one. */

export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  const raw = hex.trim().replace(/^#/, "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`not an opaque hex colour: ${JSON.stringify(hex)}`);
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(parseHex(foreground));
  const b = relativeLuminance(parseHex(background));
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/** A translucent colour: one `rgb(r g b / a)` stop of a wash, glow or gradient token. */
export interface Layer {
  readonly rgb: Rgb;
  readonly alpha: number;
}

/** Every `rgb(r g b / a)` (or comma-separated `rgba()`) in a token's value, in order. M9h's aurora,
 * spotlight and bloom tokens are gradients, not single colours, so the wash test needs the stops
 * pulled out of the gradient text. A stop with no alpha is opaque. */
export function parseRgbLayers(value: string): Layer[] {
  const layers: Layer[] = [];
  for (const m of value.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)/g)) {
    const [, r, g, b, a, percent] = m;
    if (r === undefined || g === undefined || b === undefined) continue;
    const alpha = a === undefined ? 1 : Number(a) / (percent === "%" ? 100 : 1);
    layers.push({ rgb: [Number(r), Number(g), Number(b)], alpha });
  }
  return layers;
}

/** `foreground` painted over an opaque `background`, as the browser blends it (in sRGB space), as an
 * opaque hex — so a translucent wash can be fed straight back into `contrastRatio`. */
export function compositeOver(foreground: Layer | { rgb: Rgb; alpha: number }, background: string): string {
  const [br, bg, bb] = parseHex(background);
  const mixed = [br, bg, bb].map((channel, i) =>
    Math.round((foreground.rgb[i] ?? 0) * foreground.alpha + channel * (1 - foreground.alpha)),
  );
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** An opaque hex token as a full-alpha layer, for tinting it over a ground (a chip is `tone @ 15%`). */
export function hexLayer(hex: string, alpha: number): Layer {
  return { rgb: parseHex(hex), alpha };
}

/** The standard normal CDF (Abramowitz and Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? 1 - upper : upper;
}

/** The PEAK tint of a full-viewport `inset 0 0 <blur>px <spread>px rgb(… / a)` shadow, which is lower
 * than its nominal alpha. A browser blurs a shadow with a Gaussian of sigma = blur / 2, and the
 * brightest pixel is the viewport's own edge, which sits `spread` pixels inside the shadow's opaque
 * region — so the coverage there is the normal CDF at spread / sigma, not 1. Measured in a real
 * browser (M9h): a 140px/8px shadow at 0.22 lifted the edge by ~11% alpha, which this model predicts
 * (0.22 x Phi(8/70) = 0.12). Returns null if the value is not an inset shadow of that shape. */
export function insetShadowPeak(value: string): Layer | null {
  const shape = /\binset\s+0\s+0\s+(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px\s+(rgba?\([^)]*\))/.exec(value);
  if (shape === null) return null;
  const [, blur, spread, colour] = shape;
  const layer = parseRgbLayers(colour ?? "")[0];
  if (layer === undefined || blur === undefined || spread === undefined) return null;
  const sigma = Number(blur) / 2;
  const coverage = sigma === 0 ? 1 : normalCdf(Number(spread) / sigma);
  return { rgb: layer.rgb, alpha: layer.alpha * coverage };
}
