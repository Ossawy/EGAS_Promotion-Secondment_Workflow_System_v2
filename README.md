# EGAS Promotion & Secondment Workflow System

Phase 1 provides the backend/database foundation for the EGAS Promotion & Secondment Workflow System. The repository currently contains a SAP CAP Node.js/TypeScript modular monolith under `services/cap-api`; frontend applications and full P1-P5/S1-S5 workflow transitions are intentionally outside this phase.

## Implemented foundation

- CAP 10 Node.js project with TypeScript, generated CDS types, PostgreSQL through `@cap-js/postgres`, and SQLite only for isolated tests.
- Domain-separated CDS for reference/routing, accounts/sessions, annual HR snapshots/import staging, authority assignments/delegations, immutable signatures, workflow records, notifications, notes, audit, and PDF metadata.
- The final 22 routing units, five job categories, and two qualification-status values as repository-owned reference seeds.
- Replaceable `AuthenticationProvider` and `EmployeeDataProvider` interfaces with local PostgreSQL implementations.
- Active-role authentication middleware that authorizes a session under exactly one selected role rather than unioning all account roles.
- A controlled first-Admin bootstrap command using Argon2id and environment-supplied values; there is no public Admin registration endpoint.
- A validation-only annual `.xlsx` command skeleton with file/container/size limits, exact header-name validation, duplicate-header rejection, row bounds, and no direct active-snapshot writes.
- Read-only reference endpoints and explicit Auth/Admin/Employee Data/Workflow/Audit/Document/Health service boundaries. Workflow and audit persistence are not exposed as generic CRUD.
- Versioned PostgreSQL integrity migration for partial indexes, checks, atomic selection defense, append-only tables, and anti-self-delegation protection.

The complete database comparison is in [docs/database-parity.md](docs/database-parity.md).

## Prerequisites

- Node.js 22 or newer.
- PostgreSQL on a private/local interface.
- Two PostgreSQL roles for a real deployment:
  - a schema owner/migration role used only for controlled deployment;
  - a restricted runtime application role that is not a superuser, table owner, owner-role member, or `BYPASSRLS` role.

The application browser must never receive either database credential.

## Local backend setup

1. Install the locked dependencies from the repository root:

   ```powershell
   npm install
   npm run setup
   ```

2. On a fresh installation, connect as a controlled PostgreSQL administrator and create separate login roles and an empty database. The names below are examples; keep the three names consistent in later commands. Use `\password` or an approved secret manager so passwords do not enter shell history:

   ```sql
   CREATE ROLE egas_migrator LOGIN
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   \password egas_migrator

   CREATE ROLE egas_app LOGIN
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   \password egas_app

   CREATE DATABASE egas_workflow_dev OWNER egas_migrator;
   \connect egas_workflow_dev
   ALTER SCHEMA public OWNER TO egas_migrator;
   ```

   `egas_migrator` is the database/public-schema owner used only for controlled deployment. `egas_app` must not own the database or schema, inherit the owner role, or receive `CREATE`, superuser, `CREATEDB`, `CREATEROLE`, replication, or `BYPASSRLS` privileges.

3. Copy the example into the CAP project and edit only the untracked copy:

   ```powershell
   Copy-Item .env.example services/cap-api/.env
   ```

4. Configure the untracked/private CAP binding with the database name and `egas_migrator` credentials. Run the CAP-owned schema deployment and repository migrations:

   ```powershell
   npm run db:migrate
   ```

   This invokes CAP schema evolution/reference seeding before applying the versioned PostgreSQL-only migrations. Do not run the frozen logical-baseline SQL.

5. Still using the migration owner, apply the idempotent runtime grants after every controlled migration. The script verifies the three ownership/role boundaries before changing privileges:

   ```powershell
   psql --dbname egas_workflow_dev --username egas_migrator `
     --set=database_name=egas_workflow_dev `
     --set=schema_owner=egas_migrator `
     --set=runtime_role=egas_app `
     --file services/cap-api/db/operations/least-privilege-role.sql.example
   ```

   This covers all current CAP tables, `cds_outbox_messages`, required sequence access, and owner-scoped default privileges for future tables/sequences. It then removes UPDATE/DELETE from append-only entities and write access from `egas_SchemaMigration`. The runtime role receives no database/schema `CREATE` privilege.

