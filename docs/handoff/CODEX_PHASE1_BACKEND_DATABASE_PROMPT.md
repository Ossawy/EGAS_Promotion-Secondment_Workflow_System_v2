# Codex Prompt — Phase 1 Backend & Database Foundation

You are implementing Phase 1 of the backend and database for the **EGAS Promotion & Secondment Workflow System**.

## Authoritative requirements

Before making changes, inspect the repository and read these files completely:

1. `EGAS_Requirements_Architecture_Baseline_v2.0_Final.pdf`
2. `EGAS_PostgreSQL_Logical_Schema_v1.0_Final.sql`

The Requirements & Architecture Baseline v2.0 is the authoritative business/architecture specification.

The PostgreSQL Logical Schema v1.0 FINAL is the frozen pre-implementation logical database baseline.

Do not use or derive implementation decisions from older v0.x schema files or older SRS/Architecture drafts when they conflict with these final files.

Do not invent missing business rules.

---

## Selected architecture — do not change it

Backend:

* SAP CAP for Node.js
* TypeScript
* CAP CDS
* Modular monolith

Database:

* PostgreSQL
* `@cap-js/postgres`

Frontend, which is outside the scope of this task:

* React
* TypeScript
* Vite
* UI5 Web Components for React

Authentication for v1:

* local application authentication/session provider
* designed behind a replaceable authentication boundary for future AD/SSO

Employee data for v1:

* PostgreSQL annual snapshots imported from approved Excel data
* no direct SAP database connection
* business logic must use an `EmployeeDataProvider` abstraction so a future SAP integration can replace the local provider

Do NOT introduce:

* Prisma
* NestJS
* Sequelize
* TypeORM
* microservices
* direct SAP database access
* direct Active Directory integration
* frontend implementation
* real EGAS employee data
* real passwords
* real signatures
* real HR spreadsheets in Git

---

# Goal of this task

Build the **backend/database foundation only**.

Do NOT implement the full Promotion or Secondment workflow yet.

At the end of this phase I want a clean CAP TypeScript project that connects to PostgreSQL, expresses the final logical database model in CDS/migrations, has the correct modular structure, and can be run and tested locally.

---

# Step 1 — Inspect before changing

First inspect:

* repository structure
* package.json files
* existing CAP/CDS files
* existing environment/config files
* Git status
* existing database scripts
* existing tests

Do not overwrite working project files blindly.

Report any important conflict between the current repository and the final architecture before choosing the safest implementation.

Do not stop merely because minor details are absent. Use the final requirements/schema as the source of truth.

---

# Step 2 — Establish the CAP TypeScript project

Create or complete the CAP backend under the architecture-defined backend location, preferably:

`services/cap-api`

Use a normal SAP CAP Node.js project with TypeScript support.

Add the current mutually compatible CAP packages required for:

* CAP Node.js
* TypeScript
* CDS TypeScript declarations/types
* PostgreSQL through `@cap-js/postgres`

Do not hard-code package versions from this prompt. Resolve currently compatible stable versions through the normal package manager.

Create appropriate:

* `package.json`
* `tsconfig.json`
* CAP configuration
* development scripts
* test scripts

The project must build successfully.

---

# Step 3 — PostgreSQL configuration

Configure CAP to use PostgreSQL.

Database credentials must come from runtime environment configuration.

Do not commit passwords or actual connection strings.

Provide an `.env.example` containing variable names/placeholders only.

The actual local `.env` or equivalent secret configuration must remain ignored by Git.

The runtime application's PostgreSQL user must eventually be a restricted application role rather than the PostgreSQL superuser.

Do not make the application depend on a developer's local PostgreSQL username.

---

# Step 4 — Convert the final logical schema into implementation models

Treat `EGAS_PostgreSQL_Logical_Schema_v1.0_Final.sql` as the logical baseline.

Translate the model into maintainable CAP CDS domains.

Keep major domains separated conceptually, for example:

* reference/routing
* accounts/authentication
* HR annual snapshots/import staging
* approving-authority assignments/delegations
* signatures
* workflow requests/candidates/iterations/tasks
* Promotion/Secondment decision data
* notifications
* notes
* audit
* PDF metadata

You may split the CDS model into multiple files when that improves maintainability.

Preserve the semantics, relationships, constraints and important indexes from the final SQL baseline.

