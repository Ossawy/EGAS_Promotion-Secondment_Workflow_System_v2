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

2. Create a new, empty development database and the separate migration/runtime roles. Do not use the `postgres` superuser as the application's ongoing runtime identity.

3. Copy the example into the CAP project and edit only the untracked copy:

   ```powershell
   Copy-Item .env.example services/cap-api/.env
   ```

4. For the initial schema deployment, temporarily supply the migration-owner credentials through the process environment or a private CAP binding. Run:

   ```powershell
   npm run db:migrate
   ```

   This first invokes CAP schema evolution/reference seeding and then applies the versioned PostgreSQL-only migrations. Afterward, configure `.env` with the restricted runtime role. Use `services/cap-api/db/operations/least-privilege-role.sql.example` as the grant/revoke checklist.

5. Start the API:

   ```powershell
   npm run dev
   ```

6. Run the quality gates:

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

Set the `EGAS_BOOTSTRAP_ADMIN_*` variables only in machine-local configuration, use a temporary password of at least 14 characters, then run `npm run admin:bootstrap`. The command takes a PostgreSQL advisory transaction lock, refuses to run when a Manage-Admins assignment already exists, stores only an Argon2id hash, and sets `mustChangePassword=true`. It never prints the password.

## Annual import status

The Phase 1 command is intentionally validation-only. It accepts `.xlsx` (not `.xls`/`.xlsm`), checks the ZIP container signature and bounded size/row count, finds exactly one sheet with the exact non-duplicated approved headers, and writes nothing. Transactional staging, normalization, routing-alias resolution, validation reporting, and explicit activation are the recommended next phase.

## Database ownership

The ownership chain is:

`Final logical baseline SQL -> CAP CDS implementation -> versioned PostgreSQL migrations`

The baseline SQL is retained for traceability and parity review. Developers do not independently edit and deploy it as a second runtime schema.

## Security and repository policy

`.env`, private CAP bindings, real HR spreadsheets, signature storage, generated employee PDFs, database backups, local databases, and build artifacts are ignored. Reference seeds contain no accounts, staff IDs, HR rows, passwords, or signatures. Any committed real secret must be rotated/revoked first, then removed from Git history and rescanned.

Production authentication is intentionally fail-closed behind the local session middleware. Phase 1 implements password/session primitives and session resolution, but does not expose login/logout/password-change HTTP endpoints yet; those endpoints require the complete rate-limit, CSRF, rotation, revocation, and safe-error flow in the next authentication phase.
