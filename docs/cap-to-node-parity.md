# SAP CAP to plain Node.js/Express parity ledger

This ledger was created before CAP removal at checkpoint `8be6b3f` and is retained as the replacement/deletion record. Existing PostgreSQL names, rows, constraints, triggers, migration checksums, and implemented Phase 1/2A/2B/3A behavior remain authoritative.

## Architecture replacement

| CAP concern | Existing implementation | Plain Node replacement |
|---|---|---|
| Runtime and lifecycle | `@sap/cds`, `cds.ApplicationService`, service `init()` and CAP request dispatch | Express 5 application/router composition and ordinary async handlers |
| Persistence model | CDS files under `services/cap-api/db` | Existing physical PostgreSQL schema; documented SQL baseline plus future versioned SQL migrations |
| Database adapter | `@cap-js/postgres` | One `pg.Pool` using the restricted `egas_app` runtime login |
| Queries | Global CQN `SELECT`, `INSERT`, `UPDATE`, `DELETE` | Repository SQL with `$1`, `$2`, ... parameters and explicit safe projections |
| Transactions | `db.tx(...)` | One acquired `PoolClient`, explicit `BEGIN`/`COMMIT`/`ROLLBACK`, always released |
| Authentication | CAP custom auth implementation and `cds.User` | Express cookie authentication middleware attaching `AuthContext` |
| Authorization | CDS `@requires`, CAP roles, handler checks | `requireAuthenticated`, `requireActiveRole`, `requireAdmin`, and `requireManageAdmins` middleware |
| Request context | CAP request, `request.user.attr`, `request.http` | Typed Express request augmentation plus correlation/IP/user-agent middleware |
| Configuration | `cds.env`, CAP profiles, `.cdsrc-private.json` | Validated `EGAS_*` process environment variables |
| Schema deployment | `cds.deploy(model).to(db)` and CSV deployment | Existing schema accepted as baseline; plain SQL migration runner owns future evolution |
| Migration execution | CAP transaction plus adapter `exec(sql)` | Same `pg` client and parameter-free simple-query call for complete PostgreSQL scripts |
| CAP outbox | `@sap/cds/srv/outbox` creates/uses `cds_outbox_messages` | No active access; table is preserved but not dropped |
| Testing | CAP/SQLite test profile and global CQN | Vitest with explicit in-memory/fake PostgreSQL-compatible test database; live development DB is refused |

## Direct CAP dependency inventory

- Packages: `@sap/cds`, `@sap/cds-dk`, `@cap-js/postgres`, `@cap-js/db-service`, `@cap-js/sqlite`, `@cap-js/cds-test`, `@cap-js/cds-typer`, `@cap-js/cds-types`, and transitive Fiori/MTX/build packages.
- Model/runtime assets: every `.cds` file under `services/cap-api/db` and `services/cap-api/srv`, generated `@cds-models`, `gen`, `tsconfig.cdsbuild.json`, CAP profile configuration in `package.json`, and the ignored `.cdsrc-private.json`.
- Lifecycle APIs: `cds.ApplicationService`, `cds.connect.to`, `cds.load`, `cds.deploy`, `cds.shutdown`, `cds.context`, `cds.User`, `cds.test`, and `cds.env`.
- Transaction/query APIs: `db.tx`, `db.run`, global CQN `SELECT`/`INSERT`/`UPDATE`/`DELETE`, and adapter-specific `exec`.
- Service boundary: Auth, Admin, Health, Reference, Employee Data foundation, Workflow foundation, Audit foundation, and Document foundation CDS services.
- Authentication objects: CAP middleware factory, `cds.User.anonymous`, CAP role arrays, `@requires`, and request attributes carrying session/role state.
- Technical persistence: `cds_model` and `cds_outbox_messages` were deployed/granted by CAP but are not used by Phase 2A business code. Both are preserved and denied to the final runtime by the grant script.

## Persistence mapping

PostgreSQL folds the unquoted CAP-generated names below to lowercase in catalog storage. Names are intentionally unchanged.

