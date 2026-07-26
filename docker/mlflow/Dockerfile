# The official image doesn't bundle a Postgres driver; add psycopg2-binary for the
# --backend-store-uri postgresql://... backend store.
FROM ghcr.io/mlflow/mlflow:v3.14.0

RUN pip install --no-cache-dir psycopg2-binary
