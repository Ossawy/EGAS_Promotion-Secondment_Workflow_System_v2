-- PostgreSQL-only defense-in-depth that is not safely/portably expressed in CDS.
-- CAP CDS remains the structural source of truth. This migration is additive:
-- indexes, CHECK constraints, and append-only/anti-self-delegation triggers only.

CREATE UNIQUE INDEX uq_egas_active_primary_authority_per_unit
  ON egas_ApprovingAuthorityAssignment (routingUnit_ID)
  WHERE isPrimary = TRUE AND isActive = TRUE;

CREATE UNIQUE INDEX uq_egas_selected_secondment_option
  ON egas_SecondmentPositionOption (requestCandidate_ID, iteration_ID)
  WHERE isSelected = TRUE;

CREATE INDEX ix_egas_user_role_active
  ON egas_UserAccountRole (user_ID, isActive, role);
CREATE INDEX ix_egas_auth_session_user_active
  ON egas_AuthSession (user_ID, revokedAt, absoluteExpiresAt);
CREATE INDEX ix_egas_login_attempt_identifier_time
  ON egas_AuthLoginAttempt (identifierFingerprint, createdAt DESC);
CREATE INDEX ix_egas_login_attempt_ip_time
  ON egas_AuthLoginAttempt (ipAddress, createdAt DESC);
CREATE INDEX ix_egas_import_batch_year
  ON egas_ImportBatch (snapshotYear, importedAt DESC);
CREATE INDEX ix_egas_staging_batch_status
  ON egas_EmployeeImportStagingRow (importBatch_ID, validationStatus);
CREATE INDEX ix_egas_snapshot_employee
  ON egas_EmployeeAnnualSnapshot (employee_ID, snapshotYear DESC);
CREATE INDEX ix_egas_snapshot_routing_unit
  ON egas_EmployeeAnnualSnapshot (snapshotYear, routingUnit_ID);
CREATE INDEX ix_egas_snapshot_personnel
  ON egas_EmployeeAnnualSnapshot (personnelNumber, snapshotYear DESC);
CREATE INDEX ix_egas_routing_alias_unit
  ON egas_RoutingUnitSourceAlias (routingUnit_ID, isActive);
CREATE INDEX ix_egas_authority_assignment_user
  ON egas_ApprovingAuthorityAssignment (userAccount_ID, isActive);
CREATE INDEX ix_egas_authority_delegation_active
  ON egas_AuthorityDelegation (authorityAssignment_ID, isActive, validTo);
CREATE INDEX ix_egas_signature_user_active
  ON egas_UserSignatureAsset (user_ID, isActive, uploadedAt DESC);
CREATE INDEX ix_egas_request_unit_status
  ON egas_WorkflowRequest (routingUnit_ID, status, currentStage, createdAt DESC);
CREATE INDEX ix_egas_request_creator
  ON egas_WorkflowRequest (createdBy_ID, createdAt DESC);
CREATE INDEX ix_egas_request_type_year
  ON egas_WorkflowRequest (requestType, cycleYear, createdAt DESC);
CREATE INDEX ix_egas_request_authority
  ON egas_WorkflowRequest (approvingAuthorityAssignment_ID, createdAt DESC);
CREATE INDEX ix_egas_form_section_request
  ON egas_RequestFormSection (request_ID, displayOrder);
CREATE INDEX ix_egas_candidate_request
  ON egas_RequestCandidate (request_ID, displayOrder);
CREATE INDEX ix_egas_candidate_section
  ON egas_RequestCandidate (formSection_ID, displayOrder);
CREATE INDEX ix_egas_candidate_personnel
  ON egas_RequestCandidate (personnelNumberSnapshot);
CREATE INDEX ix_egas_iteration_request
  ON egas_WorkflowIteration (request_ID, iterationNo DESC);
CREATE INDEX ix_egas_task_queue
  ON egas_StageTask (stageCode, taskStatus, assignedUser_ID, openedAt);
CREATE INDEX ix_egas_task_request
  ON egas_StageTask (request_ID, openedAt DESC);
CREATE INDEX ix_egas_received_snapshot_user
  ON egas_StageReceivedSnapshot (recipientUser_ID, receivedAt DESC);
