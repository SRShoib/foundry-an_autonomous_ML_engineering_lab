"""Tests for scripts/dump_openapi.py and the committed web/openapi.json it produces. The operator
console's TypeScript types are generated from that file (CLAUDE.md: "never hand-written"), so if it
drifts from the live app the UI is compiled against an API that no longer exists. Make targets get
forgotten; a failing test does not, so the drift check lives here and not only in the Makefile."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType

_ROOT = Path(__file__).resolve().parent.parent
_COMMITTED = _ROOT / "web" / "openapi.json"


def _load_dump_openapi() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "dump_openapi", _ROOT / "scripts" / "dump_openapi.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dump_openapi = _load_dump_openapi()


def test_committed_openapi_json_matches_the_live_app() -> None:
    """Fails with the fix in the message. Regenerate, then `cd web && npm run types`."""
    assert _COMMITTED.is_file(), "web/openapi.json is missing; run `make openapi`"
    committed = _COMMITTED.read_text(encoding="utf-8")
    assert committed == dump_openapi.render(dump_openapi.build_schema()), (
        "web/openapi.json is stale relative to the FastAPI app; run `make openapi` and "
        "`make types`, then commit both"
    )


def test_activity_event_is_in_the_openapi_components() -> None:
    """The SSE payload type must be generated like every other one. A route annotated
    `-> StreamingResponse` documents nothing, which would force the console to hand-write it."""
    schemas = dump_openapi.build_schema()["components"]["schemas"]
    assert {"kind", "seq", "ts", "summary"} <= set(schemas["ActivityEvent"]["properties"])


def test_every_type_the_console_imports_is_in_the_schema() -> None:
    schemas = dump_openapi.build_schema()["components"]["schemas"]
    needed = {
        "RunStatus", "PendingApproval", "ActivityEvent", "ExperimentResult", "RedTeamFinding",
        "DataProfile", "LeaderboardEntry", "Replay", "ReplayFrame", "ReplayHeader",
        "ReplaySummary", "TaskResult", "StartRunRequest", "StartRunResponse", "ResumeRequest",
    }
    assert needed <= set(schemas)


def test_event_stream_route_is_documented_as_text_event_stream() -> None:
    paths = dump_openapi.build_schema()["paths"]
    responses = paths["/runs/{thread_id}/events"]["get"]["responses"]["200"]["content"]
    assert "text/event-stream" in responses


def test_run_status_exposes_the_fields_the_console_reads() -> None:
    props = dump_openapi.build_schema()["components"]["schemas"]["RunStatus"]["properties"]
    assert {
        "experiments", "invalidations", "model_card_md", "data_profile", "cost_by_agent",
    } <= set(props)


def test_render_is_deterministic_and_newline_terminated() -> None:
    schema = dump_openapi.build_schema()
    first, second = dump_openapi.render(schema), dump_openapi.render(schema)
    assert first == second
    assert first.endswith("}\n")
    assert json.loads(first) == schema


def test_check_mode_reports_a_missing_or_stale_file(tmp_path: Path) -> None:
    out = tmp_path / "openapi.json"
    assert dump_openapi.main(["--out", str(out), "--check"]) == 1  # missing
    assert dump_openapi.main(["--out", str(out)]) == 0  # write
    assert dump_openapi.main(["--out", str(out), "--check"]) == 0  # fresh
    out.write_text("{}", encoding="utf-8")
    assert dump_openapi.main(["--out", str(out), "--check"]) == 1  # stale


def test_response_schemas_mark_every_field_required() -> None:
    """The API serializes every field it returns, so the console's generated types must not call
    any of them optional. Without foundry.models.WIRE_CONFIG, Pydantic marks defaulted fields as
    not-required, and every component would guard against an `undefined` that cannot happen."""
    schemas = dump_openapi.build_schema()["components"]["schemas"]
    responses = {
        "RunStatus", "PendingApproval", "ActivityEvent", "ExperimentResult", "RedTeamFinding",
        "DataProfile", "ColumnProfile", "LeaderboardEntry", "Replay", "ReplayFrame",
        "ReplayHeader", "ReplayDecision", "ReplaySummary", "TaskResult", "StartRunResponse",
    }
    optional = {
        name: sorted(set(schemas[name]["properties"]) - set(schemas[name].get("required", [])))
        for name in responses
    }
    assert {name: fields for name, fields in optional.items() if fields} == {}


def test_no_schema_is_split_into_input_and_output_variants() -> None:
    """FastAPI emits `X-Input` / `X-Output` when one model is both a request and a response with
    differing schemas. None of ours should be: it would rename the type the console imports."""
    schemas = dump_openapi.build_schema()["components"]["schemas"]
    assert [n for n in schemas if n.endswith(("-Input", "-Output"))] == []