| CDS entity / concern | Physical PostgreSQL table | Migration status / active use |
|---|---|---|
| `SchemaMigration` | `egas_schemamigration` | Active migration version/checksum ledger |
| `RoutingUnit` | `egas_routingunit` | Active reference and pilot/authority validation |
| `JobCategoryReference` | `egas_jobcategoryreference` | Active read-only reference |
| `QualificationStatusReference` | `egas_qualificationstatusreference` | Active read-only reference |
| `UserAccount` | `egas_useraccount` | Active Phase 2A |
| `UserAccountRole` | `egas_useraccountrole` | Active Phase 2A |
| `AuthSession` | `egas_authsession` | Active Phase 2A |
| `AuthLoginAttempt` | `egas_authloginattempt` | Active Phase 2A |
| `ImportBatch` | `egas_importbatch` | Active Phase 2B staging/validation/activation |
| `EmployeeImportStagingRow` | `egas_employeeimportstagingrow` | Active Phase 2B staging/validation |
| `Employee` | `egas_employee` | Active Phase 2B stable identity |
| `EmployeeAnnualSnapshot` | `egas_employeeannualsnapshot` | Active Phase 2B/3A immutable annual source |
| `RoutingUnitSourceAlias` | `egas_routingunitsourcealias` | Active Phase 2B Admin-managed exact mapping |
| `ApprovingAuthorityAssignment` | `egas_approvingauthorityassignment` | Active Phase 2A |
| `AuthorityDelegation` | `egas_authoritydelegation` | Active Phase 2A |
| `UserSignatureAsset` | `egas_usersignatureasset` | Preserved; signatures deferred |
| `WorkflowRequest` | `egas_workflowrequest` | Active Phase 3A draft root |
| `RequestFormSection` | `egas_requestformsection` | Preserved; workflow deferred |
| `RequestCandidate` | `egas_requestcandidate` | Active Phase 3A draft candidate/snapshot reference |
| `SecondmentPositionOption` | `egas_secondmentpositionoption` | Preserved; workflow deferred |
| `WorkflowIteration` | `egas_workflowiteration` | Active Phase 3A iteration 1 foundation |
| `StageTask` | `egas_stagetask` | Active Phase 3A P1/S1 and Organization-claim foundation |
| `StageReceivedSnapshot` | `egas_stagereceivedsnapshot` | Preserved append-only table |
| `PromotionDecision` | `egas_promotiondecision` | Preserved; workflow deferred |
| `WorkflowNote` | `egas_workflownote` | Active Phase 3A append-only notes |
| `StageAction` | `egas_stageaction` | Active Phase 3A append-only business timeline evidence |
| `WorkflowSignoff` | `egas_workflowsignoff` | Preserved append-only table |
| `SecurityEvent` | `egas_securityevent` | Active Phase 2A |
| `Notification` | `egas_notification` | Active Phase 3A recipient-owned in-app foundation |
| `AuditEvent` | `egas_auditevent` | Active Phase 3A append-only workflow audit chain |
| `PdfGenerationLog` | `egas_pdfgenerationlog` | Preserved; PDF generation deferred |
| CAP outbox | `cds_outbox_messages` | Preserved but no longer accessed |
| CAP compiled-model metadata | `cds_model` | Preserved in upgraded databases but no longer accessed |

Migration `001_postgres_integrity.sql` remains immutable. Its partial unique indexes, checks, append-only triggers, self-delegation trigger, and lookup indexes remain database-enforced.

## Service/action to REST mapping

