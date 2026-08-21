# EGAS v5 Phase 5 — Secondment Workflow Domain Logic and API

## 1. Overview

Phase 5 implements the domain logic, workflow lifecycle, and API surface for **Secondment Requests** (`S1` through `S5`), completing the promotion/secondment workflow core in EGAS v5.

The implementation builds on the Phase 3 generic workflow engine and the clean v5 physical schema without adding ad-hoc migrations or weakening authorization and data invariants.

---

## 2. Business Flow & Responsibilities

### 2.1 Workflow Sequence

```text
S1 HR (Signing stage - Phase 6 boundary)
  -> S2 ORG (Signing stage - Phase 6 boundary, ORG enters proposed position options)
    -> S3 AUTH (Signing stage - Phase 6 boundary, AUTH selects 1 option per candidate)
      -> S4 ORG (Confirmation only, freezes secondmentSelections evidence, advances to S5)
        -> S5 HR (Final review)
```

### 2.2 Stage Responsibilities

1. **`S1` HR (Preparation & Initial Submission)**:
   - HR manager creates the Secondment request and adds candidates from the active annual snapshot.
   - HR manager is the official signer (formal signature deferred to Phase 6).

2. **`S2` ORG (Proposed Position Options Entry)**:
   - Organization prepares one or more proposed positions per candidate.
   - Position options include:
     - `positionTitle`: Job title of the proposed position (required, max 240 chars).
     - `organizationalDependency`: Organizational unit / department within the same routing unit (required, max 240 chars).
     - `qualificationStatus`: Qualification status code referring to an active approved row in `qualification_status_reference`.
     - `displayOrder`: Server-controlled integer scoped to candidate + S2 execution.
   - ORG manager is the official signer.

3. **`S3` AUTH (Approving Authority Selection)**:
   - An actively assigned subordinate AUTH employee or the current AUTH manager reviews S2 options.
   - AUTH selects **exactly one** valid S2 Organization-proposed option per candidate.
   - Scoped to `secondment_decision` with stable row identity for `(stage_execution_id, candidate_id)`.
   - Current active AUTH manager is the official signer.

4. **`S4` ORG (Organization Confirmation)**:
   - Organization reviews and confirms the AUTH selection.
   - S4 is a confirmation stage only; Organization **cannot** mutate or replace the signed AUTH selections.
   - S4 has **no second ORG signature signoff**.
   - S4 Stage Actions:
     - **Confirm & Advance (`approveAndAdvance`)**: Freezes authoritative S3 selections into `stage_submission_snapshot.secondmentSelections` and opens `S5`.
     - **Return Previous (`returnPreviousStage`)**: Returns to AUTH by opening a fresh `S3` execution (`execution_no = 2`).
     - **Reject (`rejectStage`)**: Closes iteration with status `REJECTED_PENDING_HR_DECISION` for HR manager recovery.

5. **`S5` HR (Final Review)**:
   - HR conducts final review before final form snapshot and PDF generation (Phase 6).
   - No new HR signature.

---

## 3. Structural Routing Safety & Department Data Gap

### 3.1 Structural Same-Routing Guarantee
In v5, `secondment_position_option` contains no `target_routing_unit_id` column. Position options and selections remain strictly within the request's routing context (`routing_unit_id`). The API uses `exactObject` schema validation to strictly reject any client-supplied `targetRoutingUnitId` or `targetDepartmentId`.

### 3.2 Department / General-Administration Data Gap
The annual XLSX source (`بيانات IT.XLSX`) provides `النيابة / المساعد` (`routing_unit`) but does not expose an explicit general-administration or department hierarchy.
- The system enforces same-routing structurally by binding options to candidates inside the request.
- `organizationalDependency` is treated as business display/evidence data, **not** as an inferred authorization or routing selector.
- The system does not invent artificial departments or infer them from employee groups or text labels.

---

## 4. Qualification Status Reference Lifecycle

1. **S2 Authoring & Readiness**:
   - When adding or updating an option at S2, `qualificationStatus` must match an active code in `qualification_status_reference`.
   - `validateSecondmentS2ForSignoff` verifies that all options map to active approved reference codes.
   - No business enums (e.g. `QUALIFIED`/`NOT_QUALIFIED`) are hardcoded in application logic.

2. **Accepted Evidence Immutability**:
   - Once an S2 execution is accepted and completed, subsequent deactivation or modification of a reference code in the reference table **does not** invalidate historical options.
   - S3 selection and S4 confirmation validate against the stored option and accepted execution chain. Historical rows are never rewritten due to reference table changes.

