# Phase 3A workflow REST API

Phase 3A exposes request preparation and reusable workflow infrastructure. It does **not** expose submit, signoff, reject, return, restart, recall, decision, or downstream-transition operations. All timestamps are server generated. Every mutation requires the session cookie, trusted `Origin`, CSRF cookie, and matching `X-CSRF-Token` header.

That paragraph describes the original Phase 3A boundary. Additive full-stack milestones now extend the same explicit workflow module; they do not turn the Phase 3A draft fields into generic client-writable state.

Responses use camelCase allow-listed DTOs. Errors use `{ "error": { "code": "...", "message": "..." } }`. An inaccessible object normally returns `404` to avoid revealing whether its ID exists. Lists accept bounded `skip`/`top`; `top` cannot exceed 100.

## Requests

### Create a draft

`POST /api/workflow/requests` — active role `EMPLOYEE_AFFAIRS`; CSRF required.

```json
{ "requestType": "PROMOTION", "cycleYear": 2026, "formMonth": 8, "formYear": 2026 }
```

Only `PROMOTION` and `SECONDMENT` are accepted. The server creates the request, iteration 1, and an open task assigned to the creator at P1 or S1 in one transaction. Status remains `DRAFT`. HTTP `201` returns the request-detail DTO. The request UUID is also the Phase 3A request number because no approved human-number format exists.

### List owned drafts/history

`GET /api/workflow/requests?skip=0&top=50&requestType=PROMOTION&status=DRAFT&cycleYear=2026` — active role `EMPLOYEE_AFFAIRS`.

Only the authenticated Employee Affairs user's requests are returned. Every item contains `id`, `requestNumber`, `requestType`, cycle/form fields, `status`, `currentStage`, `currentIterationNo`, routing-unit and authority summaries, creator, candidate count, timestamps, `version`, `editable`, and `actionable`.

### Request detail

`GET /api/workflow/requests/:requestId` — active operational role.

Employee Affairs may read its own request. Organization or Approving Authority access requires the current task to be assigned/claimed by that user. The response adds `candidates`:

```json
{
  "id": "uuid",
  "requestType": "PROMOTION",
  "status": "DRAFT",
  "currentStage": "P1",
  "currentIterationNo": 1,
  "routingUnit": { "id": "uuid", "nameAr": "..." },
  "approvingAuthority": null,
  "candidateCount": 1,
  "editable": true,
  "actionable": true,
  "candidates": [{
    "id": "uuid", "snapshotYear": 2026, "personnelNumber": "100",
    "employeeName": "...", "subgroup": "...", "currentJobTitle": "...",
    "performanceRating": "جيد", "qualificationSource1": null,
    "qualificationSource2": null, "qualificationDate": null,
    "sourceRoutingUnit": "...", "routingUnitName": "...",
    "warnings": { "performanceRequiresAttention": true, "performanceMissing": false }
  }]
}
```

The candidate data is copied from, and references, the immutable active annual snapshot. `جيد` is a non-blocking warning; NULL remains missing.

## Draft candidates

`POST /api/workflow/requests/:requestId/candidates` — owning `EMPLOYEE_AFFAIRS`; CSRF required.

```json
{ "personnelNumber": "100" }
```

No employee master fields are accepted. The first candidate atomically establishes request routing. Later candidates must match. The response is the updated detail DTO (HTTP `201`).

`DELETE /api/workflow/requests/:requestId/candidates/:candidateId` — owning `EMPLOYEE_AFFAIRS`; CSRF required; empty JSON body.

Removal is allowed only in editable P1/S1 draft state and returns `204`. It is a soft removal so notes/actions/audit references remain intact. Removing the final candidate transactionally clears derived draft routing and selected-authority state.

## Authority options and selection

`GET /api/workflow/requests/:requestId/authority-options` — owning `EMPLOYEE_AFFAIRS`.

Returns only currently active/date-valid assignments for the request routing unit whose account and `APPROVING_AUTHORITY` role are active:

```json
[{ "id": "uuid", "displayName": "...", "staffIdentifier": "...", "authorityKind": "PRIMARY", "authorityJobTitle": "...", "preferred": true }]
```

An empty array is valid. `preferred` reflects `isPrimary`; no assignment is created or inferred.

