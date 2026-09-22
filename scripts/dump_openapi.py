"""Dump the FastAPI app's OpenAPI schema to web/openapi.json, the committed input the console's
TypeScript types are generated from (web/scripts/gen-types.mjs). CLAUDE.md: "Types generated from
FastAPI OpenAPI, never hand-written" — so the API's own schema, not a second copy of it, is the
source of truth, and this file is what makes that true without a running server.

It is committed rather than fetched from a live API because docker/web/Dockerfile has node but no
Python: `npm ci && npm run build` must work from the repo checkout alone. Drift is caught by
tests/test_openapi.py (a `make test` failure, not a forgotten make target); `--check` is the same
comparison for use in CI or a pre-commit hook.

create_app() is called with in-memory factories and its lifespan is never entered, so this needs
no Postgres, no Docker and no API key — the schema depends only on the route and model definitions.

Written with an explicit path and newline="\\n" rather than shell redirection so the Makefile's
one-line recipes behave the same under sh and cmd, and the file is byte-identical across platforms.
"""

from __future__ import annotations

import argparse
import json
import sys
from contextlib import nullcontext
from pathlib import Path
from typing import Any

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore

from app.main import create_app

DEFAULT_OUT = Path("web/openapi.json")


def build_schema() -> dict[str, Any]:
    app = create_app(
        checkpointer_factory=lambda: nullcontext(InMemorySaver()),
        store_factory=lambda: nullcontext(InMemoryStore()),
    )
    return app.openapi()


def render(schema: dict[str, Any]) -> str:
    """Sorted keys and a trailing newline: a schema change is a reviewable, minimal diff."""
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Dump the FastAPI OpenAPI schema for the web app.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--check",
        action="store_true",
        help="write nothing; exit 1 if --out differs from the live app's schema",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    rendered = render(build_schema())
    if args.check:
        current = args.out.read_text(encoding="utf-8") if args.out.is_file() else None
        if current != rendered:
            print(f"{args.out} is stale; run `make openapi`", file=sys.stderr)
            return 1
        print(f"{args.out} is up to date")
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(rendered)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
