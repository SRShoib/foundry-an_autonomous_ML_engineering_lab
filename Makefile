.PHONY: up down sandbox-build smoke sample-data run api lint fmt typecheck test eval web web-install web-build web-check console openapi types record-replay

up:
	docker compose up -d --build --wait

down:
	docker compose down

sandbox-build:
	docker build -t foundry-sandbox:latest -f docker/sandbox/Dockerfile .

smoke:
	uv run python scripts/smoke_test.py

sample-data:
	uv run python scripts/make_sample_data.py

run:
	uv run python -m foundry.cli --task $(TASK)

api:
	uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

lint:
	uv run ruff check .

fmt:
	uv run ruff format .

typecheck:
	uv run pyright

test:
	uv run pytest

eval:
	uv run python -m foundry.eval

web-install:
	cd web && npm ci

web:
	cd web && npm run dev

web-build:
	cd web && npm run build

web-check:
	cd web && npm run typecheck && npx vitest run

console:
	docker compose --profile console up -d --build --wait web

openapi:
	uv run python scripts/dump_openapi.py

types:
	cd web && npm run types

record-replay:
	uv run python scripts/record_replay.py
