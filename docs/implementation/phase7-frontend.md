# Phase 7 — Frontend Completion (React RTL Workspaces on Stable v5 APIs)

Status: implemented on branch `feat/phase7-frontend-completion`.

## 1. Scope

Phase 7 wires the React 19 + Vite SPA to the stable v5 backend contracts produced by Phases 1–6 and replaces every superseded v3/v4 frontend behavior. Exit gate (Blueprint §Implementation phases): *"React RTL workspaces wired to stable APIs; no security logic only in frontend."*

Phase 8 remains deferred: no PDF visual-fidelity redesign, no load/UAT work, no infrastructure changes.

## 2. Backend prerequisite APIs added (smallest compliant bridges)

All new endpoints live inside the existing modular-monolith structure, reuse the established authorization helpers (`requireOperationalUser`, `requireCurrentHrManager`, `requireRequestReadAccess`, `lockCurrentStageExecution` semantics unchanged), and were verified against pg-mem test doubles plus the existing regression suite.

| Route | Purpose | Authorization | Why needed |
|---|---|---|---|
| `GET /api/reference/routing-units`, `/job-categories`, `/qualification-statuses` | Read-only reference data for request creation and secondment forms | `requireAuthenticated` (router pre-existing; was unmounted) | Request creation requires `routingUnitId`; S2 needs job categories and qualification statuses |
| `GET /api/workflow/manager/subordinates` | Safe assignable-subordinate picker | OPERATIONAL + derived active managed unit (`UNIT_MANAGER_REQUIRED` otherwise); unit never supplied by caller | Manager assign UI previously had only the ADMIN-gated hierarchy endpoint |
| `GET /api/workflow/requests/:requestId/candidate-lookup/:personnelNumber` | Read-only HR preparation preview | Same gates as `addCandidate`: active initial P1/S1 WorkAssignment assignee, DRAFT request, latest ACTIVATED snapshot, routing-unit match (`CANDIDATE_ROUTING_MISMATCH`) | Preview/add cannot diverge: both share the draft/assignment and activated-snapshot gates; preview mutates nothing |
| `GET /api/admin/dashboard` | Current-v5 Admin counts, unit summary, active snapshot and recent audit activity | ADMIN only | Restores useful metrics without reading obsolete `egas_*` tables |
| `GET /api/workflow/requests/:requestId/signoffs` | Frozen signer blocks for the UI | Same request-read boundary as timeline/documents reads; IDOR-safe 404 | No prior client-facing signoff read existed; the legacy copied `modules/workflow/signature-service.ts` (old `egas_*` schema) remains dead and unused |

Manager Inbox DTO extension: `StageExecutionSummary` gains optional `suggestedAssigneeUserId` / `suggestedAssigneeDisplayName`. Derivation: most recent worker of the prior execution of the same business stage within the same iteration, returned only while still active + OPERATIONAL + active member of the current responsible unit. It is presentation-only; `POST /stages/:id/assign` revalidates membership authoritatively.

The final adversarial correction pass added migrations `005_audit_identity_snapshots.sql` and `006_core_history_and_hierarchy_guards.sql`. They freeze actor/subject labels for new audit evidence and enforce active-account hierarchy plus append-only historical-evidence invariants in PostgreSQL.

## 3. Frontend architecture

```
apps/web/src/
  api/
    client.ts        unchanged transport: same-origin credentials, CSRF header, safe ApiError
    endpoints.ts     single typed registry of every runtime API URL (auth/reference/workflow/
                     promotion/secondment/signatures/documents/admin)
    types.ts         v5 identity: accountType ADMIN|OPERATIONAL, OperationalContext{unitKind,isManager,...}
    workflow-types.ts mirrors backend DTOs (request/execution/candidates/notes/timeline/
                     notifications/promotion decisions/secondment options+selections/signoffs)
    admin-types.ts   accounts, units, members, manager history, subordinates
    messages.ts      centralized stable error-code → Arabic message mapping
  auth/
    AuthProvider     login/logout/change-password/me; selectRole removed entirely
    guards.tsx       RequireAdmin / RequireOperationalManager / RequireHrOperational (presentation only;
                     RequireRole.tsx deleted)
  layout/AppShell    identity-driven navigation + notification drawer on /api/workflow/notifications
  components         StageActionsPanel, SignAndAdvanceControl, SignatureAssetsPanel, CandidatePanel,
                     PromotionDecisionsPanel, SecondmentStagePanel, SignoffsView, DocumentPanel,
                     NotesPanel/TimelinePanel, StatusBadge/StageChip, PasswordConfirmationDialog (kept),
                     EmptyState/AuthLayout/BrandMark (kept)
  pages              Dashboard, ManagerInbox, MyWork, NewRequest, Requests (history/search),
                     RequestDetail, Notifications, SignatureSettings,
                     admin/{AdminAccounts,AdminUnits,AdminAudit}
```

