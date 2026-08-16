# Phase 2A backend pilot setup

This runbook starts the plain Express/PostgreSQL backend. Annual activation, workflow execution, and React applications are not implemented.

1. Install Node.js 22+ and PostgreSQL; clone the private repository; run `npm install` and `npm run setup`.
2. As a controlled DBA, create an empty database, a non-superuser schema/migration-owner login, and a separate restricted runtime login. The runtime must not own the database/schema/tables, inherit the owner, or receive `CREATE`, `TEMPORARY`, `CREATEDB`, `CREATEROLE`, replication, `BYPASSRLS`, or superuser privileges.
3. Copy `.env.example` to `services/api/.env`. Initially configure `EGAS_DB_*` for the schema/migration owner. Generate a unique fingerprint secret. Production requires HTTPS and secure cookies.
4. Run `npm run db:migrate`. Do not import the frozen logical SQL and do not recreate an existing database.
5. Run `services/api/db/operations/least-privilege-role.sql.example` through `psql`, supplying `database_name`, the actual CAP-object/schema owner, and `runtime_role`. A `public` owner of `pg_database_owner` is valid when the supplied owner owns the database. The script validates all object ownership before transactional grants.
6. Change `EGAS_DB_*` to restricted `egas_app` credentials.
7. On a fresh database only, set temporary `EGAS_BOOTSTRAP_ADMIN_*` values and run `npm run admin:bootstrap`. It prints success, closes the pool, and returns code 0. If a privileged Admin exists, keep it; bootstrap refuses safely.
8. Run `npm run pilot:check` as `egas_app`.
9. Run `npm run build`, `npm test`, `npm run typecheck`, and `npm run security:check`.
10. Run `npm run dev` (or `npm run build` then `npm start`) behind a same-origin HTTPS reverse proxy for production.

The expected current preflight is:

- database runtime role: true (`egas_app`)
- active routing units: true (22/22)
- privileged Admin: true
- authority coverage: false (0/22 until genuine primary assignments exist)
- active annual snapshot: false (until an approved import is activated in a later phase)

Consequently `pilot:check` must exit non-zero at this stage. Do not invent authority mappings or activate synthetic employee data to make it green.

After each controlled migration, rerun the grant script as the object owner/controlled DBA. Historical `cds_model` and `cds_outbox_messages` tables are preserved on upgraded databases but the Express runtime does not access them; the current grant script revokes runtime privileges on both.
