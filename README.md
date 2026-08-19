# EGAS Promotion & Secondment Workflow System v2

Active repository for the **v5 redesign** of the EGAS Promotion & Secondment Workflow System.

This repository was created from the last working pre-v5 implementation so proven technical infrastructure can be reused. The copied implementation is **not** the authority for current workflow behavior. Development from this point forward follows the v5.2 requirements and implementation blueprint.

## Current project status

```text
Requirements analysis      FROZEN for implementation
System architecture        FROZEN for implementation
Detailed design/ERDs       FROZEN for implementation
Implementation blueprint   READY
Repository                  v2 active
Application source          copied pre-v5 implementation, being redesigned in phases
```

Before Phase 1 begins, the repository may still contain pre-v5 source code and database migrations. They are retained only as technical reference until the corresponding v5 phase replaces them.

## Authoritative documents

Business and design authority, in order:

1. `docs/requirements/EGAS_Requirements_System_Architecture_Baseline_v5.2_Implementation_Ready.pdf`
2. `docs/architecture/EGAS_Implementation_Blueprint_v1.0.md`
3. `AGENTS.md`
4. Current v5 physical PostgreSQL schema/migrations and completed-phase implementation docs

`docs/uis_and_html/` is a **visual-reference source only**. It must not be used to infer current permissions, hierarchy, workflow transitions, or data rules.

Older v3/v4 requirements, old phase prompts, and old logical schemas are superseded and must not be used as current authority.

## Target architecture

```text
React 19 + TypeScript + Vite SPA
        |
        | same-origin HTTPS REST/JSON
        v
Node.js 22+ + TypeScript + Express 5 modular monolith
        |
        | pg / node-postgres, parameterized SQL
        v
PostgreSQL
```

Employee data path:

```text
EGAS-approved annual XLSX
        -> controlled staging
        -> header/data validation
        -> routing resolution
        -> explicit activation
        -> immutable annual employee snapshot
```

Private storage is used for signature assets and final official PDFs.

The application has no required SAP CAP, CDS, CQN, UI5, Fiori, BTP, OData, GraphQL, ORM, direct SAP database, direct SAP runtime, or direct Active Directory dependency.


## Current approved annual workbook

The annual employee-data source format is the workbook layout represented by `بيانات IT.XLSX`. It contains two sheets:

```text
البيانات الاساسية   annual employee data
نيابة مساعد         routing/reference labels contained in the workbook
```

The employee sheet currently provides these source fields:

```text
م
رقم الموظف
اسم الموظف
مجموعة الموظفين
المجموعة الفرعية
النيابة / المساعد
الوظيفة
تاريخ اقدمية أخر ترقية
تاريخ بداية الخبرة
تقرير كفاية <YEAR>
تاريخ الالتحاق
experience years / months / days as of the workbook 1/1 reference
current-job-tenure years / months / days as of the workbook 1/7 reference
المؤسسة التعليمية-المؤهل الاصلي
الشهادة-المؤهل الاصلي
تاريخ المؤهل الاصلي
بداية شغل الوظيفة
```

Important importer requirements:

- parse Excel date/serial cells as dates rather than assuming display strings;
- treat the performance report year as data/metadata (for example `تقرير كفاية 2026`) rather than adding a year-specific physical column every year;
- tolerate approved year-token/slash/spacing variation in the duration headers through semantic header mapping, while failing closed on missing or ambiguous required fields;
- skip empty formatted rows even when the workbook's internal worksheet dimension is much larger than the real populated data;
- normalize/deduplicate the `نيابة مساعد` sheet for routing validation/reference only;
- never create application users, memberships, managers, or uncontrolled routing configuration directly from workbook rows;
- preserve workbook-provided duration triplets/reference dates as authoritative annual-snapshot/form values; consistency calculations may warn but must not silently overwrite them.

The import lifecycle remains:

```text
approved XLSX
    -> controlled staging
    -> semantic header/data validation
    -> routing resolution
    -> revalidation where required
    -> explicit transactional activation
    -> immutable annual employee snapshot
```

## v5 operational hierarchy

