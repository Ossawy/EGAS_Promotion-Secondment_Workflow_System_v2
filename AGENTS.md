# EGAS v5 Implementation Guardrails

This repository is the active implementation repository for the **EGAS Promotion & Secondment Workflow System v5 redesign**.

The repository was created by copying the last working implementation so proven technical components can be reused. The copied source code is **reference/reuse material**, not the authority for current business behavior.

## 1. Source-of-truth order

When sources disagree, use this precedence:

1. `docs/requirements/EGAS_Requirements_System_Architecture_Baseline_v5.2_Implementation_Ready.pdf`
2. `docs/architecture/EGAS_Implementation_Blueprint_v1.0.md`
3. This `AGENTS.md`
4. Current v5 physical schema and migrations under `services/api/src/db/`
5. Current implementation documentation produced during completed v5 phases
6. Existing/copied source code as a technical reference only
7. `docs/uis_and_html/` as a **visual reference only**

Do not use deleted/older v3/v4 requirements, old phase handoffs, historical SQL schemas, or old workflow behavior to override v5.2.

If a required v5 authority document is missing, stop and report it instead of guessing.

## 2. Frozen architecture

Keep the system as a modular monolith:

```text
React 19 + TypeScript + Vite SPA
        -> same-origin HTTPS REST/JSON
Node.js 22+ + TypeScript + Express 5
        -> pg / node-postgres + parameterized SQL
PostgreSQL
```

Data ingress:

```text
Approved annual XLSX
  -> stage
  -> validate
  -> explicit activation
  -> immutable annual employee snapshot
```

Private storage is used for signature assets and frozen final PDFs.

Do not introduce SAP CAP/CDS/CQN, Prisma, NestJS, Sequelize, TypeORM, Drizzle, GraphQL, OData, microservices, direct SAP database access, direct SAP runtime integration, or direct Active Directory integration unless the requirements are formally changed.

## 3. New identity and hierarchy model

The old flat-role / active-role model is superseded.

### Account types

- `ADMIN`: administrative-only account.
- `OPERATIONAL`: workflow-capable account with exactly one active operational membership.

Do not implement operational multi-role accounts or active-role switching.

### Operational units

`OperationalUnit.kind` is exactly:

- `HR`
- `ORG`
- `AUTH`

Rules:

- one active HR operational unit;
- one active ORG operational unit;
- one AUTH operational unit per configured routing unit / نيابة;
- each operational unit has one effective manager;
- each unit may have subordinate operational employees.

### Membership and manager authority

- `UserUnitMembership` is the source of an operational user's unit membership.
- An operational account has at most one active membership.
- `UnitManagerAssignment` is the source of manager authority.
- Do not store or infer a `MANAGER` role.
- Do not infer manager/deputy authority from job-title text.
- Manager authority must be checked from current database state so replacement takes effect immediately.
- ADMIN status never grants workflow authority.

The historical `UserAccountRole`, selected `activeRole`, `ApprovingAuthorityAssignment`, and `AuthorityDelegation` models must not remain active authorization sources.

## 4. Workflow ownership and access

Business stage and internal manager/employee work state are separate concepts.

Business stages:

```text
Promotion:  P1 -> P2 -> P3 -> P4 -> [P4O if required] -> P5
Secondment: S1 -> S2 -> S3 -> S4 -> S5
```

Internal work states remain inside one `StageExecution`, for example:

```text
MANAGER_INBOX
  -> ASSIGNED
  -> IN_PROGRESS
  -> MANAGER_REVIEW
  -> COMPLETED

MANAGER_REVIEW -> CORRECTION_REQUIRED -> IN_PROGRESS
```

Do not invent extra business stages such as P2A/P2B for manager/employee loops.

At an active stage:

- the current unit manager may manage the stage, edit directly, assign/reassign, return to the assigned employee for correction, sign when required, and advance/return/reject where the business stage permits;
- only the current active employee `WorkAssignment` assignee may edit as an employee;
- reassignment ends the old assignment immediately and removes the old employee's edit authority;
- history remains append-only.

## 5. Correction, return, rejection, restart

Keep these actions distinct:

- **Internal correction:** manager -> current assigned employee; same `StageExecution`.
- **Return for correction:** current manager -> previous business-stage manager; create a fresh execution of that previous business stage in the same iteration.
- **Reject:** end the active iteration as rejected and route control to the HR manager.
- **After reject:** HR manager chooses exactly one of:
  - restart from the beginning by creating `WorkflowIteration N+1`; or
  - cancel the request.

Never delete or rewrite prior iterations, stage executions, assignments, snapshots, actions, notes, decisions, or signoffs.

## 6. Promotion rules

Promotion path:

```text
P1 HR   - manager signs
P2 ORG  - manager signs
P3 HR   - review only
P4 AUTH - manager/deputy signs

if every candidate is SAME_POSITION:
    P4 -> P5 HR

if any candidate is OTHER_POSITION:
    P4 -> P4O ORG -> P5 HR
```

Per candidate:

- `SAME_POSITION` means promotion on the current position.
- `OTHER_POSITION` requires a target job title.
- The target position remains within the same department/routing unit.
- P4O confirms the organizational placement but must not mutate the signed P4 AUTH decision.
- P4O has no second ORG signature.

Official Promotion signoffs are P1, P2, and P4.

## 7. Secondment rules

Secondment path:

```text
S1 HR   - manager signs
S2 ORG  - manager signs
S3 AUTH - manager/deputy signs
S4 ORG  - confirmation only
S5 HR   - final review
```

- ORG enters one or more proposed positions for each candidate.
- Proposed positions remain within the same department/routing unit.
- AUTH selects exactly one valid ORG-proposed position per candidate.
- S4 may confirm/return/reject according to the requirements but must not silently replace the signed AUTH selection.
- S4 has no second ORG signature.

Official Secondment signoffs are S1, S2, and S3.

## 8. Signatures and password reauthentication

Every actual official signature requires fresh password reauthentication immediately before creating the signoff.

Required signing stages:

```text
Promotion:  P1, P2, P4
Secondment: S1, S2, S3
```

Rules:

- verify the currently authenticated signer's own password;
- do not trim or transform the password before verification beyond the authentication provider's defined behavior;
- never store, log, audit, serialize, or place the password in PDF metadata;
- failed reauthentication creates no signoff;
- `workflow_signoff` is immutable and belongs to one `StageExecution`;
- if a signed business stage is later revisited through an inter-stage return, create a fresh `StageExecution` and, when required, a fresh signoff. Never overwrite the previous signoff.

## 9. PDF/document rules

- During workflow, authorized users may view the current state as a dynamically rendered official-form preview.
- Completed business stages freeze structured submission evidence in `stage_submission_snapshot`; this is not a separate immutable PDF per stage.
- When the request is fully complete, freeze one `final_form_snapshot` and materialize the immutable final official PDF.
- Promotion/Secondment official forms contain three signer blocks: HR, ORG, and AUTH/deputy.
- The AUTH/deputy block is the left-most block in the approved form layout.
- PDF/document rendering must use server-authorized structured data only; never execute user HTML or allow arbitrary network/`file://` reads.

## 10. Database authority

The v5 database is a clean baseline.

Use lowercase `snake_case` PostgreSQL names.

The canonical fresh-install migration begins with:

```text
services/api/src/db/migrations/001_initial_v5_schema.sql
```

Do not run or preserve the old 001-007 migration chain as active v5 migration authority.

Do not run the v5 migration against an old pre-v5 database. If an environment contains the old `egas_*` physical schema or old migration history, stop before destructive changes and report it.

Important database invariants must be enforced in PostgreSQL where practical, including:

- one active operational membership per operational account;
- one active manager per operational unit;
- one active AUTH unit per routing unit;
- current manager must be an active member of that same unit;
- one active `WorkAssignment` per `StageExecution`;
- one immutable `StageSubmissionSnapshot` per completed execution;
- at most one `WorkflowSignoff` per execution;
- restart creates a new iteration instead of resetting history.

## 11. Transaction and concurrency rules

Use a single acquired `pg` client for one atomic business operation.

For race-prone operations use PostgreSQL correctness mechanisms such as:

- row locks;
- conditional writes;
- partial unique indexes;
- optimistic version checks where appropriate.

Do not rely on an in-process JavaScript mutex for correctness.

Operations that must be transactionally safe include manager replacement, membership transfer, assignment/reassignment, stage submission, correction/return/reject, signing/advancing, and finalization.

## 12. Security rules

Preserve or improve the proven technical controls from the copied implementation where compatible:

- Argon2id password hashing;
- opaque server-side sessions;
- HttpOnly session cookie;
- CSRF protection and trusted-Origin checks;
- Secure cookie configuration for production;
- parameterized SQL;
- explicit allow-list DTOs;
- IDOR/BOLA protection;
- centralized safe errors;
- defensive HTTP headers;
- append-only audit/security evidence;
- private signature/PDF storage;
- canonical signature image processing.

Never commit or log:

- passwords or temporary passwords;
- database credentials;
- raw session or CSRF tokens;
- real HR workbooks;
- real employee/personnel data used only for testing;
- real signatures;
- generated employee PDFs;
- database backups.

Use synthetic data in automated tests.


## 13. Annual XLSX contract

The approved annual XLSX is the authoritative employee-population source for the applicable annual snapshot. The current approved workbook layout is represented by `بيانات IT.XLSX` and contains two sheets:

- `البيانات الاساسية` — annual employee data;
- `نيابة مساعد` — workbook routing/reference labels.