Deleted obsolete code: `RoleSelectionPage`, `HistoryPage` (+test), `RequireRole`, `WorkflowControlsPanel` (recall/cancel-returned era), `SignoffPanel` (P1/P2/S1/S2-only signing), `PromotionWorkflowPanel`/`SecondmentWorkflowPanel` (v4 shapes), `admin/{AdminUsersPage,AdminAuthoritiesPage,AdminDatasetPage,AdminAuditPage,AdminDashboardPage}`, and the deprecated `activeRole`/`availableRoles` fields. The stylesheet no longer loads any asset from `docs/uis_and_html/`.

## 4. Navigation / workspaces

- **ADMIN**: role-aware metrics, readable audit activity, Accounts, Operational Units, and the ADMIN-only Audit browser. Admin accounts have zero workflow surface.
- **OPERATIONAL manager** (any unit kind): manager-inbox metrics, صندوق المدير، عملي، الطلبات والسجل، الإشعارات، إعدادات التوقيع.
- **OPERATIONAL employee**: assigned/correction/review metrics, عملي، الطلبات والسجل، الإشعارات، إعدادات التوقيع.
- **Every active HR operational member additionally**: إنشاء طلب. HR-manager-only restart/cancel controls remain unchanged.
Navigation is UX only; the server rejects unauthorized calls independently.

## 5–8. Manager Inbox / My Work / assignment loop / request creation

- **Manager Inbox** (`GET /api/workflow/manager/inbox`): open stages of the caller's managed unit with request number, type, business stage chip + Arabic label, execution/iteration numbers, work state badge, current assignee, previous-worker suggestion hint, opened time; direct-take button per row; full assign/reassign (with suggestion preselect) from the request page. HR managers see `REJECTED_PENDING_HR_DECISION` requests with exactly restart (iteration N+1) or cancel — no fabricated StageExecution.
- **My Work** (`GET /api/workflow/my-work`): assigned stages with state; correction-required rows call out resubmission.
- **Loop**: MANAGER_INBOX → assign/take → ASSIGNED/IN_PROGRESS → employee submit-to-manager → MANAGER_REVIEW → approve-and-advance (non-signing) or sign-and-advance (signing) / internal-correction (same execution) / return-previous (fresh execution, same iteration) / reject (→ REJECTED_PENDING_HR_DECISION). Every mutation reloads authoritative state; stale-state codes (409 family) map to "update the request" messages.
- **Creation** (active HR operational member): `{ requestType, routingUnitId }` only. The transaction creates P1/S1 with a self WorkAssignment in `IN_PROGRESS`; the creator prepares candidates and submits to `MANAGER_REVIEW`. The HR manager then signs/approves or returns the same execution for correction.
- **Internal correction**: one dialog requires a reason and defaults to the current/previous employee, permits another active same-unit subordinate, or explicit manager self-work. The transaction preserves/replaces the WorkAssignment, records previous + selected assignees and self-work choice in `stage_action`/audit, and exposes the persistent reason on My Work and request detail.

## 9–10. Promotion & Secondment UI

- Promotion decisions editor appears only at P4 for eligible editors (unit manager always; active assignee before review submission). Per candidate: SAME_POSITION / OTHER_POSITION (+required targetJobTitle, no target-routing selector anywhere), recommendation (required), optional notes. P4O/P5/completed contexts render strictly read-only decisions. The P4 sign-and-advance routes to P5 or P4O by backend rule only.
- Secondment: S2 editor (preparation `lastPromotionReport` + `jobCategoryCode` from reference; proposed-position options add/edit/remove with qualification statuses from reference) for manager-or-assigned employee pre-review; S3 radio selection restricted to authoritative S2 options (`selectedOptionId`); S4/S5 read-only selections. No hidden replacement options anywhere.

## 11. Signature UX

- `إعدادات أصل التوقيع` is explicitly account/profile asset management: upload PNG/JPEG ≤1MB (server canonicalizes), list with images, deactivate. It does not approve requests.
- Signing uses one atomic `POST /api/workflow/stages/:id/sign-and-advance` with `{password, signatureAssetId, jobTitleOverride?}`; stages exactly P1/P2/P4/S1/S2/S3. The reused `PasswordConfirmationDialog` wipes password state immediately after each attempt, supports fresh retries, and wrong passwords produce `SIGNATURE_PASSWORD_INVALID` messaging with zero workflow mutation. No trimming, logging, storage, or URL transmission of passwords.

## 12–13. Documents / history / notifications

- Documents: `current.pdf` always available to authorized viewers; `final.pdf` shown when status COMPLETED (view/print links); `audit.pdf` evidence report. Draft/received PDF concepts removed.
- History over `GET /api/workflow/requests` with server-side search, status, and request-type filters inside the authorized query; v5 vocabulary columns (currentStageCode, iteration, work state).
- Notifications fully on `/api/workflow/notifications` + `/:id/read`; unread count derived from the unread list; drawer and page link into requests.

## 14. Admin UI

