-- Phase 2B annual-data invariants that are not present in the frozen baseline.
-- Import staging and activation remain application-controlled; these guards
-- prevent two active full snapshots for one year and historical snapshot edits.

CREATE UNIQUE INDEX uq_egas_activated_import_batch_per_year
  ON egas_ImportBatch (snapshotYear)
  WHERE status = 'ACTIVATED';

CREATE TRIGGER trg_egas_employee_annual_snapshot_append_only
  BEFORE UPDATE OR DELETE ON egas_EmployeeAnnualSnapshot
  FOR EACH ROW EXECUTE FUNCTION egas_reject_append_only_mutation();
