.PHONY: up down sandbox-build smoke sample-data run api lint fmt typecheck test

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
