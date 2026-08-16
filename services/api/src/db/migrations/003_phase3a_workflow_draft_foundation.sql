-- Phase 3A permits a request shell before the first annual-snapshot candidate
-- establishes routing and before Employee Affairs selects an authority. Candidate
-- removal is soft so append-only notes/audit history never lose their subject.

ALTER TABLE egas_WorkflowRequest
  ALTER COLUMN routingUnit_ID DROP NOT NULL,
  ALTER COLUMN approvingAuthorityAssignment_ID DROP NOT NULL,
  ALTER COLUMN approvingAuthorityPersonnelSnapshot DROP NOT NULL,
  ALTER COLUMN approvingAuthorityNameSnapshot DROP NOT NULL,
  ALTER COLUMN approvingAuthorityJobTitleSnapshot DROP NOT NULL,
  ALTER COLUMN approvingAuthorityKindSnapshot DROP NOT NULL;

ALTER TABLE egas_RequestCandidate
  ALTER COLUMN formSection_ID DROP NOT NULL,
  ADD COLUMN removedAt TIMESTAMP,
  ADD COLUMN removedBy_ID VARCHAR(36);

ALTER TABLE egas_RequestCandidate
  DROP CONSTRAINT egas_RequestCandidate_requestSnapshot;

CREATE UNIQUE INDEX uq_egas_active_candidate_request_snapshot
  ON egas_RequestCandidate (request_ID, employeeSnapshot_ID)
  WHERE removedAt IS NULL;

CREATE INDEX ix_egas_candidate_request_active
  ON egas_RequestCandidate (request_ID, displayOrder)
  WHERE removedAt IS NULL;

ALTER TABLE egas_RequestCandidate
  ADD CONSTRAINT ck_egas_candidate_removal CHECK (
    (removedAt IS NULL AND removedBy_ID IS NULL)
    OR (removedAt IS NOT NULL AND removedBy_ID IS NOT NULL)
  );

ALTER TABLE egas_WorkflowRequest
  ADD CONSTRAINT ck_egas_request_authority_snapshot CHECK (
    (
      approvingAuthorityAssignment_ID IS NULL
      AND approvingAuthorityPersonnelSnapshot IS NULL
      AND approvingAuthorityNameSnapshot IS NULL
      AND approvingAuthorityJobTitleSnapshot IS NULL
      AND approvingAuthorityKindSnapshot IS NULL
    )
    OR (
      approvingAuthorityAssignment_ID IS NOT NULL
      AND approvingAuthorityPersonnelSnapshot IS NOT NULL
      AND approvingAuthorityNameSnapshot IS NOT NULL
      AND approvingAuthorityJobTitleSnapshot IS NOT NULL
      AND approvingAuthorityKindSnapshot IS NOT NULL
    )
  );

ALTER TABLE egas_WorkflowRequest
  ADD CONSTRAINT ck_egas_request_cycle_year CHECK (cycleYear BETWEEN 2000 AND 2200),
  ADD CONSTRAINT ck_egas_request_current_stage CHECK (
    currentStage IS NULL OR currentStage IN ('P1','P2','P3','P4','P5','S1','S2','S3','S4','S5')
  );

ALTER TABLE egas_StageTask
  ADD CONSTRAINT ck_egas_stage_code CHECK (
    stageCode IN ('P1','P2','P3','P4','P5','S1','S2','S3','S4','S5')
  );

-- Phase 3A fresh-install foreign keys. Existing upgraded databases already have
-- the CAP-created constraints with these names; the helper therefore leaves them
-- untouched and only fills the preserved SQL baseline's missing references.
CREATE FUNCTION pg_temp.egas_add_fk_if_absent(
  constraint_name text,
  target_table regclass,
  definition text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = target_table AND conname = constraint_name AND contype = 'f'
  ) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', target_table, constraint_name, definition);
  END IF;
END;
$$;

SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflowrequest_createdby', 'egas_workflowrequest',
  'FOREIGN KEY (createdBy_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflowrequest_routingunit', 'egas_workflowrequest',
  'FOREIGN KEY (routingUnit_ID) REFERENCES egas_RoutingUnit(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflowrequest_approvingauthorityassignment', 'egas_workflowrequest',
  'FOREIGN KEY (approvingAuthorityAssignment_ID) REFERENCES egas_ApprovingAuthorityAssignment(ID) DEFERRABLE INITIALLY DEFERRED');

SELECT pg_temp.egas_add_fk_if_absent('c__egas_requestformsection_request', 'egas_requestformsection',
  'FOREIGN KEY (request_ID) REFERENCES egas_WorkflowRequest(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_requestformsection_jobcategory', 'egas_requestformsection',
  'FOREIGN KEY (jobCategory_code) REFERENCES egas_JobCategoryReference(code) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_requestformsection_createdby', 'egas_requestformsection',
  'FOREIGN KEY (createdBy_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');

