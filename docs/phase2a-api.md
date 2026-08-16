# Phase 2A Express REST API

All responses are JSON except successful logout (`204`). Unknown resources return `404`. Validation/authentication/authorization/conflict/rate failures use `400/401/403/409/429`; unexpected failures return a generic `500` without SQL or stack details.

## Browser/session contract

- Use the API origin or a same-origin proxy and browser credentials.
- The configurable session cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, explicitly expires, and is `Secure` when configured (mandatory in production).
- The companion `<session-name>_CSRF` cookie is readable. Every authenticated mutation sends its exact value in `X-CSRF-Token`; the API compares header, cookie, stored session hash, and trusted Origin.
- Login, password change, and role selection issue/rotate cookies. Raw session/CSRF tokens are never returned in JSON or stored in browser storage.
- `401` means no valid session. `403` means the selected role/privilege, password-change, CSRF, or Origin requirement failed.

## Authentication

| Method/path | Request | Result |
|---|---|---|
| `POST /api/auth/login` | `{username,password}` | Safe user context and cookies. Generic credential errors; exactly one role is selected automatically, otherwise `activeRole:null`. |
| `GET /api/auth/me` | none | Current safe user/role context. |
| `POST /api/auth/change-password` | `{currentPassword,newPassword}` | Argon2id update, mandatory flag cleared, all sessions revoked, replacement session issued. |
| `POST /api/auth/select-active-role` | `{role}` | Validates one active assignment, revokes old session, issues a session authorized only as that role. |
| `POST /api/auth/logout` | empty object/body | Revokes current session, clears cookies; safe to repeat anonymously. |

Safe context includes `userId`, `username`, optional staff/job fields, `displayName`, `mustChangePassword`, `isActive`, `availableRoles`, and nullable `activeRole`. Password hashes and raw credentials are never returned.

## Admin and authority routes

Every `/api/admin/*` route requires a valid session, `mustChangePassword=false`, and selected `activeRole=ADMIN`. An unselected Admin assignment conveys no authority. Admin-target/ADMIN-role security changes additionally require the selected assignment's `canManageAdmins=true`. Mutations require CSRF/Origin validation.

| Method/path | Purpose |
|---|---|
| `GET /api/admin/users?search=&skip=&top=` | Bounded safe user/role list (top max 100). |
| `GET /api/admin/users/:id` | Safe account detail. |
| `POST /api/admin/users` | Create account with distinct explicit roles and forced password change. |
| `PATCH /api/admin/users/:id` | Version-checked profile update. |
| `POST /api/admin/users/:id/roles` | Assign/reactivate a role and revoke sessions. |
| `DELETE /api/admin/users/:id/roles/:role` | Revoke role and sessions. |
| `POST /api/admin/users/:id/disable` / `enable` | Version-checked soft disable/enable. |
| `POST /api/admin/users/:id/unlock` | Clear failure/lock state. |
| `POST /api/admin/users/:id/reset-password` | Argon2id temporary password, mandatory change, session revocation. |
| `GET/POST /api/admin/authority-assignments` | List or create assignments. |
| `PATCH /api/admin/authority-assignments/:id` | Version-checked update. |
| `POST /api/admin/authority-assignments/:id/deactivate` | Deactivate assignment and delegations. |
| `GET/POST /api/admin/delegations` | List or create delegations. |
| `PATCH /api/admin/delegations/:id` | Version-checked update. |
| `POST /api/admin/delegations/:id/deactivate` | Explicit deactivation. |
| `GET/POST /api/admin/routing-aliases` | List or explicitly create exact annual-source routing aliases. |
| `PATCH /api/admin/routing-aliases/:id` | Update/re-enable an alias through a locked, audited operation. |
| `POST /api/admin/routing-aliases/:id/deactivate` | Explicit alias deactivation. |
| `GET /api/admin/import-batches` | Bounded/filterable import-batch list. |
| `GET /api/admin/import-batches/:id` | Safe batch detail with aggregate issue codes. |
| `GET /api/admin/import-batches/:id/rows` | Bounded validation rows without raw workbook JSON or employee names/IDs. |
| `GET /api/admin/import-batches/:id/unmapped-routing-labels` | Distinct unresolved labels and counts. |
| `POST /api/admin/import-batches/:id/revalidate` | Re-run deterministic normalization/routing; never activates. |
| `POST /api/admin/import-batches/:id/activate` | Explicit zero-blocked full-snapshot activation. |

Account self-deactivation/self-role changes are prohibited and at least one active Manage-Admins account must remain. Authority assignment requires an active routing unit and active `APPROVING_AUTHORITY` account, permits one active primary per unit, and blocks Admin self-configuration. Delegations require eligible parties, ordered dates, and no self-delegation; no unsupported overlap rule is invented.

## Reference and health

- `GET /health` — liveness.
- `GET /ready` — database readiness.
- Authenticated: `GET /api/reference/routing-units`, `/job-categories`, `/qualification-statuses`.
- Employee Affairs active role: `GET /api/employee-data/active-snapshot` and `GET /api/employee-data/employees/:personnelNumber`.

No OData or generic persistence routes exist. Workflow/state/snapshot entities remain unexposed pending separately approved phases.