`PUT /api/workflow/requests/:requestId/authority` — owning `EMPLOYEE_AFFAIRS`; CSRF required.

```json
{ "authorityAssignmentId": "uuid" }
```

The assignment must still be an eligible option for the routing unit. The draft records the chosen assignment plus display snapshots without claiming that submission/freeze occurred. Returns the updated detail DTO.

## Notes and timeline

`GET /api/workflow/requests/:requestId/notes?top=100` — authorized current operational role.

`POST /api/workflow/requests/:requestId/notes` — authorized current operational role; CSRF required.

```json
{ "candidateId": null, "message": "Request-level message" }
```

Omit/use null `candidateId` for request scope, or use an active candidate ID belonging to this request. Text is trimmed and limited to 2,000 characters. Notes record current iteration/task/stage, account, active-role snapshot, and server time. They are append-only: no update or delete routes exist.

`GET /api/workflow/requests/:requestId/timeline?top=100` returns chronological allow-listed `ACTION` and `NOTE` entries. It includes request/candidate/authority/task-claim actions and notes, but never audit hashes, security-event data, or raw JSON metadata.

## Organization task foundation

`GET /api/workflow/organization/queue?skip=0&top=50` — active role `ORGANIZATION`.

Only open/claimed P2, S2, and S4 tasks appear. Items include task/request summary, stage/status, candidate count, `claimable`, `claimedByMe`, and claimant display name when claimed. Phase 3A creates no live Organization task because there is deliberately no P1/S1 submit/signoff bypass.

`POST /api/workflow/tasks/:taskId/claim` — active role `ORGANIZATION`; CSRF required; empty JSON body.

A conditional PostgreSQL update claims only an unassigned open Organization-stage task and snapshots `ORGANIZATION`. Claim, action, and audit evidence commit together. A competing claimant receives `409 WORKFLOW_TASK_ALREADY_CLAIMED`.

## Approving Authority queue foundation

`GET /api/workflow/authority/queue?skip=0&top=50` — active role `APPROVING_AUTHORITY`.

Returns only open/claimed P4 and S3 tasks whose server-owned `assignedUser_ID` is the authenticated account. The endpoint does not accept a routing unit, authority assignment, delegate, or user ID from the client and returns an empty array when no work is assigned. Later workflow transitions remain responsible for resolving an effective primary/delegated recipient before creating the task.

## Notifications

`GET /api/notifications?skip=0&top=50&unreadOnly=true` — any selected active role. Only the authenticated recipient's notifications are returned. A DTO contains `id`, optional `requestId`/`requestPath`, `type`, Arabic title/body, `createdAt`, `readAt`, and `isRead`.

`POST /api/notifications/:id/read` — notification owner; CSRF required; empty JSON body. The operation is idempotent for the owner and returns `404 NOTIFICATION_NOT_FOUND` for another recipient's ID.

## Domain errors

Common codes include `WORKFLOW_MIGRATION_REQUIRED`, `WORKFLOW_TYPE_INVALID`, `WORKFLOW_VALIDATION_FAILED`, `ACTIVE_SNAPSHOT_UNAVAILABLE`, `EMPLOYEE_NOT_IN_ACTIVE_SNAPSHOT`, `EMPLOYEE_ROUTING_UNRESOLVED`, `WORKFLOW_CANDIDATE_DUPLICATE`, `WORKFLOW_ROUTING_MISMATCH`, `WORKFLOW_ROUTING_REQUIRED`, `WORKFLOW_AUTHORITY_NOT_FOUND`, `WORKFLOW_REQUEST_NOT_EDITABLE`, `WORKFLOW_REQUEST_NOT_FOUND`, `WORKFLOW_CANDIDATE_NOT_FOUND`, `WORKFLOW_TASK_NOT_FOUND`, `WORKFLOW_TASK_ALREADY_CLAIMED`, `WORKFLOW_TASK_UNAVAILABLE`, `NOTIFICATION_NOT_FOUND`, `ACTIVE_ROLE_REQUIRED`, and `AUTHENTICATION_REQUIRED`.

Validation is `400`, missing authentication `401`, wrong active role `403`, inaccessible IDs `404`, and state/concurrency conflicts `409`. Unexpected database/internal details are never returned.

