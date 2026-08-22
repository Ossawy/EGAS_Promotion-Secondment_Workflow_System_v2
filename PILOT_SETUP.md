# Full-stack pilot setup

This runbook starts the React/Express/PostgreSQL application without fabricating annual employee data or authority assignments.

## Controlled database setup

1. Install Node.js 22+ and PostgreSQL, then run `npm install` and `npm run setup`.
2. Create an empty database, a non-superuser schema/migration-owner login, and a separate restricted runtime login. The runtime must not own database objects, inherit the owner, or receive `CREATE`, `TEMPORARY`, `CREATEDB`, `CREATEROLE`, replication, `BYPASSRLS`, or superuser privileges.
3. Copy `.env.example` to `services/api/.env`. Initially use migration-owner credentials, generate a unique fingerprint secret, and set private signature/PDF storage locations. Production requires HTTPS and secure cookies.
4. Run `npm run db:migrate` against an empty v5 database. Applied migrations are checksum-protected and immutable; add a new migration for every later schema change.
5. Apply `services/api/db/operations/least-privilege-role.sql.example` through `psql`, supplying `database_name`, the actual object/schema owner, and `runtime_role`. The script validates object ownership and runtime restrictions before transactional grants.
6. Change `EGAS_DB_*` to the restricted `egas_app` credentials.
7. On a fresh database only, set temporary `EGAS_BOOTSTRAP_ADMIN_*` values and run `npm run admin:bootstrap`. Remove the bootstrap values afterward.

## Genuine operational data

1. Run `npm run data:import -- --file <approved-xlsx-path> --year 2026 --operator <active-admin-username>`. This local operator CLI inspects/stages/validates and never activates the batch; there is intentionally no browser upload endpoint.
2. Resolve only EGAS-approved exact aliases through the controlled administration tooling, then run `npm run data:revalidate -- --batch <UUID> --operator <active-admin-username>`.
3. If any rows remain `BLOCKED`, stop. After operational approval and only for a complete zero-blocked batch, run `npm run data:activate -- --batch <UUID> --operator <active-admin-username>`.
4. Create the active HR and ORG operational units, one AUTH operational unit for every active routing unit, active operational memberships, and exactly one current manager assignment per unit. Do not create role grants, authority assignments, or delegation records from the superseded model.
5. Rerun the least-privilege grant script after every controlled migration, then run `npm run pilot:check` as `egas_app`.

The known current real-data blockers are:

- operational hierarchy coverage until HR/ORG/AUTH units and their genuine managers are configured;
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

- A database containing the obsolete `egas_*` schema is not a v5 database. Stop and create a separate empty database; do not destructively migrate it in place.
- Missing current migrations must be resolved only through `npm run db:migrate`; do not manually fabricate `schema_migration` rows.

See [docs/architecture/EGAS_Implementation_Blueprint_v1.0.md](docs/architecture/EGAS_Implementation_Blueprint_v1.0.md), the current phase implementation records under `docs/implementation/`, and [README.md](README.md) for the active v5 commands and contracts.
