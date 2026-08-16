# EGAS Promotion & Secondment Workflow System

The implemented Phase 1/2A/2B backend is a plain Node.js/TypeScript modular monolith:

```text
React + TypeScript (future client)
        -> HTTPS REST/JSON
Node.js + TypeScript + Express 5
        -> pg / node-postgres
PostgreSQL
```

The original BRD and authoritative v2.0 PDF retain SAP/Fiori/direct-HCM references for historical traceability. Following IT consultation, those implementation choices were superseded. The active backend has no SAP CAP, CDS, CQN, Fiori, UI5, BTP, OData, RFC, or BAPI dependency.

## Implemented scope

- Express REST health, authentication, reference, Admin-account, role, approving-authority, and delegation APIs.
- Argon2id passwords; opaque random sessions; only SHA-256 session/CSRF hashes stored.
- 30-minute idle and 8-hour absolute defaults, session rotation/revocation, mandatory initial password change, trusted-Origin and CSRF enforcement.
- Authorization under exactly one selected active role; assigned roles are never unioned.
- PostgreSQL-backed login evidence, generic failures, configurable 5/10/15 failure policy, and advisory-lock serialization.
- Privileged first-Admin bootstrap and last-active-Manage-Admins/self-change protections.
- Transactional security events for authentication and Admin/authority/delegation mutations.
- Preserved 31 `egas_*` tables plus historical `cds_model` and `cds_outbox_messages` (33 public tables), physical names, data, migration ledger, constraints, triggers, and reference rows. The historical CAP tables are not accessed.
- Controlled annual `.xlsx` inspection, raw staging, normalization, exact routing/alias validation, aggregate batch reporting, revalidation, and explicit transactional activation.
- Stable employee identities, immutable yearly snapshots, and active-snapshot Employee Affairs lookup.
- Admin-only routing-alias and import-batch APIs with CSRF/Origin enforcement and aggregate security evidence.

P1-P5/S1-S5 workflow, signatures, PDFs, workflow notifications, and React screens remain intentionally deferred.

## Configuration

Node.js 22+ and PostgreSQL are required. Copy [.env.example](.env.example) to `services/api/.env`; never commit the result. Normal runtime uses `EGAS_DB_NAME=egas_workflow_dev` and restricted `EGAS_DB_USER=egas_app`. The schema/migration owner is used only for `db:migrate` and the grant script.

Production requires HTTPS, `NODE_ENV=production`, `EGAS_REQUIRE_SECURE_COOKIE=true`, and a unique `EGAS_AUTH_FINGERPRINT_SECRET` of at least 32 characters. Startup validates all values and fails closed. The API does not enable permissive CORS; deploy the browser on the same origin or through a same-origin proxy.

## Fresh setup

1. Install packages: `npm install`, then `npm run setup`.
2. As a controlled DBA, create a database, schema/migration-owner login, and separate restricted runtime login. Passwords belong in `psql` prompts or a secret manager, not shell history.
3. Put migration-owner credentials in the private `services/api/.env`, then run `npm run db:migrate`.
4. Apply runtime grants as the owner/controlled DBA:

   ```powershell
   psql --dbname egas_workflow_dev --username postgres `
     --set=database_name=egas_workflow_dev `
     --set=schema_owner=postgres `
     --set=runtime_role=egas_app `
     --file services/api/db/operations/least-privilege-role.sql.example
   ```

   Substitute the actual object owner. PostgreSQL's `pg_database_owner` ownership of `public` is valid when the supplied schema owner owns the database. The script verifies every public table/sequence owner, is transactional/fail-closed, grants runtime DML/sequence use and owner-scoped defaults, preserves append-only restrictions, denies database/schema `CREATE` and `TEMPORARY`, and revokes historical outbox access.
5. Switch the private environment to `egas_app` credentials.
6. On a fresh database only, set `EGAS_BOOTSTRAP_ADMIN_*` and run `npm run admin:bootstrap`. It refuses if a privileged Admin already exists and always closes the pool before exiting.
7. Stage the approved annual workbook with `npm run data:import -- --file <path> --year 2026 --operator <admin-username>`. Resolve only approved unmapped labels through the Admin alias API, then revalidate. Staging never activates data.
8. When and only when the full batch has zero blocked rows and has operational approval, explicitly run `npm run data:activate -- --batch <UUID> --operator <admin-username>`.
9. Run `npm run pilot:check`, then `npm run dev`.

Existing installations must not recreate the database or run the frozen logical SQL. The migration runner recognizes the existing CAP-era physical schema as the immutable baseline, verifies all expected tables, preserves migration 001/checksum history, and applies only missing versioned SQL. Fresh empty installations use the repository baseline and the same versioned migrations.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the Express API with TypeScript watch mode. |
| `npm start` | Start the built Express API. Run `npm run build` first. |
| `npm run build` | Compile production JavaScript and copy SQL assets. |
| `npm test` | Run isolated Vitest/PostgreSQL-compatible parity tests; never the live DB. |
| `npm run typecheck` | Type-check without emitting files. |
| `npm run db:migrate` | Apply the preserved baseline when empty and missing versioned migrations. |
| `npm run admin:bootstrap` | Transactionally create the first privileged Admin. |
| `npm run data:import -- --file <xlsx> --year <YYYY> --operator <username>` | Securely inspect, stage, normalize, route, and validate without activation. |
| `npm run data:revalidate -- --batch <UUID> --operator <username>` | Deterministically revalidate an unactivated staged batch after approved alias changes. |
| `npm run data:activate -- --batch <UUID> --operator <username>` | Explicitly and transactionally activate a zero-blocked full annual snapshot. |
| `npm run pilot:check` | Check runtime role, routing units, Admin, authority coverage, and snapshot. |
| `npm run security:check` | Secret scan, dependency audit, typecheck, and tests. |

`pilot:check` is expected to exit non-zero until all 22 active routing units have active primary-authority coverage and an annual employee snapshot is activated. Do not invent mappings or synthetic employee data to make it green.

See [docs/phase2a-api.md](docs/phase2a-api.md), [docs/phase2b-data-routing.md](docs/phase2b-data-routing.md), [docs/postgresql-implementation.md](docs/postgresql-implementation.md), [docs/cap-to-node-parity.md](docs/cap-to-node-parity.md), and [PILOT_SETUP.md](PILOT_SETUP.md).

## Security/repository policy

Never commit credentials, real HR workbooks, signatures, generated employee PDFs, or database backups. Never log passwords, raw session/CSRF tokens, or database credentials. Untrusted SQL values must always use bound PostgreSQL parameters. Workflow state/snapshot/actor fields remain unavailable through generic client-writable CRUD.