## Additive Secondment execution API

Migration `004_secondment_workflow_integrity` protects one selected position per candidate/iteration, one task per stage/iteration, position selection consistency, and the preserved physical foreign keys. Positions are scoped to the current immutable iteration.

- `GET /api/workflow/requests/:id/secondment/positions` — participating operational actor.
- `POST /api/workflow/requests/:id/secondment/candidates/:candidateId/positions` — claimed S2 Organization actor; explicit `positionTitle`, `organizationalDependency`, and `qualificationStatus` (`QUALIFIED` or `NOT_QUALIFIED`).
- `PUT/DELETE /api/workflow/requests/:id/secondment/positions/:positionId` — claimed S2 Organization actor.
- `PUT /api/workflow/requests/:id/secondment/candidates/:candidateId/selection` — assigned S3 authority; selects exactly one supplied option in a serialized transaction.
- Explicit transitions: `submit-s1`, `submit-s2`, `approve-s3`, `confirm-s4`, and `final-approve-s5` under the request's `/secondment/` path.

S1 and S2 fail closed with `WORKFLOW_SIGNOFF_REQUIRED` until the corresponding immutable signoff exists. S2 requires at least one complete position for every active candidate. S3 requires exactly one selected position per candidate. S4 returns to the original S2 Organization claimant, and S5 returns to the originating Employee Affairs account. Each transition conditionally completes one task, creates at most one next task, advances the request, records action/audit evidence, and creates actionable notifications in one transaction.

The preserved delegation model deliberately permits overlapping delegation records. Because the authoritative baseline does not define precedence between more than one simultaneously effective delegate, S2 fails closed with `WORKFLOW_AUTHORITY_DELEGATION_AMBIGUOUS` rather than selecting one by an invented ordering rule. This remains a stakeholder resolution item.

## Additive Promotion execution API

Migration `005_promotion_workflow_integrity` adds the preserved physical foreign keys for per-candidate, per-iteration promotion decisions. Migration 001's Same/Other Position checks and the baseline uniqueness constraint remain unchanged.

- `PUT /api/workflow/requests/:id/promotion/candidates/:candidateId/preparation` — claimed P2 Organization actor; selects an active approved job category and optionally records the manual `lastPromotionReport` field whose authoritative source/format remains open in FR-PDF-08.
- `GET /api/workflow/requests/:id/promotion/decisions` — participating operational actor.
- `PUT /api/workflow/requests/:id/promotion/candidates/:candidateId/decision` — assigned P4 authority only. `SAME_POSITION` stores no target title; `OTHER_POSITION` requires a nonblank manually entered target title.
- Explicit transitions: `submit-p1`, `submit-p2`, `approve-p3`, `approve-p4`, and `final-approve-p5` under the request's `/promotion/` path.

P1 and P2 require immutable signoffs. Organization prepares grouping/form data but has no endpoint to make a Same/Other Position decision. P3 is an explicit Employee Affairs forwarding approval. P4 requires one authority decision for every active candidate and locks the iteration by transitioning away from P4. P5 performs final Employee Affairs approval. All task completion, request advancement, next-task creation, audit/action evidence, and actionable notification writes are transactional and concurrency checked.

## Workflow controls and iteration history

- `POST /api/workflow/requests/:id/return-for-correction` and `/reject` require a nonblank reason and are restricted to the assigned actor at P2/P3/P4 or S2/S3/S4.
- `POST /api/workflow/requests/:id/restart` is restricted to the originating Employee Affairs user after return/rejection. It creates a new active iteration and start-stage task, increments `currentIterationNo`, and leaves the prior returned iteration, tasks, actions, decisions, signoffs, notes, and audit evidence intact.
- `POST /api/workflow/requests/:id/cancel-returned` is the originating Employee Affairs user's alternative to restart and closes the returned iteration/request without deletion.
- `POST /api/workflow/requests/:id/recall` requires a reason, is restricted to the originating Employee Affairs user on a non-final active request, marks the previous iteration `RECALLED`, cancels its open task, and creates a new start iteration/task.

Return and reject are distinct audit/action codes but both create a `RETURNED` actionable request for the originator, as required by BR-010..013. Submitted decisions remain in the old iteration. Row locks, conditional task updates, the one-task-per-iteration-stage index, and conditional request updates prevent double transition/restart/recall.

