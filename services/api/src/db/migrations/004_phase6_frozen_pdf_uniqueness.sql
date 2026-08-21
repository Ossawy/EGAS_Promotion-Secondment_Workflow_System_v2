-- Migration 004: Ensure at most one frozen official PDF document per final form snapshot.
CREATE UNIQUE INDEX IF NOT EXISTS frozen_pdf_document_one_per_final_snapshot
  ON frozen_pdf_document (final_form_snapshot_id);