---

## 5. Execution Scope, Immutability, and Return Behavior

1. **StageExecution Scoping**:
   - Each `secondment_position_option` row is linked via `source_stage_execution_id`.
   - Each `secondment_decision` row is linked via `UNIQUE(stage_execution_id, candidate_id)`.
   - Repeated selection changes during the active S3 stage update the existing decision row, preserving the stable primary key `id`.

2. **Authoritative Resolvers**:
   - **Position Options**:
     - At `S2`: Options tied to the current `OPEN` S2 execution.
     - At `S3`, `S4`, `S5`, or `COMPLETED`: Options tied to the latest `COMPLETED` S2 execution in the active `WorkflowIteration`.
     - At `S1`: Returns `[]`.
   - **Selections**:
     - At `S3`: Selections tied to the current `OPEN` S3 execution.
     - At `S4`, `S5`, or `COMPLETED`: Selections tied to the latest `COMPLETED` S3 execution in the active `WorkflowIteration`.
     - Prior stages: Returns `[]`.

3. **Behavior After Returns**:
   - **Return `S3` $\rightarrow$ `S2`**:
     - Closes S3 with `status = 'RETURNED'`.
     - Opens a fresh S2 execution (`execution_no = 2`).
     - Previous S2 options and S3 selections remain historical evidence and are not mutated.
     - The newly opened S2 authors fresh position options.
   - **Return `S4` $\rightarrow$ `S3`**:
     - Closes S4 with `status = 'RETURNED'`.
     - Opens a fresh S3 execution (`execution_no = 2`).
     - The new S3 selects from the still-authoritative completed S2 option set.

---

## 6. Signature Boundary & Phase 6 Helpers

- Stages `S1`, `S2`, and `S3` are formal signing stages in accordance with v5.2 requirements.
- Generic `approveAndAdvance` rejects `S1`, `S2`, and `S3` with `SIGNATURE_REQUIRED`.
- Two transaction-safe readiness helpers are implemented for Phase 6 single-transaction sign-and-advance:
  - `SecondmentWorkflowService.validateSecondmentS2ForSignoff(...)`: Validates that every candidate has at least one valid position option with active qualification references.
  - `SecondmentWorkflowService.validateSecondmentS3ForSignoff(...)`: Validates that every candidate has exactly one valid selection linked to the authoritative completed S2 options.

---

## 7. API Endpoints

### 7.1 Read Options & Selections
- **`GET /api/workflow/requests/:requestId/secondment/options`**
  - **Auth**: `OPERATIONAL` participant user.
  - **Returns**: Array of `SecondmentPositionOptionSummary` DTOs with `qualificationStatusName` resolved.

- **`GET /api/workflow/requests/:requestId/secondment/selections`**
  - **Auth**: `OPERATIONAL` participant user.
  - **Returns**: Array of `SecondmentSelectionSummary` DTOs.

### 7.2 S2 Position Options Commands
- **`POST /api/workflow/stages/:stageExecutionId/secondment/candidates/:candidateId/options`**
  - **Auth**: Responsible ORG unit manager OR active assignee on S2 (in work states `ASSIGNED`, `IN_PROGRESS`, `CORRECTION_REQUIRED`).
  - **Body**: `{ "positionTitle": string, "organizationalDependency": string, "qualificationStatus": string }`
  - **Behavior**: Appends option with server-assigned `display_order`.

- **`PUT /api/workflow/stages/:stageExecutionId/secondment/options/:optionId`**
  - **Auth**: Responsible ORG unit manager OR active assignee on S2.
  - **Body**: `{ "positionTitle": string, "organizationalDependency": string, "qualificationStatus": string }`
  - **Behavior**: Updates business fields, preserving `id` and `display_order`.

- **`DELETE /api/workflow/stages/:stageExecutionId/secondment/options/:optionId`**
  - **Auth**: Responsible ORG unit manager OR active assignee on S2.
  - **Behavior**: Deletes option from the current OPEN S2 execution.

### 7.3 S3 Selection Command
- **`PUT /api/workflow/stages/:stageExecutionId/secondment/candidates/:candidateId/selection`**
  - **Auth**: Responsible AUTH unit manager OR active assignee on S3.
  - **Body**: `{ "selectedOptionId": string }`
  - **Behavior**: Upserts `secondment_decision` with stable row identity.
