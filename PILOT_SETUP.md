# Full-stack pilot setup

This runbook starts the React/Express/PostgreSQL application without fabricating annual employee data or authority assignments.

## Controlled database setup

1. Install Node.js 22+ and PostgreSQL, then run `npm install` and `npm run setup`.
2. Create an empty database, a non-superuser schema/migration-owner login, and a separate restricted runtime login. The runtime must not own database objects, inherit the owner, or receive `CREATE`, `TEMPORARY`, `CREATEDB`, `CREATEROLE`, replication, `BYPASSRLS`, or superuser privileges.
3. Copy `.env.example` to `services/api/.env`. Initially use migration-owner credentials, generate a unique fingerprint secret, and set private signature/PDF storage locations. Production requires HTTPS and secure cookies.
4. Run `npm run db:migrate`. Do not import the frozen logical SQL and do not recreate an existing database. Migrations 001-006 are checksum-protected and immutable.
5. Apply `services/api/db/operations/least-privilege-role.sql.example` through `psql`, supplying `database_name`, the actual object/schema owner, and `runtime_role`. The script validates object ownership and runtime restrictions before transactional grants.
6. Change `EGAS_DB_*` to the restricted `egas_app` credentials.
7. On a fresh database only, set temporary `EGAS_BOOTSTRAP_ADMIN_*` values and run `npm run admin:bootstrap`. Remove the bootstrap values afterward.

## Genuine operational data

1. Run `npm run data:import -- --file <approved-xlsx-path> --year 2026 --operator <active-admin-username>`. This local operator CLI inspects/stages/validates and never activates the batch; there is intentionally no browser upload endpoint.
2. Resolve only EGAS-approved exact aliases in the Admin portal, then run `npm run data:revalidate -- --batch <UUID> --operator <active-admin-username>`.
3. If any rows remain `BLOCKED`, stop. After operational approval and only for a complete zero-blocked batch, run `npm run data:activate -- --batch <UUID> --operator <active-admin-username>`.
4. Configure genuine active primary authority assignments for each active routing unit through the Admin portal. Configure temporary delegations only from real decisions and dates.
5. Rerun the least-privilege grant script after every controlled migration, then run `npm run pilot:check` as `egas_app`.

The known current real-data blockers are:

- authority coverage: `0/22` until genuine primary assignments are entered;
- active annual snapshot: absent until a genuine valid batch is explicitly activated.

These are valid application empty states. `pilot:check` should exit non-zero until both are resolved. Do not insert synthetic authorities, requests, employee snapshots, or routing values into `egas_workflow_dev` to make it green.

## Quality gates

From the repository root run:

```powershell
npm run build
npm test
npm run typecheck
npm run security:check
npm audit
npm run pilot:check
```

Tests use isolated synthetic databases/fixtures and refuse the live development database. `pilot:check` is read-only and may legitimately be the only non-zero command while genuine setup remains incomplete.

Optional Arabic PDF visual check:

```powershell
npm run pdf:visual-check --workspace @egas/api
```

It writes only synthetic, ignored temporary evidence under `services/api/tmp`.

## Start the application

For local development, use two terminals:

```powershell
# Terminal 1
npm run dev

# Terminal 2
npm run dev:web
```

Open `http://127.0.0.1:5173`. Vite proxies `/api`, `/health`, and `/ready` to `http://127.0.0.1:4004`.

For production, build both workspaces with `npm run build`, serve `apps/web/dist` through the approved same-origin HTTPS reverse proxy/static server, route `/api`, `/health`, and `/ready` to the built Express API (`npm start`), and keep signature/PDF storage private. Do not serve private storage as static files.

## Migration readiness failures

- Annual activation fails closed with `IMPORT_MIGRATION_REQUIRED` until migration 002 is recorded.
- Workflow creation/transitions fail closed with `WORKFLOW_MIGRATION_REQUIRED` until the required workflow migrations are recorded.
- Frozen final PDF evidence requires migration 006; do not bypass the readiness check.

See [docs/phase3a-workflow-api.md](docs/phase3a-workflow-api.md) for REST/actions, [docs/postgresql-implementation.md](docs/postgresql-implementation.md) for physical authority, and [README.md](README.md) for all commands and migration hashes.
