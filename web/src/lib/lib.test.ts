import { describe, expect, it } from "vitest";

import { cn } from "./cn";
import { formatClock, formatMetric, formatUsd, formatUsdPrecise, shortId } from "./format";
import { METER_CRITICAL_AT, METER_PRESSURE_AT, meterTone, spendFraction } from "./meter";

describe("meter", () => {
  it("is safe under 70%, pressure from 70 to 90, critical over 90 (design-plan §3.1)", () => {
    expect(meterTone(0)).toBe("safe");
    expect(meterTone(0.699)).toBe("safe");
    expect(meterTone(METER_PRESSURE_AT)).toBe("pressure");
    expect(meterTone(0.9)).toBe("pressure"); // "over 90%" — 90 itself is still pressure
    expect(meterTone(0.901)).toBe("critical");
    expect(METER_CRITICAL_AT).toBe(0.9);
  });

  it("computes the spend fraction, clamped, and survives a zero cap", () => {
    expect(spendFraction(5, 20)).toBe(0.25);
    expect(spendFraction(30, 20)).toBe(1);
    expect(spendFraction(-1, 20)).toBe(0);
    expect(spendFraction(5, 0)).toBe(0);
  });
});

describe("format", () => {
  it("formats money, keeping cents on small figures and dropping them on large ones", () => {
    expect(formatUsd(12.84)).toBe("$12.84");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(250.4)).toBe("$250");
  });

  it("shows a run's per-event cost to four places so a fraction of a cent is visible", () => {
    expect(formatUsdPrecise(0.0412)).toBe("$0.0412");
  });

  it("formats a metric to four places", () => {
    expect(formatMetric(0.8814)).toBe("0.8814");
    expect(formatMetric(0.9992671514741529)).toBe("0.9993");
  });

  it("shortens a thread id to something a top bar can hold", () => {
    expect(shortId("5c255737-39db-464e-b0d2-d82e7cdc0b3a")).toBe("5c25…3a");
    expect(shortId("run-a")).toBe("run-a");
  });

  it("formats a clock as m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(83.9)).toBe("1:23");
    expect(formatClock(3600)).toBe("60:00");
    expect(formatClock(-4)).toBe("0:00");
  });
});

describe("cn", () => {
  it("joins the truthy parts and drops the rest", () => {
    expect(cn("a", false, null, undefined, "b", "")).toBe("a b");
  });
});