6. Switch the private CAP binding from migration-owner credentials to the restricted `egas_app` credentials. Set the machine-local `EGAS_BOOTSTRAP_ADMIN_*` values and, on a fresh database only, run:

   ```powershell
   npm run admin:bootstrap
   ```

   The bootstrap transaction creates the first privileged Admin, closes the CAP database pool, and exits normally. If a privileged Admin already exists, the command refuses safely; do not alter or delete that Admin merely to rerun bootstrap.

7. Run the preflight:

   ```powershell
   npm run pilot:check
   ```

   During the Phase 1/Phase 2 boundary, this command is expected to exit non-zero until all 22 active routing units have active primary-authority coverage and an annual employee snapshot has been activated. Do not invent authority mappings or activate synthetic employee data to make the preflight green.

8. Start the API:

   ```powershell
   npm run dev
   ```

9. Run the quality gates:

   ```powershell
   npm run build
   npm test
   npm run security:check
   ```

## Existing database warning

The frozen logical SQL uses tables such as `egas.routing_unit`; CAP persistence uses repository-owned CDS artifacts with CAP physical names such as `public.egas_routingunit`. `npm run db:migrate` checks for the handwritten baseline and stops before deployment if it finds that schema without the CAP schema. It never drops or recreates a database.

If a clean development database was initialized from the handwritten SQL, back it up, prove that it contains no required data, and obtain explicit approval before recreating it for CAP. If it contains useful data, design and review a one-time data migration. Do not maintain both schemas in parallel.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start CAP in watch mode against configured PostgreSQL. |
| `npm run pilot` | Phase 1 backend-only pilot alias; frontend is not part of this task. |
| `npm run build` | Clean generated output, compile CDS, generate types, typecheck, and produce production CAP/PostgreSQL build artifacts. |
| `npm test` | Run the SQLite-isolated foundation tests with synthetic identities only. |
| `npm run db:migrate` | Apply CAP schema evolution/seeds plus versioned PostgreSQL invariants. |
| `npm run db:deploy` | Raw CAP deploy only; normal setup should use `db:migrate`. |
| `npm run admin:bootstrap` | Create the first Manage-Admins account from environment values. |
| `npm run data:import -- --file <xlsx> --year <YYYY>` | Validate workbook safety and exact headers without database writes in Phase 1. |
| `npm run pilot:check` | Check restricted DB identity, 22 routing units, privileged Admin, annual snapshot, and authority coverage. |
| `npm run security:secrets` | Scan the worktree for supported secret signatures. |
| `npm run security:scan` | Run dependency audit (high+) and TypeScript checks. |
| `npm run security:check` | Run secret scan, dependency/type checks, and automated tests. |

## Admin bootstrap

Set the `EGAS_BOOTSTRAP_ADMIN_*` variables only in machine-local configuration, use a temporary password of at least 14 characters, then run `npm run admin:bootstrap` once on a fresh database. The command takes a PostgreSQL advisory transaction lock, refuses to run when a Manage-Admins assignment already exists, stores only an Argon2id hash, and sets `mustChangePassword=true`. It never prints the password. Whether the transaction succeeds or fails, the standalone command explicitly drains and closes its CAP database pool before exiting.

## Annual import status

The Phase 1 command is intentionally validation-only. It accepts `.xlsx` (not `.xls`/`.xlsm`), checks the ZIP container signature and bounded size/row count, finds exactly one sheet with the exact non-duplicated approved headers, and writes nothing. Transactional staging, normalization, routing-alias resolution, validation reporting, and explicit activation are the recommended next phase.

## Database ownership

The ownership chain is:

`Final logical baseline SQL -> CAP CDS implementation -> versioned PostgreSQL migrations`

The baseline SQL is retained for traceability and parity review. Developers do not independently edit and deploy it as a second runtime schema.

Use the schema/migration owner only for `db:migrate` and the post-migration grant script. Run the service, bootstrap command, and pilot check with the restricted runtime role. Owner-scoped default privileges cover future CAP-created tables and sequences; every future append-only migration must revoke UPDATE/DELETE in the same release and extend the explicit restriction list in the grant script.

## Security and repository policy

`.env`, private CAP bindings, real HR spreadsheets, signature storage, generated employee PDFs, database backups, local databases, and build artifacts are ignored. Reference seeds contain no accounts, staff IDs, HR rows, passwords, or signatures. Any committed real secret must be rotated/revoked first, then removed from Git history and rescanned.

Production authentication is intentionally fail-closed behind the local session middleware. Phase 1 implements password/session primitives and session resolution, but does not expose login/logout/password-change HTTP endpoints yet; those endpoints require the complete rate-limit, CSRF, rotation, revocation, and safe-error flow in the next authentication phase.
