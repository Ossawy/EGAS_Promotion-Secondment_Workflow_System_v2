-- Enforce hierarchy authorization sources and immutable evidence in PostgreSQL.

CREATE OR REPLACE FUNCTION enforce_active_operational_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effective_to IS NULL AND NOT EXISTS (
    SELECT 1 FROM user_account
     WHERE id=NEW.user_id AND account_type='OPERATIONAL'
  ) THEN
    RAISE EXCEPTION 'active membership requires an OPERATIONAL account' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_unit_membership_operational_guard
BEFORE INSERT OR UPDATE OF user_id,effective_to ON user_unit_membership
FOR EACH ROW EXECUTE FUNCTION enforce_active_operational_membership();

CREATE OR REPLACE FUNCTION enforce_current_unit_manager_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effective_to IS NULL AND NOT EXISTS (
    SELECT 1
      FROM user_account a
      JOIN user_unit_membership m
        ON m.user_id=a.id AND m.unit_id=NEW.unit_id AND m.effective_to IS NULL
      JOIN operational_unit u ON u.id=NEW.unit_id AND u.is_active=TRUE
     WHERE a.id=NEW.manager_user_id
       AND a.account_type='OPERATIONAL'
       AND a.is_active=TRUE
  ) THEN
    RAISE EXCEPTION 'current manager must be an active OPERATIONAL member of the same active unit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER unit_manager_assignment_membership_guard
BEFORE INSERT OR UPDATE OF unit_id,manager_user_id,effective_to ON unit_manager_assignment
FOR EACH ROW EXECUTE FUNCTION enforce_current_unit_manager_membership();

CREATE OR REPLACE FUNCTION reject_immutable_evidence_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and cannot be changed using %', TG_TABLE_NAME, TG_OP
    USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER audit_event_immutable
BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_change();

CREATE TRIGGER security_event_immutable
BEFORE UPDATE OR DELETE ON security_event
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_change();

CREATE TRIGGER stage_action_immutable
BEFORE UPDATE OR DELETE ON stage_action
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_change();

CREATE TRIGGER workflow_note_immutable
BEFORE UPDATE OR DELETE ON workflow_note
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_change();

CREATE TRIGGER stage_submission_snapshot_immutable
BEFORE UPDATE OR DELETE ON stage_submission_snapshot
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_change();

CREATE TRIGGER workflow_signoff_immutable
BEFORE UPDATE OR DELETE ON workflow_signoff
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_change();

CREATE TRIGGER final_form_snapshot_immutable
BEFORE UPDATE OR DELETE ON final_form_snapshot
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_change();

CREATE TRIGGER frozen_pdf_document_immutable
BEFORE UPDATE OR DELETE ON frozen_pdf_document
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_change();

CREATE TRIGGER employee_annual_snapshot_immutable
BEFORE UPDATE OR DELETE ON employee_annual_snapshot
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evidence_change();
