# Phase 1 - Identity and operational hierarchy

This phase follows the v5.2 baseline and Blueprint. Promotion/Secondment runtime behavior remains deferred.

## Account and session model

`user_account.account_type` is `ADMIN` or `OPERATIONAL`. Admin accounts are administrative-only and never gain workflow authority. An operational account has at most one current `user_unit_membership`; manager authority is derived from the current membership plus an active same-unit `unit_manager_assignment`.

Sessions are opaque random tokens. Only SHA-256 token and CSRF hashes are stored in `auth_session`. Cookies are HttpOnly for the session token, SameSite Strict, and Secure when configured. Sessions have idle and absolute expiry and are revoked on logout, password change/reset, and account disable. No active role is stored.

`GET /api/auth/me` returns:

```json
{
  "userId": "uuid",
  "username": "admin",
  "staffIdentifier": null,
  "displayName": "Name",
  "jobTitle": null,
  "accountType": "ADMIN",
  "mustChangePassword": false,
  "operationalContext": null
}
```

For an operational user, `operationalContext` contains `membershipId`, `unitId`, `unitKind`, `routingUnitId`, `routingUnitName`, `isManager`, and `managerAssignmentId`.

Removed endpoint: `POST /api/auth/select-active-role` is not mounted and returns the normal 404 response.

## Physical schema

The clean baseline is `services/api/src/db/migrations/001_initial_v5_schema.sql`. It establishes the identity/hierarchy tables plus the canonical future-domain tables: `user_account`, `auth_session`, `auth_login_attempt`, `routing_unit`, `operational_unit`, `user_unit_membership`, `unit_manager_assignment`, `user_signature_asset`, import/employee tables, workflow core/specific tables, signoff/document tables, `notification`, `audit_event`, and `security_event`.

Important database protections:

- unique username;
- account type check;
- one active membership per user (partial unique index);
- one active manager assignment per unit (partial unique index);
- one active HR unit and one active ORG unit;
- one active AUTH unit per routing unit;
- AUTH requires a routing unit, while HR/ORG forbid one;
- one active work assignment per stage execution.

The current-manager same-unit rule is validated transactionally by the Admin service and rechecked from current database state by hierarchy queries. Historical membership and manager rows are ended, never rewritten.

## Admin and hierarchy APIs

Admin account lifecycle:

- `GET /api/admin/accounts`
- `GET /api/admin/accounts/:id`
- `POST /api/admin/accounts`
- `PATCH /api/admin/accounts/:id`
- `POST /api/admin/accounts/:id/enable`
- `POST /api/admin/accounts/:id/disable`
- `POST /api/admin/accounts/:id/unlock`
- `POST /api/admin/accounts/:id/reset-temporary-password`

Hierarchy commands/queries:

- `GET|POST /api/admin/operational-units`
- `GET /api/admin/operational-units/:unitId`
- `GET /api/admin/operational-units/:unitId/members`
- `POST /api/admin/operational-units/:unitId/memberships`
- `POST /api/admin/operational-units/:unitId/manager-assignments`
- `GET /api/admin/operational-units/:unitId/manager-history`
- `GET /api/admin/operational-units/:unitId/subordinates`

Membership transfer and manager replacement each use one acquired PostgreSQL client and transaction. Manager replacement locks the unit and current assignment, ends the old row, inserts the new row, and appends audit/security evidence. The partial unique index is the final concurrency guard; conflicts return a safe retry error. Membership changes similarly end the current row and insert a new row, so authorization changes on the next database read without stale session role state.

Reusable hierarchy service operations are in `modules/hierarchy/hierarchy-service.ts`: current membership, unit, current manager, manager check, membership check, subordinate list, and manager history.

## Removed/disabled v4 behavior

The old active-role route, role union model, `ApprovingAuthorityAssignment`, `AuthorityDelegation`, and workflow/notification/reference/import route mounts are not active Phase 1 authorization surfaces. Legacy modules remain in the repository only as historical technical reference and are not mounted by `app.ts`; they must be redesigned in later phases before reactivation.

## Migration and local setup

Use a separate empty PostgreSQL database for v5. `npm run db:migrate` creates `schema_migration` and applies `001_initial_v5_schema.sql`. The runner refuses a database containing the obsolete application schema. Do not drop or migrate the previous development database automatically.

Run `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, and `npm run security:check` from the repository root. Database integration requires local PostgreSQL credentials and is not faked when unavailable.

## Known limitations and deferrals

Phase 1 does not implement annual import behavior, workflow requests, StageExecution runtime commands, WorkAssignment authorization, Promotion, Secondment, signatures/password reauthentication for signing, PDFs, notifications, email, Active Directory, SAP, or frontend manager/employee workspaces. A database-level trigger for the cross-table manager-membership invariant remains a future hardening option; service transaction validation plus row locks and partial unique indexes are the current implementation.

## Required-behavior coverage matrix

The active Phase 1 suite intentionally replaces obsolete v3/v4 workflow tests. Closely related requirements are grouped in meaningful integration tests:

| Required behavior group | Verification |
|---|---|
| Admin/operational login, wrong password, disabled account, `/api/auth/me` hierarchy context | `phase1-behavior.test.ts` - authentication and account model / first test |
| Lockout, password change, session revocation, token/CSRF hashes, no role state | `phase1-behavior.test.ts` - authentication and account model / second test |
| Removed active-role endpoint and ADMIN has no operational authority | `phase1-behavior.test.ts` - authentication and account model / third test |
| OPERATIONAL membership target and ADMIN membership denial | `phase1-behavior.test.ts` - membership invariants / transfer test |
| One active membership and concurrent duplicate protection | `phase1-behavior.test.ts` - membership invariants / concurrent test |
| HR/ORG singleton, AUTH routing requirement/uniqueness, invalid HR/ORG routing | `phase1-behavior.test.ts` - operational units / invariant test |
| Active OPERATIONAL manager, same-unit membership, inactive manager rejection | `phase1-behavior.test.ts` - manager authority / replacement test |
| Manager replacement history, immediate old-manager denial and new-manager authorization | `phase1-behavior.test.ts` - manager authority / replacement test |
| Concurrent manager replacement and one-active-manager invariant | `phase1-behavior.test.ts` - manager authority / concurrent test |
| Forged account/unit/manager fields, employee/direct-ID hierarchy denial | `phase1-behavior.test.ts` - authentication third test and manager authority final test |
| Lowercase physical tables, partial unique indexes, account/unit constraints, old chain absent | `phase1-schema.test.ts` |
| Fresh migration from zero, required tables, second idempotent migration run | `phase1-migration.test.ts` |
| Parameterized user-controlled SQL | Service implementation review plus all Phase 1 service tests use UUID/values parameters; security scan covers source policy |
