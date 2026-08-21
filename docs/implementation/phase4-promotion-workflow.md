# EGAS v5 Phase 4 — Promotion Decisions and Conditional P4O Workflow

## 1. Overview

Phase 4 implements the domain logic and API for Promotion candidate decisions at stage `P4` (Authority / Approving Unit), together with conditional organizational placement confirmation (`P4O`) and deterministic destination routing (`P4O` vs `P5`).

The implementation builds on top of the generic Phase 3 workflow engine, utilizing the v5 physical schema without adding ad-hoc migrations or weakening authorization and data invariants.

---

## 2. Business Flow & Decisions Model

### 2.1 Workflow Stages

```text
P1 HR (signs)
  -> P2 ORG (signs)
    -> P3 HR (review only)
      -> P4 AUTH (signs)
           -> P5 HR            [if ALL candidates are SAME_POSITION]
           -> P4O ORG          [if ANY candidate is OTHER_POSITION]
                -> P5 HR
```

### 2.2 Decision Types

1. **`SAME_POSITION`**:
   - The candidate remains on their frozen current position.
   - `targetJobTitle` is persisted as `NULL`. Supplying a non-empty `targetJobTitle` is rejected (fail-closed).
   - `effectiveNominatedJob` resolves to the frozen `currentJobTitle` from the candidate's active annual snapshot.

2. **`OTHER_POSITION`**:
   - The candidate moves to a different target job.
   - `targetJobTitle` is mandatory (trimmed, non-empty, max 240 chars).
   - `targetJobTitle` must strictly differ from the candidate's current frozen job title.
   - The target position remains strictly within the same request routing context (`routing_unit_id`). Cross-routing is prohibited.
   - `effectiveNominatedJob` resolves to `targetJobTitle`.

3. **`recommendation`**:
   - AUTH-controlled candidate field.
   - Non-empty, trimmed bounded text (1–80 chars, e.g. `ترشيح`, `تأجيل`).
   - Required for a complete P4 decision.

4. **`notes`**:
   - Optional candidate-level business notes (max 4000 chars) stored in `promotion_decision.notes`, kept distinct from generic `workflow_note`.

---

## 3. Structural Routing Safety & Data Invariants

### 3.1 No `targetRoutingUnitId` (Same-Routing Guarantee)
In v5, `promotion_decision` contains no `target_routing_unit_id` column and the API strictly rejects any `targetRoutingUnitId` parameter via schema validation (`exactObject`). Decisions remain strictly inside the request's routing context.

### 3.2 Department / General-Administration Data Gap
The annual XLSX source (`بيانات IT.XLSX`) provides `النيابة / المساعد` (`routing_unit`) but does not expose an explicit general-administration or department hierarchy.
- The system enforces same-routing structurally by keeping decisions inside the request's `routing_unit_id`.
- The system **does not** invent fake departments or infer them from employee groups or text labels.

---

## 4. Execution Scope & Immutability

1. **StageExecution Scoping**:
   - Each `promotion_decision` row is linked via `UNIQUE(stage_execution_id, candidate_id)`.
   - Repeated edits on the active P4 stage execution update the decision row for that specific execution only.
2. **Historical Retention**:
   - If a request is returned from `P4` to `P3`, previous `P4` decisions remain historical evidence and are locked against further edits.
   - When `P3` later advances to a new `P4` execution (`execution_no = 2`), a fresh execution is created and decisions are entered cleanly. Historical rows are never overwritten.
3. **Authoritative Decision Resolution**:
   - At stage `P4`: the decisions linked to the current `OPEN` `P4` execution are authoritative.
   - At stage `P4O` / `P5` / `COMPLETED`: the decisions linked to the latest `COMPLETED` `P4` execution in the active `WorkflowIteration` are authoritative.
   - At stages prior to `P4` (or after return to `P1`/`P2`/`P3`): prior P4 decisions are historical evidence only.

---

## 5. Conditional P4O Organization Confirmation

1. **Trigger Condition**:
   - If **all** candidates have `SAME_POSITION` $\rightarrow$ advances directly to `P5` (HR).
   - If **any** candidate has `OTHER_POSITION` $\rightarrow$ advances to `P4O` (ORG) for the entire request.
2. **Confirmation Scope**:
   - `P4O` is an Organization confirmation stage only.
   - Organization users cannot mutate, replace, or delete the signed `P4` AUTH decisions.
   - `P4O` does not generate a second ORG signature signoff.
3. **P4O Stage Actions**:
   - **Confirm & Advance (`approveAndAdvance`)**: Validates that authoritative P4 decisions exist and at least one is `OTHER_POSITION`, freezes authoritative decisions into `stage_submission_snapshot.promotionDecisions`, and opens `P5`.
   - **Return Previous (`returnPreviousStage`)**: Returns to the previous manager by opening a fresh `P4` execution in the same iteration.
   - **Reject (`rejectStage`)**: Sets request status to `REJECTED_PENDING_HR_DECISION` for HR manager recovery (restart or cancel).
4. **Invalid P4O Prevention**:
   - If a synthetic or orphan `P4O` execution lacks any `OTHER_POSITION` candidate decisions, `approveAndAdvance` fails closed (`P4O_CONFIRMATION_INVALID`).

---

## 6. Signature Boundary (Phase 6 Hand-off)

- Promotion stages `P1`, `P2`, and `P4` remain formal signing stages in accordance with v5.2 requirements.
- Generic `approveAndAdvance` at `P4` continues to fail with `SIGNATURE_REQUIRED`.
- `PromotionWorkflowService.validatePromotionP4AndResolveDestination(...)` provides an atomic, transaction-safe validation and destination resolver intended to be invoked by the Phase 6 atomic "sign + advance" operation.

---

## 7. API Endpoints

### 7.1 Read Authoritative Decisions
- **`GET /api/workflow/requests/:requestId/promotion/decisions`**
  - **Auth**: `OPERATIONAL` user participating in the request.
  - **Returns**: Array of `PromotionDecisionSummary` DTOs with `effectiveNominatedJob` calculated.

### 7.2 Save Candidate Decision
- **`PUT /api/workflow/stages/:stageExecutionId/promotion/candidates/:candidateId/decision`**
  - **Auth**: Current manager of the responsible `AUTH` operational unit OR the active assignee on this `P4` stage execution (in work states `ASSIGNED`, `IN_PROGRESS`, `CORRECTION_REQUIRED`).
  - **Body**:
    ```json
    {
      "decisionType": "SAME_POSITION" | "OTHER_POSITION",
      "targetJobTitle": "string (optional for SAME, required for OTHER)",
      "recommendation": "string (required, 1-80 chars)",
      "notes": "string (optional, max 4000 chars)"
    }
    ```
  - **Validation**: Enforces strict schema via `exactObject` (rejects `targetRoutingUnitId` or any unexpected field).
