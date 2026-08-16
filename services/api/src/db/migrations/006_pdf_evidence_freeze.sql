-- M9: immutable source snapshots and one-time materialized PDF evidence.
-- Existing stage-received snapshots remain the authority for what an actor received.
-- This table freezes the final approved JSON at approval time and stores a server-only
-- identity/hash for RECEIVED and FINAL PDFs after their first on-demand rendering.

CREATE TABLE egas_FrozenPdfDocument (
  ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36) NOT NULL,
  iteration_ID VARCHAR(36) NOT NULL,
  documentState VARCHAR(20) NOT NULL,
  stageReceivedSnapshot_ID VARCHAR(36),
  snapshotJson JSONB NOT NULL,
  snapshotSha256 VARCHAR(64) NOT NULL,
  storageKey VARCHAR(500),
  fileSha256 VARCHAR(64),
  fileSizeBytes BIGINT,
  templateVersion VARCHAR(120) NOT NULL,
  frozenAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  materializedAt TIMESTAMP,
  PRIMARY KEY (ID),
  CONSTRAINT ck_egas_frozen_pdf_state CHECK (documentState IN ('RECEIVED','FINAL')),
  CONSTRAINT ck_egas_frozen_pdf_json CHECK (jsonb_typeof(snapshotJson) = 'object'),
  CONSTRAINT ck_egas_frozen_pdf_snapshot_hash CHECK (char_length(snapshotSha256) = 64),
  CONSTRAINT ck_egas_frozen_pdf_file_hash CHECK (fileSha256 IS NULL OR char_length(fileSha256) = 64),
  CONSTRAINT ck_egas_frozen_pdf_materialization CHECK (
    (storageKey IS NULL AND fileSha256 IS NULL AND fileSizeBytes IS NULL AND materializedAt IS NULL)
    OR
    (storageKey IS NOT NULL AND fileSha256 IS NOT NULL AND fileSizeBytes > 0 AND materializedAt IS NOT NULL)
  ),
  CONSTRAINT ck_egas_frozen_pdf_received_source CHECK (
    (documentState = 'RECEIVED' AND stageReceivedSnapshot_ID IS NOT NULL)
    OR (documentState = 'FINAL' AND stageReceivedSnapshot_ID IS NULL)
  ),
  CONSTRAINT c__egas_frozenpdf_request FOREIGN KEY (request_ID) REFERENCES egas_WorkflowRequest(ID) ON DELETE RESTRICT,
  CONSTRAINT c__egas_frozenpdf_iteration FOREIGN KEY (iteration_ID) REFERENCES egas_WorkflowIteration(ID) ON DELETE RESTRICT,
  CONSTRAINT c__egas_frozenpdf_received FOREIGN KEY (stageReceivedSnapshot_ID) REFERENCES egas_StageReceivedSnapshot(ID) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_egas_frozen_received_pdf
  ON egas_FrozenPdfDocument (stageReceivedSnapshot_ID)
  WHERE documentState = 'RECEIVED';
CREATE UNIQUE INDEX uq_egas_frozen_final_pdf
  ON egas_FrozenPdfDocument (request_ID, iteration_ID)
  WHERE documentState = 'FINAL';
CREATE UNIQUE INDEX uq_egas_frozen_pdf_storage_key
  ON egas_FrozenPdfDocument (storageKey)
  WHERE storageKey IS NOT NULL;
CREATE INDEX ix_egas_frozen_pdf_request
  ON egas_FrozenPdfDocument (request_ID, frozenAt DESC);

CREATE OR REPLACE FUNCTION egas_protect_frozen_pdf_document()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ID <> OLD.ID
     OR NEW.request_ID <> OLD.request_ID
     OR NEW.iteration_ID <> OLD.iteration_ID
     OR NEW.documentState <> OLD.documentState
     OR NEW.stageReceivedSnapshot_ID IS DISTINCT FROM OLD.stageReceivedSnapshot_ID
     OR NEW.snapshotJson <> OLD.snapshotJson
     OR NEW.snapshotSha256 <> OLD.snapshotSha256
     OR NEW.templateVersion <> OLD.templateVersion
     OR NEW.frozenAt <> OLD.frozenAt THEN
    RAISE EXCEPTION 'Frozen PDF source evidence is immutable';
  END IF;
  IF OLD.storageKey IS NOT NULL AND (
       NEW.storageKey IS DISTINCT FROM OLD.storageKey
       OR NEW.fileSha256 IS DISTINCT FROM OLD.fileSha256
       OR NEW.fileSizeBytes IS DISTINCT FROM OLD.fileSizeBytes
       OR NEW.materializedAt IS DISTINCT FROM OLD.materializedAt) THEN
    RAISE EXCEPTION 'Materialized PDF evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_egas_frozen_pdf_document_protect
  BEFORE UPDATE ON egas_FrozenPdfDocument
  FOR EACH ROW EXECUTE FUNCTION egas_protect_frozen_pdf_document();

CREATE TRIGGER trg_egas_frozen_pdf_document_no_delete
  BEFORE DELETE ON egas_FrozenPdfDocument
  FOR EACH ROW EXECUTE FUNCTION egas_reject_append_only_mutation();
