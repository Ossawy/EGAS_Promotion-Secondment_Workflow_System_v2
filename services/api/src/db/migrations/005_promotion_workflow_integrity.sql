-- Promotion decisions are already unique per candidate/iteration in the preserved
-- physical baseline. Add only the missing relationship constraints; decision shape
-- checks remain owned by immutable migration 001 and explicit service validation.

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

SELECT pg_temp.egas_add_fk_if_absent('c__egas_promotiondecision_candidate', 'egas_promotiondecision',
  'FOREIGN KEY (requestCandidate_ID) REFERENCES egas_RequestCandidate(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_promotiondecision_iteration', 'egas_promotiondecision',
  'FOREIGN KEY (iteration_ID) REFERENCES egas_WorkflowIteration(ID) DEFERRABLE INITIALLY DEFERRED');
SELECT pg_temp.egas_add_fk_if_absent('c__egas_promotiondecision_decidedby', 'egas_promotiondecision',
  'FOREIGN KEY (decidedBy_ID) REFERENCES egas_UserAccount(ID) DEFERRABLE INITIALLY DEFERRED');

DROP FUNCTION pg_temp.egas_add_fk_if_absent(text, regclass, text);
