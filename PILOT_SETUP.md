# Phase 1 backend pilot setup

This runbook starts only the Phase 1 CAP backend. Workflow and Admin React applications are not yet implemented.

1. Install Node.js 22+ and PostgreSQL on the pilot machine.
2. Clone the private repository and run `npm install` followed by `npm run setup`.
3. As a controlled DBA, create an empty database, a non-superuser migration/schema-owner login, and a separate non-superuser runtime login. Make the migration role the database and `public` schema owner. Do not grant the runtime role owner membership, `CREATE`, `CREATEDB`, `CREATEROLE`, replication, or `BYPASSRLS`.
4. Copy `.env.example` to `services/cap-api/.env`; put only machine-local values in the copy. Initially configure the database credentials for the migration/schema owner.
5. Run `npm run db:migrate`. This is the only supported schema deployment path; do not import the frozen logical-baseline SQL.
6. Run `services/cap-api/db/operations/least-privilege-role.sql.example` through `psql` with `database_name`, `schema_owner`, and `runtime_role` variables. This grants current CAP/outbox objects and configures owner-scoped defaults for future tables/sequences while retaining append-only restrictions.
7. Change the private database credentials to the restricted runtime role.
8. On a fresh database only, set temporary bootstrap environment values and run `npm run admin:bootstrap` once. The command must print success, disconnect, and return to the shell. If an Admin already exists, keep it; bootstrap will refuse safely.
9. Run `npm run pilot:check` using the runtime role.
10. Do not load a real employee workbook in Phase 1. The current import command performs validation only.
11. Run `npm run build`, `npm test`, `npm run typecheck`, and `npm run security:check`.
12. Run `npm run pilot` and access the CAP service on the locally reported port.

`pilot:check` is expected to exit non-zero until all 22 active routing units have active authority coverage and an annual employee snapshot has been activated. These are explicit later-phase setup gates, not permission to invent mappings or activate synthetic employee data.

Never move pilot state by copying source-controlled secrets or real HR files. Use an approved future backup/restore procedure or repeat the controlled importer after it is implemented.
