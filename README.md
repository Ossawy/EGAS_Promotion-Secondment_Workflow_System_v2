# EGAS Promotion & Secondment Workflow System

An Arabic RTL full-stack application for the EGAS Promotion and Secondment workflows:

```text
React 19 + TypeScript + Vite
        -> same-origin HTTPS REST/JSON (cookie session + CSRF)
Node.js 22+ + TypeScript + Express 5
        -> pg / node-postgres with parameterized SQL
PostgreSQL
```

The v3.0 requirements/architecture baseline controls business behavior. The approved Stitch screenshots and HTML under `docs/uis_and_html` control the visual appearance of Login, Employee Affairs, Organization, and Approving Authority screens. The Admin portal uses the same EGAS green/white visual language. The application has no SAP CAP, CDS, CQN, UI5, Fiori, BTP, OData, GraphQL, ORM, direct SAP database, or direct Active Directory dependency.

## Implemented scope

- Cookie-based authentication with Argon2id, opaque server-side sessions, mandatory password change, trusted-Origin checks, and double-submit/stored-hash CSRF validation. Session or authentication secrets are never stored in browser storage.
- Exactly one selected active role per session. Backend authorization and navigation never union assigned roles.
- Responsive Arabic RTL React workspace in `apps/web`, with protected routes, loading/error/empty states, role-aware shell, global search, notifications, and accessibility landmarks/keyboard focus.
- Employee Affairs drafts using the real active annual snapshot lookup, candidate freezing, same-routing-unit enforcement, authority options/selection, notes, timeline, and request evidence.
- Administrative dashboards and screens for users/roles, authority mappings, delegations, annual batches/validation/aliases/activation, and bounded audit browsing/PDF reports. Initial workbook import remains operator CLI-only.
- Secondment S1 -> S2 -> S3 -> S4 -> S5 with Organization claim, unlimited proposed positions, qualification compliance, exact authority position choice, confirmation, final review, and stage history.
- Promotion P1 -> P2 -> P3 -> P4 -> P5 with Organization preparation and per-candidate Same Position / Other Position authority decisions. Other Position requires a manually entered target job.
- Explicit return, reject, recall, cancel, and restart actions. Restart creates a new `WorkflowIteration`; old actions, notes, tasks, and evidence remain append-only.
- Mandatory Employee Affairs P1/S1 and Organization P2/S2 signoffs. PNG/JPEG uploads are size/dimension-limited, decoded and canonically re-encoded to PNG with metadata removed, hashed, randomly named, privately stored, and served only through authorized endpoints.
- Working-draft, immutable received-stage, frozen-final, request audit, and Admin routing-period PDFs. Rendering uses structured server data only, no user HTML, network, or `file://` input; concurrency, queue, time, and output size are bounded.
- Role-scoped bounded/paginated history search and recipient-owned in-app notifications with unread counts, mark-read, and request deep links.
- Defense-in-depth for IDOR/BOLA, optimistic versions/advisory locks for race-prone actions, atomic task claim, parameterized SQL, output encoding, defensive HTTP headers, and append-only database triggers/grants.

The application treats no active annual snapshot, missing authority coverage, and empty queues as valid UI states. It does not insert synthetic records into `egas_workflow_dev`.

## Repository layout

```text
apps/web/                         React/TypeScript frontend
services/api/src/                 Express modules and PostgreSQL repositories
services/api/src/db/baseline/     preserved fresh-install physical baseline
services/api/src/db/migrations/   immutable versioned migrations 001-006
services/api/db/operations/       controlled least-privilege deployment SQL
services/api/test/                isolated synthetic backend tests
docs/uis_and_html/                approved UI references
docs/requirements/                authoritative business/schema baselines
```

## Configuration

Node.js 22+ and PostgreSQL are required. Copy `.env.example` to `services/api/.env` and replace every placeholder locally; never commit that file. Normal runtime uses `EGAS_DB_NAME=egas_workflow_dev` and restricted `EGAS_DB_USER=egas_app`. Run migrations and the grant script with the controlled schema/object owner, then switch back to `egas_app`.

Production requires HTTPS, `NODE_ENV=production`, `EGAS_REQUIRE_SECURE_COOKIE=true`, a unique `EGAS_AUTH_FINGERPRINT_SECRET` of at least 32 characters, and private signature/PDF storage outside any web root. The API intentionally does not enable permissive CORS: deploy the web build and API on one origin or behind a same-origin reverse proxy.

## Fresh or upgraded setup