- Accounts: create ADMIN/OPERATIONAL (operational requires initial unit), edit current display name/job title through the ADMIN API, enable/disable/unlock/reset-temporary-password. Profile edits audit changed fields and never mutate membership, manager authority, or frozen WorkflowSignoff snapshots. Temporary passwords are displayed once then discarded from state.
- Units: HR/ORG/AUTH tiles with routing-unit association for AUTH; unit detail shows members, current manager, transfer-membership (single-active-membership enforced server-side), manager replacement with reason, subordinates, and append-only manager history.

Dataset/import management intentionally has **no browser surface** (controlled CLI ingress per PILOT_SETUP.md). The Admin Audit browser presents Arabic business labels, event-time actor/subject snapshots with safe identity fallbacks, server-side filters, and a print view. Export remains safely capped at 100; when more records match, the UI and printed report state the total and exported counts and explicitly mark the report as truncated while preserving the selected filters.

## 15. Test coverage

Backend (`services/api/test/phase7-frontend-bridges.test.ts`): subordinate/suggestion safety; HR-employee creation and initial ownership; employee submit to manager; same/other/self correction ownership with persistent evidence and cross-unit rejection; current-v5 Admin dashboard and ADMIN-only audit; immutable historical attribution, sensitive-detail filtering, resolution fallbacks; account name/title editing with unchanged membership/manager assignment and frozen historical signoff identity; server-side request-history filters; candidate preview and safe signoff reads.

Frontend tests cover HR-employee Create Request visibility, dashboard metrics, Arabic business terminology, account edit preload/save/refresh, correction default/alternate/self choices and persistent reason, normal non-signing approval, and atomic signing with the exact P1/P2/P4/S1/S2/S3 allow-list.

Legacy tests asserting superseded behavior (`HistoryPage.test.tsx`, old `NewRequestPage` contract, `ACTIVE_ROLE_REQUIRED` fixture) were replaced or updated accordingly.

## 16. Acceptance matrix (traceability)

| Requirement (v5.2/Blueprint/prompt) | Frontend surface | API used | Authorization owner | Test |
|---|---|---|---|---|
| Admin accounts/units/membership/manager replacement | AdminAccountsPage, AdminUnitsPage | `/api/admin/accounts*`, `/api/admin/operational-units*` | requireAdmin (backend) | guards.test, phase1 suite |
| Manager Inbox | ManagerInboxPage | `/api/workflow/manager/inbox` | engine manager query | ManagerInboxPage.test |
| Assignment / reassignment | StageActionsPanel AssignPicker | `POST .../assign` | `requireCurrentUnitManager` + `requireUnitMember` | phase3 core suite |
| Manager direct take | Inbox row + panel | `POST .../take` | same | ManagerInboxPage.test |
| Immediate old-assignee revocation | n/a (backend invariant) | assign/reassign/take | transactional UPDATE ending assignments | phase1/phase3 suites |
| My Work | MyWorkPage | `/api/workflow/my-work` | active WorkAssignment query | manual/e2e deferred |
| Submit → manager review | StageActionsPanel | `submit-to-manager` | NOT_ACTIVE_ASSIGNEE guard | phase3 suite |
| Internal correction / return / reject / restart / cancel | StageActionsPanel + inbox + detail | corresponding commands | manager/HR-manager checks | phase3 suite + UI tests |
| Promotion P1–P5/P4O | PromotionDecisionsPanel + generic advance/sign | decisions GET/PUT, advance/sign | STAGE_NOT_P4 + editor rules | phase4 suite |
| Secondment S1–S5 | SecondmentStagePanel | preparation/options/selections | stage-scoped editor rules | phase5 suite |
| Official signing stages + fresh reauthentication | SignAndAdvanceControl | `sign-and-advance` | manager-of-unit at signing | SignAndAdvanceControl.test + phase6 suites |
| Current/final/audit PDFs | DocumentPanel | `/api/documents/requests/:id/*.pdf` | document routes' access checks | phase6-pdf suite |
| Audit/history | TimelinePanel, NotesPanel, RequestsPage | timeline/notes/list | requireRequestReadAccess | phase3/history suites |
| Notifications | AppShell drawer, NotificationsPage | `/api/workflow/notifications*` | recipient scoping | manual smoke deferred |
| Arabic RTL interface | `dir="rtl"` root, Arabic labels throughout | — | — | visual/manual |
| Frontend not an authorization boundary | guards are navigation-only; all mutations hit guarded APIs | all | backend | design review + tests above |

## 17. Known gaps / deferred

- `PROMOTION_DEPARTMENT_REQUIRED` external data gap persists (documented in Phase 6); the UI surfaces its Arabic message and does not fabricate data.
- The configured PostgreSQL pilot data passed runtime-role, Admin, routing, hierarchy/manager, and active-2026-snapshot checks. Deployment readiness intentionally fails until migrations `005` and `006` are applied with migration-owner credentials.
- Interactive browser smoke was unavailable because the in-app browser blocked access to the local application origin; this was not bypassed with an alternate browser automation path.
- Phase 8 owns final-PDF visual fidelity and remaining accessibility/hardening polish beyond the baseline included here.
