# Phase 3A workflow REST API

Phase 3A exposes request preparation and reusable workflow infrastructure. It does **not** expose submit, signoff, reject, return, restart, recall, decision, or downstream-transition operations. All timestamps are server generated. Every mutation requires the session cookie, trusted `Origin`, CSRF cookie, and matching `X-CSRF-Token` header.

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

## Notifications

`GET /api/notifications?skip=0&top=50&unreadOnly=true` — any selected active role. Only the authenticated recipient's notifications are returned. A DTO contains `id`, optional `requestId`/`requestPath`, `type`, Arabic title/body, `createdAt`, `readAt`, and `isRead`.

`POST /api/notifications/:id/read` — notification owner; CSRF required; empty JSON body. The operation is idempotent for the owner and returns `404 NOTIFICATION_NOT_FOUND` for another recipient's ID.

## Domain errors

Common codes include `WORKFLOW_MIGRATION_REQUIRED`, `WORKFLOW_TYPE_INVALID`, `WORKFLOW_VALIDATION_FAILED`, `ACTIVE_SNAPSHOT_UNAVAILABLE`, `EMPLOYEE_NOT_IN_ACTIVE_SNAPSHOT`, `EMPLOYEE_ROUTING_UNRESOLVED`, `WORKFLOW_CANDIDATE_DUPLICATE`, `WORKFLOW_ROUTING_MISMATCH`, `WORKFLOW_ROUTING_REQUIRED`, `WORKFLOW_AUTHORITY_NOT_FOUND`, `WORKFLOW_REQUEST_NOT_EDITABLE`, `WORKFLOW_REQUEST_NOT_FOUND`, `WORKFLOW_CANDIDATE_NOT_FOUND`, `WORKFLOW_TASK_NOT_FOUND`, `WORKFLOW_TASK_ALREADY_CLAIMED`, `WORKFLOW_TASK_UNAVAILABLE`, `NOTIFICATION_NOT_FOUND`, `ACTIVE_ROLE_REQUIRED`, and `AUTHENTICATION_REQUIRED`.

Validation is `400`, missing authentication `401`, wrong active role `403`, inaccessible IDs `404`, and state/concurrency conflicts `409`. Unexpected database/internal details are never returned.