1. Run `npm install` and `npm run setup`.
2. Configure `services/api/.env` temporarily with the schema/migration owner and run `npm run db:migrate`. Existing installations must not recreate the database or import the frozen logical SQL.
3. As the object owner/controlled DBA, apply `services/api/db/operations/least-privilege-role.sql.example` with the actual database, owner, and runtime role parameters. Rerun it after each controlled migration.
4. Switch `EGAS_DB_*` to the restricted `egas_app` credentials.
5. On a fresh database only, configure the temporary `EGAS_BOOTSTRAP_ADMIN_*` values and run `npm run admin:bootstrap`.
6. Stage a genuine approved workbook with `npm run data:import -- --file <path> --year 2026 --operator <admin-username>`. Resolve only approved aliases, revalidate, and activate only a complete zero-blocked batch with operational approval.
7. Configure genuine authority assignments and delegations through the Admin UI. Never fabricate coverage.
8. Run `npm run pilot:check` and the quality commands below.

See [PILOT_SETUP.md](PILOT_SETUP.md) for the operational sequence and expected real-data blockers.

## Local development

Use two terminals from the repository root:

```powershell
# Terminal 1 — API on http://127.0.0.1:4004
npm run dev

# Terminal 2 — web on http://127.0.0.1:5173 with same-origin API proxy
npm run dev:web
```

Open `http://127.0.0.1:5173`. Do not expose either development server directly to untrusted networks.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the Express API in watch mode. |
| `npm run dev:web` | Start the Vite web client and local API proxy. |
| `npm run build` | Build both backend and frontend. |
| `npm start` | Start the already-built API. |
| `npm test` | Run isolated backend and frontend tests; never the live development DB. |
| `npm run typecheck` | Type-check backend and frontend without emitting. |
| `npm run security:check` | Secret scan, dependency audit, typecheck, and all tests. |
| `npm run db:migrate` | Apply the preserved baseline when empty and missing immutable migrations. |
| `npm run admin:bootstrap` | Create the first privileged Admin transactionally. |
| `npm run data:import -- --file <xlsx> --year <YYYY> --operator <username>` | Securely inspect, stage, route, and validate; never activates. |
| `npm run data:revalidate -- --batch <UUID> --operator <username>` | Revalidate an unactivated batch after approved alias changes. |
| `npm run data:activate -- --batch <UUID> --operator <username>` | Explicitly activate a complete, zero-blocked annual snapshot. |
| `npm run pilot:check` | Check runtime role, reference data, Admin, authority coverage, and snapshot. |
| `npm run pdf:visual-check --workspace @egas/api` | Generate a synthetic Arabic PDF for render/visual QA. |

`pilot:check` is expected to remain non-zero until genuine primary-authority coverage exists for all active routing units and a genuine annual snapshot is activated.

## Migration authority and checksums

Applied migration files are immutable; changes require a new migration.

| Version | SHA-256 |
|---|---|
| 001 | `760a0c27322cd44f18bd57854fedccad334aabfe985052e70f853cbb5a2aae6f` |
| 002 | `0d423387e20104188d9755209eabd58f354cff41a30ca7a32ff8350fd1d66b40` |
| 003 | `01e9e6c34657a0a6f15ce8cbbfc322c5dccc97b2a47ec177d1ea3b03662e7ec0` |
| 004 | `bdbdf8846f44ab3474105a46bd2fcd9d0027d6008c4c9062c9a6fa8358e934f7` |
| 005 | `5fa7f568dc8200e51d8d58c72648d5aaf99d352432dec04db2157d199ad276db` |
| 006 | `8edff26bad677d75ba24bd88e2ff9824c61117c89782f32c8b92e787c1c60bf6` |

Runtime authority is the preserved physical baseline plus `services/api/src/db/migrations`. The frozen logical SQL is a design reference, not a deployment script.

## Known stakeholder question

The preserved model can represent overlapping effective delegations but the v3 requirements do not define precedence. Workflow routing therefore accepts zero or one effective delegate and fails closed with `WORKFLOW_AUTHORITY_DELEGATION_AMBIGUOUS` when more than one matches. A stakeholder rule is required before any automatic priority can be implemented.

## Security and data policy

Never commit credentials, real HR workbooks, real signatures, generated employee PDFs, or database backups. Never log passwords, raw session/CSRF tokens, or database credentials. Workflow state, stage, actor, and snapshot fields are changed only by explicit authorized service actions—not generic client-writable CRUD.

Detailed contracts: [Phase 2A API](docs/phase2a-api.md), [Phase 2B data/routing](docs/phase2b-data-routing.md), [workflow API](docs/phase3a-workflow-api.md), [PostgreSQL authority](docs/postgresql-implementation.md), and [CAP retirement parity](docs/cap-to-node-parity.md).