SELECT pg_temp.egas_add_fk_if_absent('c__egas_requestcandidate_request', 'egas_requestcandidate',
  'FOREIGN KEY (request_ID) REFERENCES egas_WorkflowRequest(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_requestcandidate_formsection', 'egas_requestcandidate',
  'FOREIGN KEY (formSection_ID) REFERENCES egas_RequestFormSection(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_requestcandidate_employeesnapshot', 'egas_requestcandidate',
  'FOREIGN KEY (employeeSnapshot_ID) REFERENCES egas_EmployeeAnnualSnapshot(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_requestcandidate_performancewarningacknowledgedby', 'egas_requestcandidate',
  'FOREIGN KEY (performanceWarningAcknowledgedBy_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_requestcandidate_removedby', 'egas_requestcandidate',
  'FOREIGN KEY (removedBy_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');

SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflowiteration_request', 'egas_workflowiteration',
  'FOREIGN KEY (request_ID) REFERENCES egas_WorkflowRequest(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflowiteration_startedby', 'egas_workflowiteration',
  'FOREIGN KEY (startedBy_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflowiteration_parentiteration', 'egas_workflowiteration',
  'FOREIGN KEY (parentIteration_ID) REFERENCES egas_WorkflowIteration(ID) DEFERRABLE INITIALLY DEFERRED');

SELECT pg_temp.egas_add_fk_if_absent('c__egas_stagetask_iteration', 'egas_stagetask',
  'FOREIGN KEY (iteration_ID) REFERENCES egas_WorkflowIteration(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_stagetask_request', 'egas_stagetask',
  'FOREIGN KEY (request_ID) REFERENCES egas_WorkflowRequest(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_stagetask_assigneduser', 'egas_stagetask',
  'FOREIGN KEY (assignedUser_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');

SELECT pg_temp.egas_add_fk_if_absent('c__egas_stageaction_request', 'egas_stageaction',
  'FOREIGN KEY (request_ID) REFERENCES egas_WorkflowRequest(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_stageaction_iteration', 'egas_stageaction',
  'FOREIGN KEY (iteration_ID) REFERENCES egas_WorkflowIteration(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_stageaction_stagetask', 'egas_stageaction',
  'FOREIGN KEY (stageTask_ID) REFERENCES egas_StageTask(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_stageaction_requestcandidate', 'egas_stageaction',
  'FOREIGN KEY (requestCandidate_ID) REFERENCES egas_RequestCandidate(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_stageaction_actoruser', 'egas_stageaction',
  'FOREIGN KEY (actorUser_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');

SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflownote_request', 'egas_workflownote',
  'FOREIGN KEY (request_ID) REFERENCES egas_WorkflowRequest(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflownote_iteration', 'egas_workflownote',
  'FOREIGN KEY (iteration_ID) REFERENCES egas_WorkflowIteration(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflownote_stagetask', 'egas_workflownote',
  'FOREIGN KEY (stageTask_ID) REFERENCES egas_StageTask(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflownote_requestcandidate', 'egas_workflownote',
  'FOREIGN KEY (requestCandidate_ID) REFERENCES egas_RequestCandidate(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_workflownote_authoruser', 'egas_workflownote',
  'FOREIGN KEY (authorUser_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');

SELECT pg_temp.egas_add_fk_if_absent('c__egas_notification_recipientuser', 'egas_notification',
  'FOREIGN KEY (recipientUser_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_notification_request', 'egas_notification',
  'FOREIGN KEY (request_ID) REFERENCES egas_WorkflowRequest(ID) DEFERRABLE INITIALLY DEFERRED');

SELECT pg_temp.egas_add_fk_if_absent('c__egas_auditevent_request', 'egas_auditevent',
  'FOREIGN KEY (request_ID) REFERENCES egas_WorkflowRequest(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_auditevent_iteration', 'egas_auditevent',
  'FOREIGN KEY (iteration_ID) REFERENCES egas_WorkflowIteration(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_auditevent_requestcandidate', 'egas_auditevent',
  'FOREIGN KEY (requestCandidate_ID) REFERENCES egas_RequestCandidate(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_auditevent_actoruser', 'egas_auditevent',
  'FOREIGN KEY (actorUser_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_auditevent_routingunit', 'egas_auditevent',
  'FOREIGN KEY (routingUnit_ID) REFERENCES egas_RoutingUnit(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_auditevent_approvingauthorityassignment', 'egas_auditevent',
  'FOREIGN KEY (approvingAuthorityAssignment_ID) REFERENCES egas_ApprovingAuthorityAssignment(ID) DEFERRABLE INITIALLY DEFERRED');

DROP FUNCTION pg_temp.egas_add_fk_if_absent(text, regclass, text);