| CAP operation | Express REST endpoint | Authorization | Database/session/audit parity target |
|---|---|---|---|
| `AuthService.login` | `POST /api/auth/login` | Anonymous + trusted Origin | Generic errors; durable attempts; advisory lock; Argon2id; hashed opaque session/CSRF; login event |
| `AuthService.me` | `GET /api/auth/me` | Authenticated | Safe current-user context only |
| `AuthService.changePassword` | `POST /api/auth/change-password` | Authenticated + CSRF | Verify current; validate/hash new; clear mandatory flag; revoke/rotate; event in transaction |
| `AuthService.selectActiveRole` | `POST /api/auth/select-active-role` | Authenticated + CSRF | Validate one active assignment; revoke/rotate; event |
| `AuthService.logout` | `POST /api/auth/logout` | Idempotent, CSRF when authenticated | Revoke current session; clear cookies; event |
| `AdminService.listUsers` | `GET /api/admin/users` | Active ADMIN | Bounded safe projection and roles |
| `AdminService.getUser` | `GET /api/admin/users/:id` | Active ADMIN | ID-specific safe projection |
| `createUser` | `POST /api/admin/users` | Active ADMIN; Manage Admins when creating Admin | Account + roles + event transaction; forced password change |
| `updateUser` | `PATCH /api/admin/users/:id` | Active ADMIN; Manage Admins for Admin target | Version-checked update + event |
| `assignRole` | `POST /api/admin/users/:id/roles` | Active ADMIN; Manage Admins for ADMIN role | Explicit assignment; sessions revoked; event |
| `revokeRole` | `DELETE /api/admin/users/:id/roles/:role` | Active ADMIN; Manage Admins for ADMIN role | Self/last-privileged protection; sessions revoked; event |
| `disableUser` / `enableUser` | `POST /api/admin/users/:id/disable|enable` | Active ADMIN; Manage Admins for Admin target | Version check; no hard delete; session revocation; event |
| `unlockUser` | `POST /api/admin/users/:id/unlock` | Active ADMIN; Manage Admins for Admin target | Clears failure/lock only; version check; event |
| `resetPassword` | `POST /api/admin/users/:id/reset-password` | Active ADMIN; Manage Admins for Admin target | Argon2id temporary password; mandatory change; revoke sessions; event |
| `listAuthorityAssignments` | `GET /api/admin/authority-assignments` | Active ADMIN | Bounded filtered list |
| assignment create/update/deactivate | matching `/api/admin/authority-assignments` routes | Active ADMIN + CSRF | Eligibility/primary/self/version checks; session revocation; transactional event |
| `listDelegations` | `GET /api/admin/delegations` | Active ADMIN | Bounded filtered list |
| delegation create/update/deactivate | matching `/api/admin/delegations` routes | Active ADMIN + CSRF | Eligibility/date/self/version checks; no invented overlap rule; transactional event |
| Health liveness/readiness | `GET /health`, `GET /ready` | Anonymous | Process health / parameterized DB probe |
| Reference projections | `GET /api/reference/*` | Authenticated | Explicit safe read-only SQL |
| Foundation status functions | Removed as CAP-specific scaffolding | N/A | No business state or behavior to preserve |

Phase 3A adds explicit REST routes under `/api/workflow` for owned draft creation/list/detail, active-snapshot candidate add/removal, routing-scoped authority options/selection, notes, timeline, Organization queue, and atomic task claim. `/api/notifications` provides own-recipient list/read behavior. There is deliberately no generic CRUD, submit, signoff, downstream transition, or full Promotion/Secondment decision route; see [phase3a-workflow-api.md](phase3a-workflow-api.md).

## Verified Phase 2A operation parity

