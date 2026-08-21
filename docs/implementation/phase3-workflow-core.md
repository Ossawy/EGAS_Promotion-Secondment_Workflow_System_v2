# Phase 3 Implementation Summary — Generic Workflow Engine

## 1. Overview

Phase 3 implements the generic core workflow engine for the EGAS Promotion & Secondment Workflow System redesign, enforcing strict state machines, atomic PostgreSQL transactions, dynamic hierarchy-based authorization, race-safe manager locking, and IDOR protection.

---

## 2. Canonical State Model

### Workflow Request States
- `DRAFT`: Initial preparation stage (`P1` / `S1`), candidates may be added/removed by HR manager.
- `ACTIVE`: Request is progressing through subsequent workflow stages.
- `REJECTED_PENDING_HR_DECISION`: A stage was rejected; iteration is ended and control is routed exclusively to the HR manager for restart or cancellation. `current_stage_code` is cleared to `NULL`.
- `COMPLETED`: Terminal completed request state.
- `CANCELLED`: Terminal cancelled request state following HR manager cancellation.

### Workflow Iteration States
- `ACTIVE`: Currently executing workflow iteration (at most one per request enforced by PostgreSQL partial unique index).
- `REJECTED`: Terminal rejected iteration with preserved timestamp and reason.
- `COMPLETED`: Terminal completed iteration.

### Stage Execution States
- `OPEN`: Active stage execution awaiting manager/assignee work or decision (at most one per iteration enforced by PostgreSQL partial unique index).
- `COMPLETED`: Stage completed successfully, submission snapshot frozen.
- `RETURNED`: Stage closed due to an inter-stage return to a prior business stage.
- `REJECTED`: Stage closed due to business rejection.

### Stage Work States (Internal to a single `StageExecution`)
- `MANAGER_INBOX`: Awaiting manager action (assignment or direct take).
- `ASSIGNED`: Assigned to a subordinate employee.
- `IN_PROGRESS`: Currently being worked on by manager or active assignee.
- `MANAGER_REVIEW`: Submitted by employee to the unit manager for review.
- `CORRECTION_REQUIRED`: Returned by manager to assigned employee for internal correction (permitted only from `MANAGER_REVIEW`).
- `COMPLETED`: Work state completed upon stage completion.

---

## 3. Authorization, Locking & Hierarchy Rules

- **Account Type**: `ADMIN` accounts possess zero workflow authority. All workflow operations require an active `OPERATIONAL` account (`requireOperationalUser`).
- **Deterministic Current Stage Locking (`lockCurrentStageExecution`)**:
  - All active-stage mutations lock `workflow_request`, `workflow_iteration`, and `stage_execution` in a deterministic order using `SELECT ... FOR UPDATE`.
  - Verifies that `stage_execution.status = 'OPEN'`, `iteration.status = 'ACTIVE'`, `iteration.id = request.current_iteration_id`, `stage_execution.stage_code = request.current_stage_code`, and `request.status IN ('DRAFT', 'ACTIVE')`.
  - Rejects any stale or historical executions with `STAGE_NOT_CURRENT` or `STAGE_NOT_OPEN`.
- **Dynamic & Race-Safe Manager Authority**:
  - Manager authority is validated against current database state (`UserUnitMembership` + `UnitManagerAssignment`) and locked with `FOR SHARE` on relevant rows.
  - Replaced unit managers immediately fail authorization (`UNIT_MANAGER_REQUIRED`).
- **Employee Edit Authority**:
  - Only the user holding the active `WorkAssignment` (`ended_at IS NULL`) for the locked `StageExecution` may execute employee commands (e.g. `submit-to-manager`).
  - Reassignment immediately terminates the previous assignee's edit authority (`NOT_ACTIVE_ASSIGNEE`).
- **Fail-Closed IDOR Protection**:
  - Read access is restricted strictly to legitimate workflow participants:
    - Request creator
    - Current HR unit manager
    - Work assignment assignees and assigners
    - Stage action actors
    - Workflow note authors
    - Current managers of involved operational units (requiring active membership + active manager assignment)
  - Ordinary unassigned members of involved units are denied read access (404 `REQUEST_NOT_FOUND`).

---

## 4. Responsible Unit Mapping

