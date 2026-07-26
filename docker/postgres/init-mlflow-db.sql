-- Runs once, on first init of the postgres data volume (docker-entrypoint-initdb.d
-- scripts only execute against an empty data directory). Creates the second database
-- used by MLflow's tracking backend; POSTGRES_DB (the "foundry" database, used by the
-- LangGraph checkpointer) is created automatically by the postgres image itself.
CREATE DATABASE mlflow;
