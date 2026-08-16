# Phase 2A authentication and Admin API contract

This document is the integration contract for the later React clients. The CAP services use OData V4 conventions: unbound actions are `POST` requests with JSON bodies, and functions are `GET` requests (normally with parentheses and URL parameters). CAP may wrap collection results in its standard `value` envelope.

## Browser/session contract

- Serve the browser application from the API origin, or use a same-origin development proxy. CAP CORS is disabled.
- Send requests with browser credentials enabled. Never copy the session token into JavaScript storage.
- `POST /auth/login` sets `EGAS_SESSION` (configurable) as `HttpOnly`, `SameSite=Strict`, path `/`, with the session absolute expiration. It also sets a readable `EGAS_CSRF` cookie with the same scope and expiration.
- For every authenticated mutation, read `EGAS_CSRF` and send the exact value in `X-CSRF-Token`. The server compares header, cookie, and the current session's stored hash and checks the request Origin. Login performs its own trusted-Origin check.
- Login, password change, and active-role selection rotate credentials. Replace no client state manually; accept the new cookies returned by the response.
- A `401` means the session is absent/expired/revoked. A `403` means the authenticated session lacks the selected role/privilege, password change is still mandatory, or CSRF/origin validation failed.
- Do not cache authentication responses. The service sets `Cache-Control: no-store` when issuing or clearing credentials.

## AuthService (`/auth`)

### Login

`POST /auth/login`

```json
{ "username": "user", "password": "temporary-or-current-password" }
```

The response contains only safe context: `userId`, `username`, optional staff/job fields, `displayName`, `mustChangePassword`, `isActive`, `availableRoles`, and nullable `activeRole`. Wrong credentials, nonexistent users, disabled users, locked users, and rate-limited identifiers receive a generic authentication failure. Five failures in the default ten-minute window lock a known account for the default fifteen minutes; identifier and IP evidence is database-backed.

When exactly one active assignment exists, it becomes the session role. A multi-role user receives `activeRole: null` and must select one. No permissions are combined.

### Current user

`GET /auth/me()`

Returns the same safe context for the current session. This and logout remain available while `mustChangePassword=true`; normal Admin/business access does not.

### Mandatory/current password change

`POST /auth/changePassword`

```json
{ "currentPassword": "current-password", "newPassword": "new-password-at-least-14-characters" }
```

The current password is verified, the new password must differ, Argon2id is used, all old sessions are revoked, `mustChangePassword` is cleared, and a new session/CSRF pair is issued atomically. Failed current-password attempts use the same database-backed failure evidence as login.

### Select active role

`POST /auth/selectActiveRole`

```json
{ "role": "ORGANIZATION" }
```

Allowed values are `ADMIN`, `EMPLOYEE_AFFAIRS`, `ORGANIZATION`, and `APPROVING_AUTHORITY`. The account must own an active assignment. The old session is revoked and a new session with exactly that role is issued.

### Logout

`POST /auth/logout`

Requires CSRF for an authenticated session, revokes it server-side, clears both cookies, records a security event, and is safe to repeat after the session is gone.

## AdminService (`/admin`)

Every operation requires an authenticated session with selected `activeRole=ADMIN` and `mustChangePassword=false`. Possessing an unselected Admin assignment is insufficient. Mutations also require CSRF. Admin-account operations targeting Admin users and Admin role changes require the actor's selected Admin assignment to have `canManageAdmins=true`.

Read functions:

- `GET /admin/listUsers(search=...,skip=0,top=50)` — bounded to 100 rows and returns safe account/role data.
- `GET /admin/getUser(userId=...)`
- `GET /admin/listAuthorityAssignments(routingUnitId=...,activeOnly=true)`
- `GET /admin/listDelegations(assignmentId=...,activeOnly=true)`
- Read-only `RoutingUnits`, `JobCategories`, and `QualificationStatuses` reference projections.

Named mutation actions:

- `createUser`, `updateUser`
- `assignRole`, `revokeRole`
- `disableUser`, `enableUser`, `unlockUser`, `resetPassword`
- `createAuthorityAssignment`, `updateAuthorityAssignment`, `deactivateAuthorityAssignment`
- `createDelegation`, `updateDelegation`, `deactivateDelegation`

Use the fields declared in `services/cap-api/srv/admin-service.cds`. Account, assignment, and delegation updates/deactivations require `expectedVersion`; stale requests return `409`. Account creation supports one or more distinct roles, stores only an Argon2id temporary-password hash, and forces password change. Role/account security changes revoke target sessions. Accounts are disabled, never hard-deleted.

The service prevents Admin self-deactivation and self role changes and preserves at least one active Admin with `canManageAdmins=true`. An approving-authority assignment requires an active routing unit and an active account with an active `APPROVING_AUTHORITY` role. Only one active primary assignment may exist per routing unit. Delegations remain attached to the primary assignment, require an eligible delegate, enforce ordered dates, and reject self-delegation. The baseline defines no additional overlapping-delegation rule, so Phase 2A does not invent one.

## Configuration

Required/available machine-local variables are documented in `.env.example`. Important values are:

- `EGAS_AUTH_FINGERPRINT_SECRET` — unique secret, minimum 32 characters, required outside isolated tests.
- `EGAS_SESSION_COOKIE_NAME`, `EGAS_SESSION_IDLE_MINUTES`, `EGAS_SESSION_ABSOLUTE_HOURS`.
- `EGAS_REQUIRE_SECURE_COOKIE` — must be `true` in production; HTTPS is required.
- `EGAS_LOGIN_WINDOW_MINUTES`, `EGAS_LOGIN_FAILURE_LIMIT`, `EGAS_LOGIN_LOCKOUT_MINUTES`.
- `EGAS_ALLOWED_ORIGINS` — optional additional trusted Origin values; it does not enable CORS.

The local authentication middleware is active in development and production. CAP mocked users are configured only for the isolated test profile.
