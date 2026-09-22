import { describe, expect, it } from "vitest";

import { makeTaskResult } from "../test/fixtures";
import { memoryAblation, modelSplitAblation, monolithAblation, redTeamAblation } from "./ablations";

describe("redTeamAblation", () => {
  it("pairs full against no_red_team per dataset, only where both exist", () => {
    const results = [
      makeTaskResult({ dataset_ref: "churn_leaky", config: "full", primary_metric_value: 0.73 }),
      makeTaskResult({ dataset_ref: "churn_leaky", config: "no_red_team", primary_metric_value: 0.999 }),
      makeTaskResult({ dataset_ref: "energy", config: "full", primary_metric_value: 0.6 }),
      // no no_red_team row for "energy" — must be dropped, mirroring _by_config's dict membership
    ];
    expect(redTeamAblation(results)).toEqual([
      {
        category: "churn_leaky",
        series: [
          { label: "red team on", value: 0.73 },
          { label: "red team off", value: 0.999 },
        ],
      },
    ]);
  });
});

describe("monolithAblation", () => {
  it("pairs full against monolith per dataset", () => {
    const results = [
      makeTaskResult({ dataset_ref: "churn", config: "full", primary_metric_value: 0.85 }),
      makeTaskResult({ dataset_ref: "churn", config: "monolith", primary_metric_value: 0.79 }),
    ];
    expect(monolithAblation(results)).toEqual([
      {
        category: "churn",
        series: [
          { label: "hierarchical", value: 0.85 },
          { label: "monolith", value: 0.79 },
        ],
      },
    ]);
  });
});

describe("modelSplitAblation", () => {
  it("sums each role's call count across datasets, split vs uniform — never a fabricated cost", () => {
    const results = [
      makeTaskResult({
        dataset_ref: "churn", config: "full",
        calls_by_agent: { principal: 3, red_team: 3, worker: 12 },
      }),
      makeTaskResult({
        dataset_ref: "energy", config: "full",
        calls_by_agent: { principal: 2, red_team: 2, worker: 8 },
      }),
      makeTaskResult({
        dataset_ref: "churn", config: "uniform_model",
        calls_by_agent: { principal: 3, red_team: 3, worker: 12 },
      }),
      makeTaskResult({
        dataset_ref: "energy", config: "uniform_model",
        calls_by_agent: { principal: 2, red_team: 2, worker: 8 },
      }),
    ];
    expect(modelSplitAblation(results)).toEqual([
      { category: "principal", series: [{ label: "model split", value: 5 }, { label: "uniform model", value: 5 }] },
      { category: "red_team", series: [{ label: "model split", value: 5 }, { label: "uniform model", value: 5 }] },
      { category: "worker", series: [{ label: "model split", value: 20 }, { label: "uniform model", value: 20 }] },
    ]);
  });

  it("only sums datasets present in both configs", () => {
    const results = [
      makeTaskResult({ dataset_ref: "churn", config: "full", calls_by_agent: { principal: 3, red_team: 0, worker: 0 } }),
      makeTaskResult({ dataset_ref: "energy", config: "full", calls_by_agent: { principal: 99, red_team: 0, worker: 0 } }),
      makeTaskResult({ dataset_ref: "churn", config: "uniform_model", calls_by_agent: { principal: 3, red_team: 0, worker: 0 } }),
      // no uniform_model row for "energy" — its 99 must not leak into the sum
    ];
    const principal = modelSplitAblation(results).find((g) => g.category === "principal");
    expect(principal?.series[0]).toEqual({ label: "model split", value: 3 });
  });
});

describe("memoryAblation", () => {
  it("flags a differing first-family plan between run #1 and #2, per dataset", () => {
    const results = [
      makeTaskResult({ dataset_ref: "churn", config: "full", first_model_family: "logistic_regression" }),
      makeTaskResult({ dataset_ref: "churn", config: "memory_run_2", first_model_family: "lightgbm" }),
    ];
    expect(memoryAblation(results)).toEqual([
      { dataset: "churn", firstFamilyRun1: "logistic_regression", firstFamilyRun2: "lightgbm", differs: true },
    ]);
  });

  it("reads as not differing when both runs plan the same family", () => {
    const results = [
      makeTaskResult({ dataset_ref: "churn", config: "full", first_model_family: "lightgbm" }),
      makeTaskResult({ dataset_ref: "churn", config: "memory_run_2", first_model_family: "lightgbm" }),
    ];
    expect(memoryAblation(results)[0]?.differs).toBe(false);
  });
});
