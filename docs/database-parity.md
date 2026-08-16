# PostgreSQL logical baseline to CAP CDS parity

## Authority and naming

`EGAS_PostgreSQL_Logical_Schema_v1.0_Final.sql` is the frozen pre-implementation logical baseline. The files under `services/cap-api/db/*.cds` and `services/cap-api/db/migrations` are now the runtime implementation source of truth.

CDS preserves every business concept under namespace `egas` and uses camelCase elements; CAP compiles those artifacts to physical names such as `public.egas_workflowrequest`. The frozen SQL's `egas.workflow_request` name remains a traceability name, not a second schema to maintain.

## Entity/invariant matrix

| Logical SQL concept | CDS implementation | Service-layer invariant/location | PostgreSQL-only implementation |
|---|---|---|---|
| `routing_unit` | `egas.RoutingUnit` in `reference.cds` | Only approved active values may route a request; request logic is later phase. | Unique name/code from CDS; lookup index/coverage checked by `pilot:check`. |
| `routing_unit_source_alias` | `egas.RoutingUnitSourceAlias` in `hr.cds` | Import must use exact explicit aliases and block unknown labels; full pipeline is Phase 2. | Active-unit lookup index. |
| `job_category_reference` | `egas.JobCategoryReference` | Read-only reference service; five fixed seed rows. | CDS uniqueness. |
| `qualification_status_reference` | `egas.QualificationStatusReference` | Read-only reference service; two fixed seed rows. | CDS uniqueness. |
| `user_account` | `egas.UserAccount` in `auth.cds` | Explicit Admin actions create/update/disable/enable/unlock/reset accounts; no generic account endpoint. Passwords are Argon2id hashes and mutable account actions use version checks. | Failure-count check; unique username/staff identifier. |
| `user_account_role` | `egas.UserAccountRole` | Session middleware authorizes exactly `AuthSession.activeRole`; Admin actions assign/revoke roles and roles are never unioned. | Role/admin-only/self-grant/self-revoke checks and active lookup index. |
| `auth_session` | `egas.AuthSession` | Login stores only token/CSRF hashes; active account, selected active role, idle/absolute expiry, rotation, and revocation are enforced. | Active-role/expiry checks and active-session index. |
| `auth_login_attempt` | `egas.AuthLoginAttempt` | Login/password verification records durable identifier/IP evidence and applies database-backed failure windows and lockouts. | Identifier/IP time indexes. Uses CAP UUID rather than baseline `bigserial`; identity semantics are unchanged. |
| `security_event` | `egas.SecurityEvent` in `audit-documents.cds` | Auth, account/role, authority, and delegation security actions emit server-timestamped events without raw credentials/tokens. | JSON object check and type/actor indexes. |
| `import_batch` | `egas.ImportBatch` in `hr.cds` | Import command currently validates only and performs no database writes. | Status/count/header JSON checks and year index. |
| `employee_import_staging_row` | `egas.EmployeeImportStagingRow` | Full raw staging/normalization/mapping/activation is Phase 2. | Batch-row unique constraint, JSON/status checks, batch/status index. Uses CAP UUID instead of `bigserial`. |
| `employee` | `egas.Employee` | Local employee provider reads stable identity through activated snapshots. | Unique Personnel Number. |
| `employee_annual_snapshot` | `egas.EmployeeAnnualSnapshot` | Provider returns only an activated year and requires an explicit routing-unit mapping. It never infers employee administration/dependency. | Year/personnel uniqueness, performance check, employee/routing/personnel indexes. |
| `approving_authority_assignment` | `egas.ApprovingAuthorityAssignment` in `authority.cds` | Explicit Admin actions validate account/role/routing eligibility, one primary, versioning, and audit. Workflow routing use is later; job-title text never grants access. | Partial unique active-primary-per-unit index, date/kind/no-self-config checks. |
| `authority_delegation` | `egas.AuthorityDelegation` | Explicit Admin actions validate eligible delegates, dates, no self-delegation, versioning, and audit; delegation remains assignment-scoped. | Date check and trigger rejecting delegation to the primary authority itself. |
| `user_signature_asset` | `egas.UserSignatureAsset` | Upload decode/re-encode/storage endpoint is deferred until signature hardening is implemented cohesively. | MIME/size/dimension/hash checks and active-user index. |
| `workflow_request` | `egas.WorkflowRequest` in `workflow.cds` | Deliberately absent from generic CRUD services. Future state changes are named CAP actions only. | Type/status/month/year/iteration checks and queue/search indexes. |
| `request_form_section` | `egas.RequestFormSection` | Future action validates category/group ownership. | Unique request/category and request-order index. |
| `request_candidate` | `egas.RequestCandidate` | Future request action copies frozen fields from the provider; client cannot supply authoritative snapshots. | Unique request/snapshot and request/section/personnel indexes. |
| `workflow_iteration` | `egas.WorkflowIteration` | Future state machine creates a new row on restart/recall and never rewrites old decisions. | Status/number checks and request history index. |
| `stage_task` | `egas.StageTask` | Atomic Organization claim and stage transitions are explicit Phase 3/4 actions. | Status/role checks plus queue/request indexes. |
| `stage_received_snapshot` | `egas.StageReceivedSnapshot` | Future receipt/claim action creates exact immutable JSON/hash snapshot. | Unique task/hash, received indexes, JSON/hash checks, update/delete rejection trigger. |
| `secondment_position_option` | `egas.SecondmentPositionOption` | Future Organization/Authority actions enforce ownership and exactly one selection. | Partial unique selected option per candidate/iteration plus candidate index. |
| `promotion_decision` | `egas.PromotionDecision` | Future P4 action validates role/stage and freezes submission. | Unique candidate/iteration and Same/Other target-title check. |
| `stage_action` | `egas.StageAction` | Future transition actions append actor role and payload under server time. | Role/JSON checks, request index, update/delete rejection trigger. |
| `workflow_note` | `egas.WorkflowNote` | Future append action validates active role, scope, candidate/request ownership and emits audit. | Scope/message/role checks, chronological indexes, update/delete rejection trigger. |
| `workflow_signoff` | `egas.WorkflowSignoff` | Future P1/S1 and P2/S2 submit actions require authenticated name, per-signoff title and immutable signature hash. | Unique request/iteration/stage, hash/role checks, indexes, update/delete rejection trigger. |
| `notification` | `egas.Notification` | Future transition transaction calculates recipients; notification never replaces audit. | Recipient unread/time index. |
| `audit_event` | `egas.AuditEvent` | Future audited commands build the canonical hash chain; no generic service exposure. | JSON/hash checks, reporting indexes, update/delete rejection trigger; runtime grants revoke update/delete. |
| `pdf_generation_log` | `egas.PdfGenerationLog` | Document boundary exists; isolated renderer and generation actions are deferred. | Type/state/period/hash checks and request index. |

