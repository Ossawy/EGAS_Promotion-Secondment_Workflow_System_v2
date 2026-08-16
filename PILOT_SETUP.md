# Phase 3A backend pilot setup

This runbook starts the plain Express/PostgreSQL backend, controlled annual-data foundation, and Phase 3A workflow-draft infrastructure. Full workflow submission/decisions and React applications are not implemented.

1. Install Node.js 22+ and PostgreSQL; clone the private repository; run `npm install` and `npm run setup`.
2. As a controlled DBA, create an empty database, a non-superuser schema/migration-owner login, and a separate restricted runtime login. The runtime must not own the database/schema/tables, inherit the owner, or receive `CREATE`, `TEMPORARY`, `CREATEDB`, `CREATEROLE`, replication, `BYPASSRLS`, or superuser privileges.
3. Copy `.env.example` to `services/api/.env`. Initially configure `EGAS_DB_*` for the schema/migration owner. Generate a unique fingerprint secret. Production requires HTTPS and secure cookies.
4. Run `npm run db:migrate`. Do not import the frozen logical SQL and do not recreate an existing database.
5. Run `services/api/db/operations/least-privilege-role.sql.example` through `psql`, supplying `database_name`, the actual PostgreSQL object/schema owner, and `runtime_role`. A `public` owner of `pg_database_owner` is valid when the supplied owner owns the database. The script validates all object ownership before transactional grants.
6. Change `EGAS_DB_*` to restricted `egas_app` credentials.
7. On a fresh database only, set temporary `EGAS_BOOTSTRAP_ADMIN_*` values and run `npm run admin:bootstrap`. It prints success, closes the pool, and returns code 0. If a privileged Admin exists, keep it; bootstrap refuses safely.
8. Run `npm run data:import -- --file <approved-xlsx-path> --year 2026 --operator <active-admin-username>`. The CLI reads the local file, records its basename/SHA-256/operator, stages raw rows, validates, and prints aggregate results. It never activates the batch and never requires a database GUI.
9. For unresolved routing labels, an Admin records only EGAS-approved exact aliases through `/api/admin/routing-aliases`; do not guess mappings. Then run `npm run data:revalidate -- --batch <UUID> --operator <active-admin-username>`.
10. If any rows remain `BLOCKED`, stop. The full annual snapshot must not be partially activated. After operational approval and only with zero blocked rows, run `npm run data:activate -- --batch <UUID> --operator <active-admin-username>`.
11. Run `npm run pilot:check` as `egas_app`.
12. Run `npm run build`, `npm test`, `npm run typecheck`, and `npm run security:check`.
13. Run `npm run dev` (or `npm run build` then `npm start`) behind a same-origin HTTPS reverse proxy for production.

The expected current preflight is:

- database runtime role: true (`egas_app`)
- active routing units: true (22/22)
- privileged Admin: true
- authority coverage: false (0/22 until genuine primary assignments exist)
- active annual snapshot: false until a genuinely valid, explicitly approved Phase 2B batch is activated

Consequently `pilot:check` still exits non-zero while authority coverage remains 0/22, even after a genuine annual activation. Do not invent authority mappings or activate synthetic employee data to make it green.

After each controlled migration, rerun the grant script as the object owner/controlled DBA. Migration 002 makes annual snapshots append-only; migration 003 adds no tables/sequences, but the grant verification should still be rerun. Historical `cds_model` and `cds_outbox_messages` remain preserved and inaccessible to the Express runtime.

Activation fails closed with `IMPORT_MIGRATION_REQUIRED` until migration `002_phase2b_annual_snapshot_integrity` is present in `egas_schemamigration`. Never activate a staged batch before running `npm run db:migrate` as the schema owner and rerunning the least-privilege grant script.

Phase 3A workflow-draft creation fails closed with `WORKFLOW_MIGRATION_REQUIRED` until `003_phase3a_workflow_draft_foundation` is present. The real blocked 2026 batch must remain staged, and no synthetic requests/authorities should be inserted into the development database. See `docs/phase3a-workflow-api.md` for the deliberately submission-free API.