There is no direct SAP runtime/database integration.

Import path:

```text
XLSX
  -> stage
  -> semantic header + row validation
  -> routing resolution/revalidation
  -> explicit transactional activation
  -> immutable annual employee snapshot
```

The current employee sheet uses columns A:U with these source semantics:

| Col | Source header | v5 semantic |
|---|---|---|
| A | `م` | source row/order value |
| B | `رقم الموظف` | personnel number / stable employee key |
| C | `اسم الموظف` | employee name |
| D | `مجموعة الموظفين` | employee group |
| E | `المجموعة الفرعية` | employee subgroup |
| F | `النيابة / المساعد` | source routing label |
| G | `الوظيفة` | current job title |
| H | `تاريخ اقدمية أخر ترقية` | last-promotion seniority/date source value |
| I | `تاريخ بداية الخبرة` | experience start date |
| J | `تقرير كفاية <YEAR>` | annual performance/report value + report year |
| K | `تاريخ الالتحاق` | joining date |
| L-N | `عدد ... الخبرة حتى 1/1` year/month/day fields | approved experience duration triplet + workbook reference date |
| O-Q | `عدد ... حتى 1/7` year/month/day fields | approved current-job-tenure duration triplet + workbook reference date |
| R | `المؤسسة التعليمية-المؤهل الاصلي` | original-qualification institution/source |
| S | `الشهادة-المؤهل الاصلي` | original qualification/certificate |
| T | `تاريخ المؤهل الاصلي` | original qualification date |
| U | `بداية شغل الوظيفة` | current-job start date |

Importer rules:

- parse actual Excel date/serial cells safely; do not assume dates are preformatted strings;
- treat `تقرير كفاية <YEAR>` as a year-parameterized source field; store the report year as data/metadata instead of creating a new database column each year;
- duration headers may contain a year token/placeholder plus slash/backslash/spacing differences; validate the approved semantic fields instead of brittle typography or absolute-column-only matching;
- fail closed when a required semantic field is missing or ambiguous;
- skip structurally empty rows even if worksheet formatting inflates the XLSX used-range/dimension far below the real data;
- anchor employee rows to required business fields such as `رقم الموظف`;
- normalize and deduplicate non-empty values from `نيابة مساعد` for validation/reference purposes;
- do not silently create or rewrite application `RoutingUnit` identity, accounts, memberships, or manager assignments from workbook rows;
- accounts and operational hierarchy remain Admin-managed;
- store both approved source start dates and workbook-provided duration triplets/reference dates;
- workbook-provided year/month/day durations are authoritative snapshot/form values; consistency calculations may warn but must not silently overwrite them;
- do not hard-code one annual reference year into the physical schema.

## 14. UI reference policy

`docs/uis_and_html/` contains legacy/approved visual references.

Use it for:

- Arabic RTL visual language;
- general EGAS green/white appearance;
- layout inspiration;
- component density and styling.

Do **not** infer from those files:

- current roles;
- permissions;
- workflow transitions;
- assignment ownership;
- manager authority;
- signature rules;
- database design.

The v5.2 baseline and blueprint control behavior.

## 15. Reuse policy for copied source code

Prefer adapting proven code when semantics still fit. Good reuse candidates include:

- Express app/module structure;
- PostgreSQL pool and transaction helpers;
- migration runner mechanics;
- validation helpers;
- request context and error handling;
- Argon2id authentication helpers;
- secure session/cookie/CSRF infrastructure;
- annual XLSX parsing/staging patterns;
- audit/security event patterns;
- notifications;
- signature image processing;
- PDF renderer infrastructure;
- React/Vite shell/components where behavior does not conflict.

Do not preserve obsolete behavior merely because tests currently assert it. Rewrite or remove tests whose expected behavior belongs to superseded requirements, and document why.

## 16. Implementation discipline

For every phase:

1. Read the specific v5.2 sections and blueprint sections required by the work package.
2. Inspect relevant copied code before deciding what to reuse.
3. Implement only the requested phase; do not pre-build later phases.
4. Keep explicit service/domain actions instead of generic client-writable workflow CRUD.
5. Add/adjust tests for the new requirement, including authorization and concurrency cases.
6. Run build, typecheck, tests, security checks, and dependency audit when available.
7. Update implementation documentation for the completed phase.
8. Report failures and ambiguities; do not fake success or invent requirements.

## 17. Stop conditions

Stop and report before continuing if:

- the v5.2 baseline or blueprint is missing;
- repository instructions conflict with v5.2 and cannot be safely reconciled;
- a requested action would require guessing a business rule;
- a database appears to be a pre-v5 database and the task would destructively migrate it;
- required credentials or infrastructure are unavailable for a validation step;
- a security or data-integrity issue would make the requested implementation unsafe.