Operational units are resolved dynamically and validated for single-active-unit invariants:
- **`P1`, `P3`, `P5`, `S1`, `S5`** &rarr; Active `HR` operational unit
- **`P2`, `P4O`, `S2`, `S4`** &rarr; Active `ORG` operational unit
- **`P4`, `S3`** &rarr; Active `AUTH` operational unit whose `routing_unit_id` matches `workflow_request.routing_unit_id`

---

## 5. Command Transitions & Boundaries

### Candidate Management (DRAFT `P1` / `S1`)
- Resolves candidates strictly from the latest `ACTIVATED` `employee_annual_snapshot`.
- Enforces `snapshot.routing_unit_id === request.routing_unit_id`.
- Freezes immutable initial employee data into `request_candidate.frozen_data`.
- Prevents duplicate candidates per request.

### Assignment & Internal Workflow
- **Assign / Reassign**: Atomically closes any prior active `WorkAssignment`, inserts new assignment, updates `work_state` to `ASSIGNED` (or `IN_PROGRESS` if manager self-assigns), and notifies assignee.
- **Take**: Assigns stage directly to current unit manager (`work_state` = `IN_PROGRESS`).
- **Submit to Manager**: Active assignee transitions work state to `MANAGER_REVIEW` and notifies unit manager.
- **Internal Correction**: Manager returns stage to active subordinate employee (`work_state` = `CORRECTION_REQUIRED`) within the **same** `StageExecution`. Permitted only from `MANAGER_REVIEW`. Requires non-empty reason.

### Inter-Stage Return, Reject, Restart & Cancel
- **Return to Previous Stage**:
  - Valid transitions: `P2` &rarr; `P1`, `P3` &rarr; `P2`, `P4` &rarr; `P3`, `P4O` &rarr; `P4`, `P5` &rarr; (`P4O` if executed in iteration, else `P4`), `S2` &rarr; `S1`, `S3` &rarr; `S2`, `S4` &rarr; `S3`, `S5` &rarr; `S4`.
  - Closes current execution as `RETURNED`, creates a **new** `StageExecution` with incremented `execution_no` in the same iteration, routes to destination unit `MANAGER_INBOX`, and notifies destination manager.
- **Reject**:
  - Closes active assignment, marks `StageExecution` as `REJECTED`, marks `WorkflowIteration` as `REJECTED` with reason, sets `workflow_request.status` to `REJECTED_PENDING_HR_DECISION`, clears `current_stage_code = NULL`, and notifies HR manager.
- **Restart**:
  - HR manager only. Creates `WorkflowIteration N+1` (parent = rejected iteration) and fresh `P1`/`S1` `StageExecution`. Prior iterations and executions remain immutable.
- **Cancel**:
  - HR manager only. Transitions request to terminal `CANCELLED` status.

### Generic Stage Advance & Submission Snapshot
- **Approve and Advance**:
  - Signing stages (`P1`, `P2`, `P4`, `S1`, `S2`, `S3`) fail closed with `SIGNATURE_REQUIRED`.
  - Non-signing stages (`P3` &rarr; `P4`, `P4O` &rarr; `P5`, `S4` &rarr; `S5`):
    - Freezes an immutable `stage_submission_snapshot` containing deterministic candidates, form sections (`request_form_section`), and SHA-256 evidence.
    - Calculates `nextExecutionNo = MAX(execution_no for destination stage in iteration) + 1`.
    - Completes the current stage and creates the next stage execution.

---

## 6. Active Phase 3 API Surface

All routes are mounted under `/api/workflow` with `requireOperational`, exact body validation, and CSRF protection on mutation routes:

| Method | Path | Access Control | Description |
|---|---|---|---|
| `POST` | `/api/workflow/requests` | Current HR Manager | Create new Promotion/Secondment request |
| `GET` | `/api/workflow/requests` | Operational Participant | List accessible workflow requests |
| `GET` | `/api/workflow/requests/:id` | Operational Participant | Get request details, candidates, and current stage |
| `POST` | `/api/workflow/requests/:id/restart` | Current HR Manager | Restart rejected request as iteration N+1 |
| `POST` | `/api/workflow/requests/:id/cancel` | Current HR Manager | Cancel rejected request |
| `POST` | `/api/workflow/requests/:id/candidates` | Current HR Manager | Add candidate during DRAFT P1/S1 |
| `DELETE` | `/api/workflow/requests/:id/candidates/:candidateId` | Current HR Manager | Remove candidate during DRAFT P1/S1 |
| `GET` | `/api/workflow/manager/inbox` | Current Unit Manager | List open inbox stages and HR rejection recoveries |
| `GET` | `/api/workflow/my-work` | Active Assignee | List open stages assigned to caller |
| `POST` | `/api/workflow/stages/:id/assign` | Current Unit Manager | Assign/reassign stage to unit member |
| `POST` | `/api/workflow/stages/:id/take` | Current Unit Manager | Manager takes stage for direct work |
| `POST` | `/api/workflow/stages/:id/submit-to-manager` | Active Assignee | Submit stage to manager for review |
| `POST` | `/api/workflow/stages/:id/internal-correction` | Current Unit Manager | Return to employee for internal correction |
| `POST` | `/api/workflow/stages/:id/return-previous` | Current Unit Manager | Return to previous business stage |
| `POST` | `/api/workflow/stages/:id/reject` | Current Unit Manager | Reject iteration and route to HR manager |
| `POST` | `/api/workflow/stages/:id/approve-and-advance` | Current Unit Manager | Advance non-signing review stage |
| `GET` | `/api/workflow/requests/:id/notes` | Operational Participant | List append-only workflow notes |
| `POST` | `/api/workflow/requests/:id/notes` | Operational Participant | Add append-only workflow note |
| `GET` | `/api/workflow/requests/:id/timeline` | Operational Participant | Comprehensive chronological timeline |
| `GET` | `/api/workflow/notifications` | Recipient | List caller notifications |
| `POST` | `/api/workflow/notifications/:id/read` | Recipient | Mark notification read |

---

## 7. Stable Error Codes

- `HR_MANAGER_REQUIRED`: Caller is not the current active manager of the HR operational unit.
- `UNIT_MANAGER_REQUIRED`: Caller is not the current active manager of the responsible operational unit.
- `UNIT_MEMBERSHIP_REQUIRED`: Target user is not an active member of the unit.
- `NOT_ACTIVE_ASSIGNEE`: Caller does not hold the active work assignment.
- `OPERATIONAL_REQUIRED`: Caller account is not an active operational account.
- `ROUTING_UNIT_NOT_FOUND`: Routing unit does not exist or is inactive.
- `RESPONSIBLE_UNIT_UNRESOLVED`: Operational unit configuration is missing or inactive.
- `CANDIDATE_ROUTING_MISMATCH`: Employee snapshot routing unit does not match request routing unit.
- `CANDIDATE_DUPLICATE`: Employee already added as candidate to request.
- `SIGNATURE_REQUIRED`: Attempted generic advance on a signing stage (`P1`, `P2`, `P4`, `S1`, `S2`, `S3`).
- `STAGE_NOT_OPEN`: Attempted mutation on a completed, returned, or rejected stage execution.
- `STAGE_NOT_CURRENT`: Attempted mutation on a stage execution that is no longer the current active stage execution for the request.
- `INVALID_WORK_STATE`: Attempted action invalid for current work state (e.g. internal correction when not in `MANAGER_REVIEW`).
- `REQUEST_NOT_DRAFT`: Candidate modification attempted on non-DRAFT request.
- `REQUEST_NOT_REJECTED`: Restart/cancel attempted on request not in `REJECTED_PENDING_HR_DECISION`.
- `REQUEST_NOT_FOUND`: Request not found or caller lacks read permissions (IDOR guard).
- `NOTIFICATION_NOT_FOUND`: Notification not found or belongs to another user.

---

## 8. Functionality Intentionally Deferred to Phase 4 / 5 / 6

Phase 3 implements only the generic workflow engine. The following specialized domains are intentionally deferred:
- **Phase 4 (Promotion Domain)**: `SAME_POSITION` vs `OTHER_POSITION` decisions, target job title requirements, `P4` &rarr; `P4O`/`P5` branching, and `P4O` organizational review.
- **Phase 5 (Secondment Domain)**: Proposed position option entries (`secondment_position_option`) by ORG and single-option selection (`secondment_decision`) by AUTH.
- **Phase 6 (Signatures & Documents)**: Argon2id password reauthentication for official signoffs (`workflow_signoff`), `final_form_snapshot` freezing, and final official PDF materialization (`frozen_pdf_document`).