The pre-v5 flat-role/active-role model is removed.

```text
ADMIN
  -> administrative-only account

OPERATIONAL
  -> exactly one active UserUnitMembership
  -> belongs to one OperationalUnit
```

Operational units are:

```text
HR
ORG
AUTH (one per routing unit / نيابة)
```

Each operational unit has:

```text
OperationalUnit
      |
      +-- current manager
      |     authority derived from UnitManagerAssignment
      |
      +-- subordinate operational employees
```

Manager authority is not a stored role and is not inferred from job-title text.

ADMIN accounts do not receive workflow authority.

## v5 workflow model

### Promotion

```text
P1 HR     manager signs
  -> P2 ORG   manager signs
  -> P3 HR    review only
  -> P4 AUTH  manager/deputy signs
       |
       +-- all SAME_POSITION -> P5 HR
       |
       +-- any OTHER_POSITION -> P4O ORG -> P5 HR
```

`OTHER_POSITION` means another position **within the same department/routing unit**. P4O confirms that placement and does not overwrite the signed P4 decision. P4O has no second ORG signature.

### Secondment

```text
S1 HR     manager signs
  -> S2 ORG   manager signs
  -> S3 AUTH  manager/deputy signs
  -> S4 ORG   confirmation only
  -> S5 HR    final review
```

ORG proposes positions within the same department/routing unit; AUTH selects one valid proposal per candidate. S4 may not silently replace the signed AUTH selection.

## Manager/employee work model

Business stage and internal work state are separate.

```text
MANAGER_INBOX
    -> ASSIGNED
    -> IN_PROGRESS
    -> MANAGER_REVIEW
    -> COMPLETED

MANAGER_REVIEW
    -> CORRECTION_REQUIRED
    -> IN_PROGRESS
```

The manager may perform work directly or assign it to a subordinate.

Only the current manager and the current active assigned employee have edit authority for active work. Reassignment immediately ends the old employee's edit authority while preserving history.

Correction concepts are intentionally distinct:

- internal correction: manager -> current employee in the same stage execution;
- return for correction: current manager -> previous business-stage manager through a new execution of that previous stage;
- reject: current iteration ends and control returns to HR manager;
- HR manager after reject chooses restart as a new iteration or final cancellation.

## Signatures and final document

Official signing stages are:

```text
Promotion:  P1 HR, P2 ORG, P4 AUTH
Secondment: S1 HR, S2 ORG, S3 AUTH
```

Every actual signature requires fresh password reauthentication immediately before the immutable signoff is created. Passwords are never stored in signoff, audit, PDF, or logs.

During workflow, authorized users can render the current official-form state as PDF preview. Completed stages freeze structured submission evidence. When the request is fully complete, the system freezes one final form snapshot and materializes the immutable official PDF.

## Repository layout

Target layout:

```text
apps/
└── web/                         React/TypeScript frontend

services/
└── api/
    ├── src/
    │   ├── app.ts
    │   ├── server.ts
    │   ├── config/
    │   ├── db/
    │   │   ├── pool.ts
    │   │   ├── transaction.ts
    │   │   ├── migration-runner.ts
    │   │   ├── migrations/
    │   │   └── repositories/
    │   ├── middleware/
    │   ├── modules/
    │   │   ├── auth/
    │   │   ├── admin/
    │   │   ├── hierarchy/
    │   │   ├── employee-data/
    │   │   ├── import/
    │   │   ├── reference/
    │   │   ├── workflow/
    │   │   ├── promotion/
    │   │   ├── secondment/
    │   │   ├── signatures/
    │   │   ├── documents/
    │   │   ├── notifications/
    │   │   └── audit/
    │   └── shared/
    └── test/

docs/
├── requirements/
│   └── EGAS_Requirements_System_Architecture_Baseline_v5.2_Implementation_Ready.pdf
├── architecture/
│   └── EGAS_Implementation_Blueprint_v1.0.md
├── implementation/              completed-phase technical contracts
├── handoff/                     optional implementation work-package handoffs
└── uis_and_html/                visual references only
```