`egas.SchemaMigration` is repository migration metadata and has no logical-business counterpart.

## Type/location differences

- Baseline JSONB columns use CDS `Map`; CAP 10 compiles them to PostgreSQL `JSONB` and SQLite `JSON_TEXT` for tests.
- Baseline `inet` fields are CDS `String(45)` so CAP remains portable; service input must validate IPv4/IPv6 before persistence. They are evidence fields, never authorization inputs.
- Baseline `timestamptz` fields are CDS `Timestamp`, which CAP compiles to PostgreSQL `TIMESTAMP`. All business values still originate from synchronized server time and are treated as UTC. A later production-readiness decision may adopt an explicit time-zone migration only if it remains compatible with CAP schema evolution.
- The two baseline `bigserial` technical keys use CAP UUIDs. No business ordering or external contract depends on those surrogate IDs.
- Foreign keys, required fields, and standard unique constraints are generated by CDS. Partial indexes, cross-field checks, append-only enforcement and anti-self-delegation live in `001_postgres_integrity.sql`.
- RLS is intentionally not enabled in Phase 1. The baseline explicitly says not to enable brittle policies before transaction-scoped identity context and authorization tests exist. Backend authorization remains mandatory.

## Existing handwritten-schema cutover

`db:migrate` refuses to deploy if it detects `egas.routing_unit` from the handwritten baseline without the CAP schema, or if both schemas exist. No destructive action is automated. A confirmed-empty development database may be recreated only after backup/verification and explicit operator approval; otherwise create a reviewed one-time data migration.

## Migration execution and PostgreSQL driver warning

Versioned PostgreSQL migrations are executed inside a managed CAP transaction through `@cap-js/postgres`'s `exec(sql)` path. That path delegates one bare, parameter-free string to `pg`'s simple-query protocol, so complete PostgreSQL scripts are supported without unsafe semicolon splitting. The checksum row is inserted in the same transaction only after the script succeeds. A transaction-scoped advisory lock serializes migration runners. CAP deployment remains responsible for CDS schema evolution and reference CSV seeding.

With the currently locked `@sap/cds` 10.0.5, `@cap-js/postgres` 3.0.1, `@cap-js/db-service` 3.0.1 and `pg` 8.23.0, `pg` may emit `Calling client.query() when the client is already executing a query is deprecated`. The custom migration runner executes its operations sequentially. Inspection of the installed dependency sources shows concurrent same-client calls in CAP's PostgreSQL session setup (`Promise.all`) and database-service multi-entry insert path (`Promise.all`), which deployment/seeding can exercise. This is therefore documented as an upstream dependency warning; the repository does not patch `node_modules`, suppress the warning, pin an older driver, or add unsafe concurrency workarounds.
