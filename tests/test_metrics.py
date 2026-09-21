"""Tests for foundry/tools/metrics.py — the only path a number takes from the sandbox to
ExperimentResult."""

from __future__ import annotations

import pytest

from foundry.tools.metrics import METRICS_SENTINEL, MetricsParseError, parse_metrics


def test_parses_a_single_metrics_line() -> None:
    stdout = f'{METRICS_SENTINEL} {{"roc_auc": 0.9}}'
    assert parse_metrics(stdout) == {"roc_auc": 0.9}


def test_last_matching_line_wins() -> None:
    stdout = (
        f'{METRICS_SENTINEL} {{"roc_auc": 0.1}}\n'
        "some other output in between\n"
        f'{METRICS_SENTINEL} {{"roc_auc": 0.9}}\n'
    )
    assert parse_metrics(stdout) == {"roc_auc": 0.9}


def test_surrounding_stdout_noise_is_ignored() -> None:
    stdout = f'training...\n{METRICS_SENTINEL} {{"acc": 1.0}}\ndone\n'
    assert parse_metrics(stdout) == {"acc": 1.0}


def test_missing_sentinel_raises() -> None:
    with pytest.raises(MetricsParseError, match=METRICS_SENTINEL):
        parse_metrics("no metrics here")


def test_invalid_json_raises() -> None:
    with pytest.raises(MetricsParseError):
        parse_metrics(f"{METRICS_SENTINEL} not json")


def test_non_dict_json_raises() -> None:
    with pytest.raises(MetricsParseError):
        parse_metrics(f"{METRICS_SENTINEL} [1, 2, 3]")


def test_non_numeric_value_raises() -> None:
    with pytest.raises(MetricsParseError):
        parse_metrics(f'{METRICS_SENTINEL} {{"roc_auc": "high"}}')


def test_bool_value_rejected_even_though_bool_is_a_python_int() -> None:
    with pytest.raises(MetricsParseError):
        parse_metrics(f'{METRICS_SENTINEL} {{"flag": true}}')
