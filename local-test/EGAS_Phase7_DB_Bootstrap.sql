\set ON_ERROR_STOP on

-- EGAS Phase 7 synthetic LOCAL sandbox only.
-- Run as a PostgreSQL superuser/admin, for example:
--   psql -U postgres -f EGAS_Phase7_DB_Bootstrap.sql
--
-- This creates an isolated database, a migration owner, and a restricted runtime
-- login. Passwords are synthetic local credentials and must never be reused in
-- any real environment.

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'egas_phase7_owner',
  'ZrSnpXw5vZgrCn2WhEHCSHWB-daIO16l'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'egas_phase7_owner')
\gexec

ALTER ROLE egas_phase7_owner
  WITH LOGIN PASSWORD 'ZrSnpXw5vZgrCn2WhEHCSHWB-daIO16l'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  'egas_phase7_app',
  'RWaa-ZIQjRfMJHsFDzBfeREomV8GXvIB'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'egas_phase7_app')
\gexec

ALTER ROLE egas_phase7_app
  WITH LOGIN PASSWORD 'RWaa-ZIQjRfMJHsFDzBfeREomV8GXvIB'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

SELECT format(
  'CREATE DATABASE %I OWNER %I ENCODING %L',
  'egas_workflow_phase7_local',
  'egas_phase7_owner',
  'UTF8'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'egas_workflow_phase7_local')
\gexec

ALTER DATABASE egas_workflow_phase7_local OWNER TO egas_phase7_owner;
REVOKE CREATE, TEMPORARY ON DATABASE egas_workflow_phase7_local FROM egas_phase7_app;
GRANT CONNECT ON DATABASE egas_workflow_phase7_local TO egas_phase7_app;

\echo 'Local database bootstrap complete.'
\echo 'Next: run migrations as egas_phase7_owner, then run EGAS_Phase7_Sandbox_Seed.sql.'