Some copied pre-v5 module names may remain temporarily until the phase that replaces them.

## Database baseline

v5 uses a **fresh PostgreSQL schema** rather than replaying the historical pre-v5 migration chain.

The canonical migration sequence begins with:

```text
services/api/src/db/migrations/001_initial_v5_schema.sql
```

Use lowercase `snake_case` physical table names.

The old pre-v5 migrations 001-007 and old CAP-derived physical baseline must not be run against a v5 database. Phase 1 replaces them as active migration authority.

Use a **separate v5 development database**. Never point the v5 clean migration at a database containing the old `egas_*` schema or old migration history. Do not automatically drop or destructively convert an old database.

## Reuse strategy

This project intentionally reuses proven technical code where semantics still fit.

Likely reuse candidates:

- Express application/module structure;
- PostgreSQL pool/transaction helpers;
- migration runner mechanics;
- Argon2id authentication helpers;
- secure opaque sessions;
- cookie, CSRF, and Origin protection;
- centralized validation/errors;
- annual XLSX parsing/staging patterns;
- audit/security event patterns;
- notification infrastructure;
- signature image processing;
- PDF rendering infrastructure;
- React/Vite visual components and shell.

The following pre-v5 concepts are specifically **not** to be preserved as active architecture:

```text
multi-role operational accounts
selected active role / role switching
flat EMPLOYEE_AFFAIRS / ORGANIZATION / APPROVING_AUTHORITY authorization
shared Organization claim queue as the primary work model
originating HR employee permanently owning the workflow
ApprovingAuthorityAssignment/AuthorityDelegation as manager authority
old migration 001-007 chain as v5 database authority
```

## Prerequisites

- Node.js 22+
- npm
- PostgreSQL for database-backed development and integration testing

Never commit `services/api/.env` or any other secret file.

`.env.example` may still require Phase 1 cleanup if it contains copied pre-v5 configuration wording. Use it only after checking the current phase documentation.

## Install and quality commands

From the repository root:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run security:check
npm audit
```

Available development commands inherited from the working codebase include:

```bash
npm run dev       # API watch mode
npm run dev:web   # Vite frontend
```

Database and data commands such as `npm run db:migrate`, `admin:bootstrap`, or annual-data commands must be used only when the current v5 phase documentation says the underlying schema/API is ready.

**Before Phase 1 completes, do not run the copied old migration chain against a new v5 database.**

## Development process

Implementation is incremental. Do not implement the whole redesign in one step.

Planned sequence:

```text
Phase 0  repository authority / redesign checkpoint
Phase 1  identity + authentication + operational hierarchy + clean DB baseline
Phase 2  Admin/hierarchy completion + annual employee data adaptation
Phase 3  workflow core + StageExecution + WorkAssignment manager/employee loop
Phase 4  Secondment vertical slice
Phase 5  Promotion + P4O vertical slice
Phase 6  signatures + final document/PDF + remaining evidence
Phase 7  frontend completion, hardening, UAT/pilot readiness
```

Exact work-package boundaries may be adjusted, but later phases must build on the frozen v5.2 architecture rather than revive old behavior.

## Security and data policy

Never commit or expose:

- credentials or secrets;
- real employee HR workbooks;
- real signatures;
- generated employee PDFs;
- database backups;
- plaintext/temporary passwords;
- raw session or CSRF tokens.

Automated tests use synthetic data.

All authorization is enforced server-side and deny-by-default. Workflow state/stage/actor/snapshot fields are changed only through explicit authorized domain commands, never generic client-writable CRUD.

## Historical source checkpoint

Before destructive redesign work, create a Git tag for the copied working source if one has not already been created, for example:

```bash
git tag pre-v5-redesign-source
git push origin pre-v5-redesign-source
```

That tag is the reference for recovering or comparing reusable pre-v5 implementation code.

## Implementation guidance for agents

Agents must read `AGENTS.md` before changing code.

When a copied implementation detail conflicts with v5.2, the copied behavior is intentionally replaceable.

When a requirement is genuinely unclear, stop and report the ambiguity instead of inventing a business rule.
