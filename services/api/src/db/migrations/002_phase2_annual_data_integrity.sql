-- Phase 2: Annual employee data integrity
-- Ensure at most one ACTIVATED import batch per snapshot_year at the PostgreSQL database level.
CREATE UNIQUE INDEX IF NOT EXISTS import_batch_one_activated_per_year
  ON import_batch(snapshot_year)
  WHERE status = 'ACTIVATED';