## Mandatory signoff and signature assets

- `POST /api/workflow/signatures` — active `EMPLOYEE_AFFAIRS` or `ORGANIZATION`; CSRF and trusted Origin required. The request body is raw binary with exact `Content-Type: image/png` or `image/jpeg`; client filenames and paths are never accepted.
- `GET /api/workflow/signatures` — lists up to 20 active assets owned by the authenticated account. It never exposes a storage key or filesystem path.
- `GET /api/workflow/signatures/:assetId/content` — owner or an actor who can access a request whose immutable signoff references the asset. Unauthorized IDs return the same 404 as unknown IDs.
- `POST /api/workflow/requests/:id/signoff` — current assigned P1/S1 Employee Affairs or claimed P2/S2 Organization actor only. Body: `{ "signatureAssetId": "uuid", "jobTitle": "stage-specific title" }`.
- `GET /api/workflow/requests/:id/signoffs` — authorized request actor; returns immutable signer/stage/iteration snapshots and the server asset ID.

The server enforces a 1 MiB encoded-input limit by default, a 2,048 × 2,048 per-axis limit, and a 4,000,000 decoded-pixel limit. It decodes only PNG/JPEG, rejects media-type spoofing and multi-page input, auto-orients, strips metadata through canonical re-encoding, and stores a fresh PNG under a random server identity with restricted filesystem permissions. SHA-256 is calculated over the canonical bytes and snapshotted into `egas_WorkflowSignoff`. Signer name comes only from the authenticated active account; the account job title is the default and an override affects only that signoff. The stage, task, actor, role, signature ownership, and duplicate-stage checks run transactionally. Existing append-only triggers and the request/iteration/stage uniqueness constraint prevent later overwrite.

## PDF evidence and audit documents

- `GET /api/workflow/requests/:id/documents` lists only stage-received snapshots belonging to the authenticated user under the exact active role and indicates final availability only for the originating Employee Affairs user.
- `GET /api/workflow/requests/:id/pdf/draft` renders the current saved form for an authorized workflow participant. It is never cached as immutable evidence.
- `GET /api/workflow/requests/:id/pdf/received/:snapshotId` materializes and then reuses the immutable official form for exactly the task data that user/role received. Another participant's snapshot ID returns 404.
- `GET /api/workflow/requests/:id/pdf/final` serves the snapshot frozen transactionally at P5/S5 approval and is restricted to the originating Employee Affairs role.
- `GET /api/workflow/requests/:id/pdf/audit` creates the complete request audit PDF for the originating Employee Affairs role.
- `GET /api/admin/workflow-audit.pdf` creates an Admin-only request report or a bounded routing-unit report using `periodCode` plus start/end dates. Multi-request reports require a routing unit and are limited to 366 days and 5,000 events.

The renderer accepts structured server DTOs only—no HTML, URL, external network, `file://`, or client filename/path input. It uses packaged IBM Plex Sans Arabic assets, RTL/right-aligned Arabic shaping, automatic page continuation, canonical signature files verified against signoff hashes, a two-render concurrency limit, bounded queue, 15-second timeout, and 20 MiB output ceiling by default. Frozen PDFs use random server-only identities and SHA-256 verification on every reopen. Each generation/view is recorded in `egas_PdfGenerationLog`; detailed audit output remains separate from the concise official approval section. `?download=1` changes only Content-Disposition.

## Role-scoped search/history and notification count

`GET /api/workflow/history?skip=0&top=50` is bounded to 100 rows and evaluates exactly one active operational role. Employee Affairs sees only requests it originated; Organization sees requests with an Organization-stage task assigned to that account; Approving Authority sees requests with a P4/S3 task assigned to that account. Filters are `requestType`, `status`, exact `routingUnitId`, exact `personnelNumber`, `q` (request-number substring or exact Personnel Number), and inclusive `from`/`to` creation dates. Personnel filtering occurs only after the request scope predicate, so this is not an employee directory.

`GET /api/notifications/unread-count` returns `{ "count": number }` for the authenticated recipient. The shell uses it for an accurate badge even when the compact drawer displays only eight recent items. Notification reads remain owner-only and deep-link only to the server-scoped request detail route.
