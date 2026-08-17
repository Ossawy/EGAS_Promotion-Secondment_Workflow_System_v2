-- Promotion cross-routing-unit review support.
-- Historical rows remain valid because the new target routing field is nullable.

ALTER TABLE egas_promotiondecision
  ADD COLUMN targetroutingunit_id VARCHAR(36);

ALTER TABLE egas_promotiondecision
  ADD CONSTRAINT c__egas_promotiondecision_target_routing
  FOREIGN KEY (targetroutingunit_id)
  REFERENCES egas_routingunit(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX ix_egas_promotiondecision_target_routing
  ON egas_promotiondecision (targetroutingunit_id)
  WHERE targetroutingunit_id IS NOT NULL;

ALTER TABLE egas_promotiondecision
  ADD CONSTRAINT ck_egas_same_position_target_routing CHECK (
    decisiontype <> 'SAME_POSITION' OR targetroutingunit_id IS NULL
  );

-- Update stage constraints to allow P4O
ALTER TABLE egas_WorkflowRequest
  DROP CONSTRAINT ck_egas_request_current_stage;

ALTER TABLE egas_WorkflowRequest
  ADD CONSTRAINT ck_egas_request_current_stage CHECK (
    currentStage IS NULL OR currentStage IN (
      'P1','P2','P3','P4','P4O','P5',
      'S1','S2','S3','S4','S5'
    )
  );

ALTER TABLE egas_StageTask
  DROP CONSTRAINT ck_egas_stage_code;

ALTER TABLE egas_StageTask
  ADD CONSTRAINT ck_egas_stage_code CHECK (
    stageCode IN (
      'P1','P2','P3','P4','P4O','P5',
      'S1','S2','S3','S4','S5'
    )
  );