Do not rename concepts simply for convenience when doing so would make the implementation diverge from the requirements.

Important entities include, but are not limited to:

* RoutingUnit
* RoutingUnitSourceAlias
* JobCategoryReference
* QualificationStatusReference
* UserAccount
* UserAccountRole
* AuthSession
* AuthLoginAttempt
* SecurityEvent
* ImportBatch
* EmployeeImportStagingRow
* Employee
* EmployeeAnnualSnapshot
* ApprovingAuthorityAssignment
* AuthorityDelegation
* UserSignatureAsset
* WorkflowRequest
* RequestFormSection
* RequestCandidate
* WorkflowIteration
* StageTask
* StageReceivedSnapshot
* SecondmentPositionOption
* PromotionDecision
* StageAction
* WorkflowNote
* WorkflowSignoff
* Notification
* AuditEvent
* PdfGenerationLog

Maintain the final role model:

* ADMIN
* EMPLOYEE_AFFAIRS
* ORGANIZATION
* APPROVING_AUTHORITY

A user may have multiple roles, but only one operational active role applies to an action.

Do not union permissions from multiple roles.

---

# Step 5 — Avoid two competing database sources of truth

The SQL file is the pre-implementation logical baseline.

Once the CAP implementation is established, the repository-owned CDS model and migrations must become the implementation source of truth.

Do NOT create a permanent architecture where developers must independently maintain:

1. the complete handwritten SQL schema, and
2. a different CAP CDS schema.

Instead:

* implement the logical model in CDS;
* use migration SQL only for database-specific behavior that genuinely cannot/should not be represented in CDS;
* clearly document those exceptions.

Because the development PostgreSQL database may already have been initialized using `EGAS_PostgreSQL_Logical_Schema_v1.0_Final.sql`, do not blindly drop or recreate it.

Produce a comparison/parity report identifying:

* logical SQL concept
* CDS implementation
* service-layer invariant where applicable
* database-specific migration where applicable

If switching the clean development database from the handwritten logical SQL schema to CAP-generated persistence requires recreating the empty development database, explain that clearly before any destructive action.

Never destroy real or non-development data.

---

# Step 6 — Database-specific invariants

The final SQL contains some PostgreSQL-specific defense-in-depth behavior.

Do not blindly translate every business rule into PostgreSQL triggers.

Apply this rule:

* domain structure → CDS
* workflow/business authorization rules → CAP service layer
* database-enforceable integrity constraints → database/CDS where appropriate
* PostgreSQL-specific defense-in-depth only where justified

Preserve required security/integrity behavior.

Document whenever the implementation location differs from the original logical SQL.

---

# Step 7 — Seed reference data only

Create safe repository-owned seed/reference data for configuration that is explicitly part of the requirements, including the approved routing units and fixed reference values.

The final schema contains 22 routing units.

Do NOT seed:

* actual Employee Affairs users
* actual Organization users
* actual Administrators
* actual Approving Authorities
* real staff IDs
* real names
* real passwords
* real HR records
* real signatures

Use synthetic test fixtures only when needed.

---

# Step 8 — Create service boundaries, but not full workflow logic

Establish CAP service definitions and module boundaries needed by later phases.

Recommended conceptual boundaries include:

* Auth
* Admin
* Employee/HR Data
* Routing
* Workflow
* Audit
* PDF/Document

Do not expose sensitive tables as unrestricted generic CRUD endpoints.

In particular, workflow state/status fields must not be arbitrarily writable through generic CRUD.

Later workflow transitions will use explicit CAP actions.

For this phase, define the boundaries/interfaces and minimal infrastructure required to prove that the project architecture works.

Do not implement P1-P5 or S1-S5 workflow transitions yet.

---

# Step 9 — Provider interfaces

Create clean interfaces/boundaries for future replaceability.

At minimum establish:

`AuthenticationProvider`

and

`EmployeeDataProvider`

Implement or stub the local v1 versions appropriately:

`LocalAuthenticationProvider`

`LocalEmployeeDataProvider`

The local EmployeeDataProvider reads the approved active PostgreSQL annual snapshot.

Workflow code in future phases must depend on the provider interface rather than directly depending on SAP or Excel parsing.

Do not implement a SAP provider other than an interface/stub boundary.

---

# Step 10 — Annual import module skeleton

Create the module structure for:

`lib/import`

and a command entry point corresponding conceptually to:

