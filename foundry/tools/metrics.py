"""The only path a number takes from the sandbox to ExperimentResult (CLAUDE.md: "Metrics
computed by code, never estimated by an LLM"). The experiment runner's training code prints one
line per metrics emission: `FOUNDRY_METRICS {json}`. parse_metrics is a pure function over
sandbox stdout — it never touches the LLM's output, only SandboxResult.stdout.

The last matching line wins rather than the first: a training script may legitimately print
progress before its final metrics line (e.g. per-fold scores), and keying off the tail protects
against an earlier, unrelated print accidentally matching the sentinel.
"""

from __future__ import annotations

import json

METRICS_SENTINEL = "FOUNDRY_METRICS"


class MetricsParseError(ValueError):
    pass


def parse_metrics(stdout: str) -> dict[str, float]:
    lines = [line for line in stdout.splitlines() if line.startswith(METRICS_SENTINEL)]
    if not lines:
        raise MetricsParseError(f"no {METRICS_SENTINEL} line found in stdout: {stdout!r}")

    payload = lines[-1][len(METRICS_SENTINEL) :].strip()
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise MetricsParseError(
            f"{METRICS_SENTINEL} line is not valid JSON: {payload!r}"
        ) from exc
    if not isinstance(parsed, dict):
        raise MetricsParseError(f"{METRICS_SENTINEL} JSON must be an object, got {parsed!r}")

    metrics: dict[str, float] = {}
    for key, value in parsed.items():
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise MetricsParseError(f"metric {key!r} is not numeric: {value!r}")
        metrics[key] = float(value)
    return metrics
