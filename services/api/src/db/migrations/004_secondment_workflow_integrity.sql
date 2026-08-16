-- Secondment execution uses the preserved physical tables. Draft position rows may
-- be incomplete only while editing; service transitions validate completeness.
-- These database rules protect selection/task concurrency and relationship integrity.

ALTER TABLE egas_SecondmentPositionOption
  ADD CONSTRAINT ck_egas_secondment_position_selection CHECK (
    (isSelected=FALSE AND selectedBy_ID IS NULL AND selectedAt IS NULL)
    OR (isSelected=TRUE AND selectedBy_ID IS NOT NULL AND selectedAt IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_egas_secondment_selected_candidate_iteration
  ON egas_SecondmentPositionOption (requestCandidate_ID, iteration_ID)
  WHERE isSelected=TRUE;

CREATE UNIQUE INDEX uq_egas_stage_task_iteration_stage
  ON egas_StageTask (iteration_ID, stageCode);

CREATE FUNCTION pg_temp.egas_add_fk_if_absent(
  constraint_name text,
  target_table regclass,
  definition text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid=target_table AND conname=constraint_name AND contype='f'
  ) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', target_table, constraint_name, definition);
  END IF;
END;
$$;

SELECT pg_temp.egas_add_fk_if_absent('c__egas_secondmentpositionoption_candidate', 'egas_secondmentpositionoption',
  'FOREIGN KEY (requestCandidate_ID) REFERENCES egas_RequestCandidate(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_secondmentpositionoption_iteration', 'egas_secondmentpositionoption',
  'FOREIGN KEY (iteration_ID) REFERENCES egas_WorkflowIteration(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_secondmentpositionoption_qualificationstatus', 'egas_secondmentpositionoption',
  'FOREIGN KEY (qualificationStatus_code) REFERENCES egas_QualificationStatusReference(code) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_secondmentpositionoption_enteredby', 'egas_secondmentpositionoption',
  'FOREIGN KEY (enteredBy_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_secondmentpositionoption_selectedby', 'egas_secondmentpositionoption',
  'FOREIGN KEY (selectedBy_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');

DROP FUNCTION pg_temp.egas_add_fk_if_absent(text, regclass, text);