| Operation | Previous behavior | Express response / authorization | Database, session, audit, transaction parity | Automated/live evidence |
|---|---|---|---|---|
| Login | Local Argon2, generic errors, durable failure policy | `POST /api/auth/login`; anonymous, trusted Origin; safe context/cookies | Bound lookup; advisory lock; attempts/account/session/login event atomically; hashes only | success/failure/unknown/disabled/locked/rate/concurrency/hash/cookie tests; live synthetic login |
| Current user | Safe session context | `GET /api/auth/me`; authenticated; `401` otherwise | Valid session/account/active-role assignment only; no mutation | HTTP anonymous/auth tests; live anonymous `401` |
| Change password | Verify current, Argon2id, mandatory clear | `POST /api/auth/change-password`; authenticated + CSRF | Account update, all-session revoke, rotated session and event in one transaction | password/rotation and invalid-session tests |
| Select active role | One assigned active role only | `POST /api/auth/select-active-role`; authenticated + CSRF | Old session revoked, replacement stores exactly one role, event transaction | multi-role unit/HTTP tests; live ORGANIZATION-vs-Admin `403` |
| Logout | Idempotent clear/revoke | `POST /api/auth/logout`; CSRF when authenticated; `204` | Current session revoke and logout event transaction | CSRF/revocation HTTP tests |
| List/get users | Safe bounded Admin projections | `GET /api/admin/users[/:id]`; active ADMIN | Explicit columns, roles, no password hash; reads only | service/HTTP tests; live Admin read `200` |
| Create user | Explicit account + distinct roles | `POST /api/admin/users`; ADMIN, plus Manage-Admins for ADMIN role; `201` | Argon2id, mandatory change, account/roles/event in one transaction | duplicate/safe projection/audit tests |
| Update user | Optimistic profile update | `PATCH /api/admin/users/:id`; target-sensitive privilege | Version predicate and event in one transaction | stale-version test |
| Assign role | Explicit assign/reactivate | `POST /api/admin/users/:id/roles`; self/Manage-Admins rules | Assignment, target-session revoke, event in one transaction | Manage-Admins and role/session tests |
| Revoke role | Soft revoke | `DELETE /api/admin/users/:id/roles/:role`; self/last-admin rules | Advisory invariant lock, assignment update, session revoke, event transaction | self/last-admin tests |
| Disable/enable | Soft account state | `POST .../:id/disable|enable`; version/target privilege | No hard delete; last-admin lock; disable revokes sessions; event transaction | last-admin/disabled-login tests |
| Unlock | Clear lock evidence | `POST .../:id/unlock`; version/target privilege | Failure/lock reset and event transaction | Admin service coverage |
| Reset password | Admin temporary reset | `POST .../:id/reset-password`; no self reset | Argon2id, mandatory flag, all sessions revoked, event transaction | Admin service/security tests |
| List assignments | Bounded filtered list | `GET /api/admin/authority-assignments`; active ADMIN | Explicit safe query; no mutation | authority service tests |
| Create assignment | Eligibility/one primary/self checks | `POST /api/admin/authority-assignments`; ADMIN + CSRF; `201` | Assignment, session revoke and event transaction; DB partial index preserved | eligibility/duplicate-primary tests |
| Update assignment | Versioned rules | `PATCH /api/admin/authority-assignments/:id`; ADMIN + CSRF | Version predicate, session revoke and event transaction | authority version/rule coverage |
| Deactivate assignment | Soft deactivate | `POST .../:id/deactivate`; ADMIN + CSRF | Assignment/delegations disabled, sessions revoked, event transaction | deactivation tests |
| List delegations | Bounded filtered list | `GET /api/admin/delegations`; active ADMIN | Explicit safe query; no mutation | delegation service tests |
| Create delegation | Eligible parties, dates, no self; no invented overlap rule | `POST /api/admin/delegations`; ADMIN + CSRF; `201` | Delegation, affected-session revoke and event transaction; trigger preserved | self/date/success tests |
| Update delegation | Versioned date/reason update | `PATCH /api/admin/delegations/:id`; ADMIN + CSRF | Version predicate, sessions and event transaction | delegation rule coverage |
| Deactivate delegation | Soft deactivate | `POST .../:id/deactivate`; ADMIN + CSRF | Versioned state, sessions and event transaction | explicit deactivation test |
| References | Authenticated read-only projections | `GET /api/reference/*`; authenticated | Explicit columns/order; unchanged 22/5/2 rows | baseline/reference/HTTP/live 22-unit checks |
| Health/readiness | Liveness and DB readiness | `GET /health`, `GET /ready`; anonymous | Readiness performs a harmless database probe | isolated HTTP and live `200/200` |
| Bootstrap | First privileged Admin only | CLI; no public registration | Advisory transaction lock; account/role atomic; Argon2id; pool closed in `finally` | atomic/refusal lifecycle regression test |
| Pilot check | Runtime/22/Admin/coverage/snapshot truth | CLI/non-zero on any false | Parameterized read-only queries; pool closed | privileged-role variant test and live expected state |

## Query/repository strategy

All active CQN is replaced by bounded repository methods with explicit column lists and PostgreSQL parameters. Identifiers such as table names and ordering are code constants only. Search text, UUIDs, roles, dates, pagination, passwords, and request values are never concatenated into SQL.

Each security-sensitive operation receives a `Queryable` representing either the pool or the one transaction client. Audit insertion receives the same client. No transaction may return to the pool between mutation and audit/session effects.

## Parity/deletion gate

CAP may be removed only when every row above has Express implementation and automated coverage, root commands no longer call CAP, the dependency inventory is absent from active backend code/package locks, and read-only verification against `egas_workflow_dev` succeeds with `egas_app`. Historical documentation/PDF mentions remain for traceability and are not runtime dependencies.

Final status: **parity accepted and CAP retired**. Isolated tests passed before deletion. Live verification used `egas_app` against `egas_workflow_dev`: server start, PostgreSQL readiness, anonymous `401`s, intact `devadmin`, 22 active routing units, Admin read `200`, and exact active-role isolation `403` all passed. Uniquely named synthetic live-verification accounts and every related session/attempt/role/event were deleted and zero leftovers were confirmed. No migration or destructive schema operation was executed during live verification.