`npm run data:import -- --file <xlsx> --year <YYYY>`

In this Phase 1 task, it is acceptable for the importer to be only a properly structured skeleton if implementing the complete validated importer would substantially expand scope.

However, its architecture must support:

* XLSX input
* required-header validation by header name
* staging
* normalization
* routing alias resolution
* validation
* activation

Do not directly insert Excel rows into active employee snapshot tables.

Do not import a real EGAS workbook during automated tests.

---

# Step 11 — Admin bootstrap skeleton

Prepare the infrastructure for a command conceptually equivalent to:

`npm run admin:bootstrap`

There must never be a public Admin registration endpoint.

The first privileged Admin will eventually be created through this bootstrap command.

If implementing the complete bootstrap securely is small and well-contained, implement it now.

Otherwise create the proper module/command structure and leave the business implementation for the next phase.

Never hard-code an Admin password.

---

# Step 12 — Testing

Add automated tests for this foundation.

At minimum verify:

* CAP application starts
* PostgreSQL configuration can be resolved
* CDS model compiles
* fixed reference data can be queried
* entity relationships compile correctly
* no unrestricted endpoint allows arbitrary mutation of protected workflow status
* synthetic fixtures do not contain real EGAS personal data

Use CAP-compatible testing patterns.

Do not require production services or SAP connectivity to run tests.

---

# Step 13 — Developer scripts

Provide clear package scripts or equivalent commands for common local tasks such as:

* development server
* build/typecheck
* test
* database deployment/migration
* Admin bootstrap
* annual-data import
* pilot/preflight check

Scripts that are not fully implemented yet may clearly say so, but do not silently provide broken commands.

---

# Step 14 — Documentation

Create/update developer documentation explaining:

## Local backend setup

How to:

1. install dependencies;
2. configure PostgreSQL locally;
3. configure environment variables;
4. deploy/migrate the CAP database;
5. start the CAP API;
6. run tests.

## Database ownership

Clearly document:

`Logical baseline SQL -> CAP CDS implementation -> versioned migrations`

After implementation begins, CDS/migrations are the runtime implementation source of truth.

## Security

Document that:

* `.env` is ignored;
* real employee spreadsheets are ignored;
* signature images are ignored;
* generated PDFs are ignored;
* database backups are ignored;
* secrets are never committed.

---

# Step 15 — Preserve the final workflow requirements for later implementation

Although the full workflow must NOT be implemented in this task, the data model must remain capable of implementing these final sequences:

Promotion:

`P1 Employee Affairs -> P2 Organization -> P3 Employee Affairs -> P4 Approving Authority -> P5 Employee Affairs`

Secondment:

`S1 Employee Affairs -> S2 Organization -> S3 Approving Authority -> S4 Organization -> S5 Employee Affairs`

Also preserve model support for:

* workflow iterations/restarts;
* atomic Organization task claiming;
* immutable received-stage snapshots;
* View as PDF of exactly what an actor received;
* draft and final PDF states;
* append-only workflow notes;
* candidate-level chronological notes;
* mandatory P1/S1 Employee Affairs signoff;
* mandatory P2/S2 Organization signoff;
* immutable signature asset versions;
* routing-unit authority assignments;
* temporary authority delegation;
* audit events;
* notifications.

Do not simplify the model in a way that prevents these behaviors.

---

# Definition of done

Phase 1 is complete only when:

1. CAP Node.js + TypeScript backend exists and builds.
2. PostgreSQL is configured through CAP.
3. Final logical database domains are represented in CDS/migrations with documented parity.
4. Reference seeds exist without real employee/user data.
5. Service/module boundaries exist.
6. AuthenticationProvider and EmployeeDataProvider boundaries exist.
7. Import and Admin-bootstrap command structure exists.
8. Automated tests pass.
9. Environment secrets are outside Git.
10. Developer setup documentation exists.
11. No frontend is unnecessarily modified.
12. No full Promotion/Secondment workflow has been prematurely implemented.

---

# Required final response

When finished, do not just say "done."

Give me:

1. Summary of what was implemented.
2. Files created.
3. Files modified.
4. Commands I need to run.
5. Environment variables I need to configure.
6. Database/CDS parity summary.
7. Test results.
8. Any requirement that could not be implemented exactly and why.
9. Any security concern found.
10. Exact recommended next implementation phase.

Do not hide failing tests or unresolved implementation differences.
