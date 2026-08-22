# Local Development

## Prerequisites

- Git
- Node.js 22 LTS or a supported newer Node release (`.node-version` specifies 22)
- npm from the Node installation
- PostgreSQL 14 or newer, installed and running locally

Docker, `psql.exe`, an ORM, and alternate database engines are not used. The setup communicates with PostgreSQL through the existing Node `pg` driver.

## Clean-clone setup

```bash
git clone https://github.com/Ossawy/EGAS_Promotion-Secondment_Workflow_System_v2.git
cd EGAS_Promotion-Secondment_Workflow_System_v2
npm ci
npm run dev:setup
npm run dev:check
npm run dev:all
```

Open <http://localhost:5173>. The API binds exactly to <http://localhost:4004> and Vite binds exactly to port 5173.

First setup asks for a local PostgreSQL administrative connection. Defaults are `127.0.0.1:5432`, maintenance database `postgres`, and administrative role `postgres`. Password input is hidden and the administrative password is never saved. For non-interactive automation, supply `EGAS_DEV_ADMIN_HOST`, `EGAS_DEV_ADMIN_PORT`, `EGAS_DEV_ADMIN_USER`, `EGAS_DEV_ADMIN_DATABASE`, and `EGAS_DEV_ADMIN_PASSWORD` only in the setup process environment.

## What `dev:setup` does

The command:

1. verifies Node and installed dependencies;
2. verifies PostgreSQL 14+ and provisioning privileges;
3. creates local database `egas_workflow_dev`;
4. creates owner role `egas_dev_owner` and runtime role `egas_dev_app` with strong generated passwords;
5. writes the restricted runtime configuration to ignored `services/api/.env`;
6. writes only the owner migration connection to ignored `.egas-local/migration.env`;
7. applies current checksummed v5 migrations;
8. grants runtime data access without schema ownership or role/database creation privileges;
9. creates synthetic v5 accounts, memberships, units, managers, routing units, and reference rows;
10. generates a synthetic approved-layout workbook and passes it through the real stage, validation, and activation pipeline;
11. creates ignored private signature/PDF storage directories.

The setup never saves PostgreSQL administrative credentials, never runs the API as the owner, and never overwrites `services/api/.env` or local credential files. A second successful run validates and reuses the environment without rotating passwords or duplicating data.

If the standardized database or roles already exist without this checkout's local marker, setup refuses to adopt or alter them.

## Owner and runtime separation

- `egas_dev_owner` owns `egas_workflow_dev` and is used only by `npm run dev:migrate`.
- `egas_dev_app` has data-access grants required by the application but cannot create databases, create roles, or own/migrate the schema.
- `services/api/.env` contains only runtime credentials.
- `.egas-local/migration.env` contains only the dedicated migration-owner connection.

Production configuration and `npm run db:migrate` are unchanged.

## Synthetic accounts and annual data

Synthetic login credentials are generated once and stored at:

```text
.egas-local/DEV_ACCOUNTS.txt
```

They include an Admin, HR/ORG managers and employees, and managers/employees for three routing-specific AUTH units. `dev.hr.employee2` is the forced-password-change example.

The ignored generated workbook is stored under `.egas-local/generated/`. Its sheets are `البيانات الاساسية` and `نيابة مساعد`; its performance values rotate through `ممتاز`, `جيد جدا`, and `جيد`. All rows are synthetic and validation must be warning-free before activation. The known `PROMOTION_DEPARTMENT_REQUIRED` limitation remains unchanged because the approved workbook contract does not provide that unsupported field.

`npm run dev:seed` is idempotent. It reuses matching objects and the active annual snapshot, and refuses conflicting or credential-less partial data rather than resetting passwords.

## Daily commands

```bash
npm run dev:all       # API watch server + Vite; Ctrl+C stops both
npm run dev:check     # readiness, storage, and exact-port diagnostics
npm run dev:migrate   # apply new migrations with the local owner only
npm run dev:seed      # repair/reuse synthetic hierarchy and annual data
```

`dev:all` fails if port 4004 or 5173 is occupied. Vite has `strictPort: true` and never moves silently to 5174.

## Troubleshooting

### PostgreSQL is unreachable

Start the local PostgreSQL service and confirm its host/port. On Windows, this is commonly a service named for the installed PostgreSQL version. Setup does not require `psql.exe` on `PATH`.

### Administrative login fails

Confirm the maintenance database, role, and password. The role needs `CREATEDB` and `CREATEROLE` for first setup, or must be a local PostgreSQL superuser. Those credentials are not needed on later valid runs.

### Migration permission error

Use `npm run dev:migrate`, not the runtime `db:migrate` configuration. If `.egas-local/migration.env` is missing, do not substitute a production or superuser credential; repair the local environment explicitly.

### `EADDRINUSE` or occupied port

Run `npm run dev:check`. Stop the process using 4004 or 5173. Ports are fixed intentionally because changing the frontend origin would break trusted-Origin validation.

### Origin rejected

Use <http://localhost:5173> or <http://127.0.0.1:5173>. Both are generated in `EGAS_ALLOWED_ORIGINS`. Do not start Vite on another port.

### Local storage is not writable

Grant your operating-system account write access to `.egas-local/storage/`. Do not move signature or PDF storage under a public frontend directory.

## Stopping and removal

Press Ctrl+C in the `dev:all` terminal. The supervisor stops both API and Vite child process trees.

No automatic destructive reset is provided. To remove the environment completely:

1. stop EGAS;
2. connect to local PostgreSQL using an administrator;
3. confirm the target is exactly `egas_workflow_dev` on localhost;
4. terminate connections and drop database `egas_workflow_dev`;
5. drop roles `egas_dev_app` and `egas_dev_owner` after confirming they own no other objects;
6. delete ignored `.egas-local/` and `services/api/.env`.

Never apply these removal steps to an arbitrary host/database, and never commit the ignored local files.