CREATE INDEX ix_egas_received_snapshot_request
  ON egas_StageReceivedSnapshot (request_ID, receivedAt);
CREATE INDEX ix_egas_secondment_option_candidate
  ON egas_SecondmentPositionOption (requestCandidate_ID, iteration_ID, displayOrder);
CREATE INDEX ix_egas_stage_action_request
  ON egas_StageAction (request_ID, createdAt);
CREATE INDEX ix_egas_workflow_note_request
  ON egas_WorkflowNote (request_ID, createdAt);
CREATE INDEX ix_egas_workflow_note_candidate
  ON egas_WorkflowNote (requestCandidate_ID, createdAt)
  WHERE requestCandidate_ID IS NOT NULL;
CREATE INDEX ix_egas_signoff_request_stage
  ON egas_WorkflowSignoff (request_ID, stageCode, signedAt);
CREATE INDEX ix_egas_signoff_user
  ON egas_WorkflowSignoff (signerUser_ID, signedAt DESC);
CREATE INDEX ix_egas_notification_unread
  ON egas_Notification (recipientUser_ID, readAt, createdAt DESC);
CREATE INDEX ix_egas_security_event_type_time
  ON egas_SecurityEvent (eventType, createdAt DESC);
CREATE INDEX ix_egas_security_event_actor_time
  ON egas_SecurityEvent (actorUser_ID, createdAt DESC);
CREATE INDEX ix_egas_audit_request_time
  ON egas_AuditEvent (request_ID, createdAt);
CREATE INDEX ix_egas_audit_unit_time
  ON egas_AuditEvent (routingUnit_ID, createdAt);
CREATE INDEX ix_egas_audit_actor_time
  ON egas_AuditEvent (actorUser_ID, createdAt);
CREATE INDEX ix_egas_pdf_generation_request
  ON egas_PdfGenerationLog (request_ID, generatedAt DESC);

ALTER TABLE egas_UserAccount
  ADD CONSTRAINT ck_egas_user_failed_login_count CHECK (failedLoginCount >= 0);
ALTER TABLE egas_UserAccountRole
  ADD CONSTRAINT ck_egas_user_role CHECK (role IN ('ADMIN','EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
  ADD CONSTRAINT ck_egas_manage_admins_role CHECK (canManageAdmins = FALSE OR role = 'ADMIN'),
  ADD CONSTRAINT ck_egas_no_self_grant CHECK (grantedBy_ID IS NULL OR grantedBy_ID <> user_ID),
  ADD CONSTRAINT ck_egas_no_self_revoke CHECK (revokedBy_ID IS NULL OR revokedBy_ID <> user_ID);
ALTER TABLE egas_AuthSession
  ADD CONSTRAINT ck_egas_session_active_role CHECK (activeRole IS NULL OR activeRole IN ('ADMIN','EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
  ADD CONSTRAINT ck_egas_session_expiry CHECK (idleExpiresAt > createdAt AND absoluteExpiresAt >= idleExpiresAt);
ALTER TABLE egas_ImportBatch
  ADD CONSTRAINT ck_egas_import_status CHECK (status IN ('STAGED','VALIDATED','ACTIVATED','FAILED','SUPERSEDED')),
  ADD CONSTRAINT ck_egas_import_counts CHECK (totalRows >= 0 AND validRows >= 0 AND warningRows >= 0 AND blockedRows >= 0),
  ADD CONSTRAINT ck_egas_import_headers_json CHECK (jsonb_typeof(detectedHeadersJson) = 'array');
ALTER TABLE egas_EmployeeImportStagingRow
  ADD CONSTRAINT ck_egas_staging_status CHECK (validationStatus IN ('PENDING','VALID','WARNING','BLOCKED')),
  ADD CONSTRAINT ck_egas_staging_raw_json CHECK (jsonb_typeof(rawJson) = 'object'),
  ADD CONSTRAINT ck_egas_staging_messages_json CHECK (jsonb_typeof(validationMessagesJson) = 'array');
ALTER TABLE egas_EmployeeAnnualSnapshot
  ADD CONSTRAINT ck_egas_performance_rating CHECK (performanceRating IS NULL OR performanceRating IN ('ممتاز','جيد جدا','جيد'));
ALTER TABLE egas_ApprovingAuthorityAssignment
  ADD CONSTRAINT ck_egas_authority_kind CHECK (authorityKind IN ('DEPUTY','ASSISTANT','ACTING_DEPUTY','ACTING_ASSISTANT','OTHER')),
  ADD CONSTRAINT ck_egas_authority_dates CHECK (validTo IS NULL OR validTo >= validFrom),
  ADD CONSTRAINT ck_egas_authority_no_self_config CHECK (configuredBy_ID IS NULL OR configuredBy_ID <> userAccount_ID);
ALTER TABLE egas_AuthorityDelegation
  ADD CONSTRAINT ck_egas_delegation_dates CHECK (validTo IS NULL OR validTo >= validFrom);
ALTER TABLE egas_UserSignatureAsset
  ADD CONSTRAINT ck_egas_signature_mime CHECK (mimeType IN ('image/png','image/jpeg')),
  ADD CONSTRAINT ck_egas_signature_size CHECK (fileSizeBytes > 0),
  ADD CONSTRAINT ck_egas_signature_width CHECK (widthPx IS NULL OR widthPx > 0),
  ADD CONSTRAINT ck_egas_signature_height CHECK (heightPx IS NULL OR heightPx > 0),
  ADD CONSTRAINT ck_egas_signature_hash CHECK (char_length(fileSha256) = 64);
ALTER TABLE egas_WorkflowRequest
  ADD CONSTRAINT ck_egas_request_type CHECK (requestType IN ('SECONDMENT','PROMOTION')),
  ADD CONSTRAINT ck_egas_request_status CHECK (status IN ('DRAFT','IN_PROGRESS','RETURNED','CANCELLED','COMPLETED')),
  ADD CONSTRAINT ck_egas_form_month CHECK (formMonth BETWEEN 1 AND 12),
  ADD CONSTRAINT ck_egas_form_year CHECK (formYear BETWEEN 2000 AND 2200),
  ADD CONSTRAINT ck_egas_current_iteration CHECK (currentIterationNo >= 1);
ALTER TABLE egas_WorkflowIteration
  ADD CONSTRAINT ck_egas_iteration_number CHECK (iterationNo >= 1),
  ADD CONSTRAINT ck_egas_iteration_status CHECK (status IN ('ACTIVE','RETURNED','CANCELLED','COMPLETED','RECALLED'));
ALTER TABLE egas_StageTask
  ADD CONSTRAINT ck_egas_task_status CHECK (taskStatus IN ('OPEN','CLAIMED','COMPLETED','RETURNED','CANCELLED')),
  ADD CONSTRAINT ck_egas_claimed_role CHECK (claimedRoleSnapshot IS NULL OR claimedRoleSnapshot IN ('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'));
ALTER TABLE egas_StageReceivedSnapshot
  ADD CONSTRAINT ck_egas_received_role CHECK (recipientRoleSnapshot IN ('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
  ADD CONSTRAINT ck_egas_received_json CHECK (jsonb_typeof(snapshotJson) = 'object'),
  ADD CONSTRAINT ck_egas_received_hash CHECK (char_length(snapshotSha256) = 64);
ALTER TABLE egas_PromotionDecision
  ADD CONSTRAINT ck_egas_promotion_decision CHECK (decisionType IN ('SAME_POSITION','OTHER_POSITION')),
  ADD CONSTRAINT ck_egas_other_position_title CHECK (
    (decisionType = 'OTHER_POSITION' AND nullif(btrim(targetJobTitle), '') IS NOT NULL)
    OR (decisionType = 'SAME_POSITION' AND (targetJobTitle IS NULL OR btrim(targetJobTitle) = ''))
  );
ALTER TABLE egas_StageAction
  ADD CONSTRAINT ck_egas_stage_action_role CHECK (actorRoleSnapshot IN ('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
  ADD CONSTRAINT ck_egas_stage_action_json CHECK (jsonb_typeof(payloadJson) = 'object');
ALTER TABLE egas_WorkflowNote
  ADD CONSTRAINT ck_egas_note_role CHECK (authorRoleSnapshot IN ('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
  ADD CONSTRAINT ck_egas_note_message CHECK (char_length(btrim(messageText)) BETWEEN 1 AND 2000),
  ADD CONSTRAINT ck_egas_note_scope CHECK (
    (scopeCode = 'REQUEST' AND requestCandidate_ID IS NULL)
    OR (scopeCode = 'CANDIDATE' AND requestCandidate_ID IS NOT NULL)
  );
ALTER TABLE egas_WorkflowSignoff
  ADD CONSTRAINT ck_egas_signoff_role CHECK (signerRoleSnapshot IN ('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
  ADD CONSTRAINT ck_egas_signoff_hash CHECK (char_length(signatureSha256Snapshot) = 64);
ALTER TABLE egas_SecurityEvent
  ADD CONSTRAINT ck_egas_security_details_json CHECK (jsonb_typeof(detailsJson) = 'object');
ALTER TABLE egas_AuditEvent
  ADD CONSTRAINT ck_egas_audit_metadata_json CHECK (jsonb_typeof(metadataJson) = 'object'),
  ADD CONSTRAINT ck_egas_audit_event_hash CHECK (char_length(eventHash) = 64),
  ADD CONSTRAINT ck_egas_audit_previous_hash CHECK (previousHash IS NULL OR char_length(previousHash) = 64);
ALTER TABLE egas_PdfGenerationLog
  ADD CONSTRAINT ck_egas_document_type CHECK (documentType IN ('FORM','AUDIT_LOG')),
  ADD CONSTRAINT ck_egas_document_state CHECK (documentState IN ('RECEIVED','DRAFT','FINAL')),
  ADD CONSTRAINT ck_egas_period_code CHECK (periodCode IS NULL OR periodCode IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY')),
  ADD CONSTRAINT ck_egas_pdf_hash CHECK (fileSha256 IS NULL OR char_length(fileSha256) = 64);

ALTER TABLE egas_ImportBatch ALTER COLUMN detectedHeadersJson SET DEFAULT '[]'::jsonb;
ALTER TABLE egas_EmployeeImportStagingRow ALTER COLUMN validationMessagesJson SET DEFAULT '[]'::jsonb;
ALTER TABLE egas_StageAction ALTER COLUMN payloadJson SET DEFAULT '{}'::jsonb;
ALTER TABLE egas_SecurityEvent ALTER COLUMN detailsJson SET DEFAULT '{}'::jsonb;
ALTER TABLE egas_AuditEvent ALTER COLUMN metadataJson SET DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION egas_prevent_authority_self_delegation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  primary_user varchar(36);
BEGIN
  SELECT userAccount_ID INTO primary_user
    FROM egas_ApprovingAuthorityAssignment
    WHERE ID = NEW.authorityAssignment_ID;
  IF primary_user IS NULL THEN
    RAISE EXCEPTION 'Unknown authority assignment';
  END IF;
  IF NEW.delegatedUser_ID = primary_user THEN
    RAISE EXCEPTION 'An approving authority cannot be delegated to itself';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_egas_prevent_authority_self_delegation
  BEFORE INSERT OR UPDATE OF authorityAssignment_ID, delegatedUser_ID
  ON egas_AuthorityDelegation
  FOR EACH ROW EXECUTE FUNCTION egas_prevent_authority_self_delegation();

CREATE OR REPLACE FUNCTION egas_reject_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_egas_audit_event_append_only
  BEFORE UPDATE OR DELETE ON egas_AuditEvent
  FOR EACH ROW EXECUTE FUNCTION egas_reject_append_only_mutation();
CREATE TRIGGER trg_egas_workflow_note_append_only
  BEFORE UPDATE OR DELETE ON egas_WorkflowNote
  FOR EACH ROW EXECUTE FUNCTION egas_reject_append_only_mutation();
CREATE TRIGGER trg_egas_received_snapshot_append_only
  BEFORE UPDATE OR DELETE ON egas_StageReceivedSnapshot
  FOR EACH ROW EXECUTE FUNCTION egas_reject_append_only_mutation();
CREATE TRIGGER trg_egas_stage_action_append_only
  BEFORE UPDATE OR DELETE ON egas_StageAction
  FOR EACH ROW EXECUTE FUNCTION egas_reject_append_only_mutation();
CREATE TRIGGER trg_egas_workflow_signoff_append_only
  BEFORE UPDATE OR DELETE ON egas_WorkflowSignoff
  FOR EACH ROW EXECUTE FUNCTION egas_reject_append_only_mutation();
