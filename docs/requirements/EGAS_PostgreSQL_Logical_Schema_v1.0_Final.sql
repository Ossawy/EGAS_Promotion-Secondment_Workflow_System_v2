-- EGAS Promotion & Secondment Workflow System
-- PostgreSQL Logical Schema v1.0 FINAL
-- Frozen pre-implementation logical baseline aligned with Requirements & Architecture v2.0 (2026-08-15)
-- Incorporates resolved v1.8 review findings and final stakeholder confirmations: multi-role accounts,
-- immutable stage-received PDF snapshots, append-only workflow notes, mandatory initial EA/Organization
-- signatures, safe annual-workbook import, and the final security hardening baseline.
-- IMPORTANT: This schema supersedes v0.1-v0.8. Do not execute an older schema first.
-- CAP CDS/migrations become the implementation source of truth after the CAP project is created.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS egas;
SET search_path TO egas, public;

-- -----------------------------------------------------------------------------
-- 1. Routing/reference model
-- -----------------------------------------------------------------------------

-- The 22 stakeholder-supplied النيابة / المساعد values are ROUTING UNITS.
-- They do not imply 22 distinct people. Each unit must resolve to one active
-- primary approving-authority assignment before pilot acceptance.
CREATE TABLE routing_unit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name_ar text NOT NULL UNIQUE,
    code text UNIQUE,
    unit_kind text CHECK (unit_kind IS NULL OR unit_kind IN ('DEPUTY_DOMAIN','ASSISTANT_DOMAIN','DIRECT_MD','OTHER')),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_category_reference (
    code text PRIMARY KEY,
    name_ar text NOT NULL UNIQUE,
    display_order integer NOT NULL,
    is_active boolean NOT NULL DEFAULT true
);

INSERT INTO job_category_reference(code, name_ar, display_order) VALUES
('MANAGER_DEPARTMENT','مدير إدارة',1),
('SECTION_HEAD','رئيس قسم',2),
('STANDARD_FIRST','نمطي أول',3),
('STANDARD_EXCELLENT','نمطي ممتاز',4),
('STANDARD_SKILLED','نمطي ماهر',5)
ON CONFLICT (code) DO UPDATE SET
    name_ar = EXCLUDED.name_ar,
    display_order = EXCLUDED.display_order,
    is_active = true;

CREATE TABLE qualification_status_reference (
    code text PRIMARY KEY,
    name_ar text NOT NULL UNIQUE,
    display_order integer NOT NULL,
    is_active boolean NOT NULL DEFAULT true
);

INSERT INTO qualification_status_reference(code, name_ar, display_order) VALUES
('QUALIFIED','مستوفي',1),
('NOT_QUALIFIED','غير مستوفي',2)
ON CONFLICT (code) DO UPDATE SET
    name_ar = EXCLUDED.name_ar,
    display_order = EXCLUDED.display_order,
    is_active = true;

-- -----------------------------------------------------------------------------
-- 2. Application accounts and sessions
-- -----------------------------------------------------------------------------

CREATE TABLE user_account (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text NOT NULL UNIQUE,
    staff_identifier text,
    display_name text NOT NULL,
    job_title text, -- descriptive/default title; never used to infer authorization
    password_hash text NOT NULL,
    must_change_password boolean NOT NULL DEFAULT true,
    is_active boolean NOT NULL DEFAULT true,
    failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
    locked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES user_account(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    password_changed_at timestamptz,
    deactivated_at timestamptz,
    deactivated_by uuid REFERENCES user_account(id),
    version integer NOT NULL DEFAULT 1
);

-- One human/staff identifier maps to one account. The account may carry MULTIPLE roles.
CREATE UNIQUE INDEX uq_user_staff_identifier
ON user_account(staff_identifier)
WHERE staff_identifier IS NOT NULL;

CREATE TABLE user_account_role (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('ADMIN','EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
    can_manage_admins boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    granted_by uuid REFERENCES user_account(id),
    granted_at timestamptz NOT NULL DEFAULT now(),
    revoked_by uuid REFERENCES user_account(id),
    revoked_at timestamptz,
    CONSTRAINT user_role_admin_privilege_ck CHECK (can_manage_admins = false OR role = 'ADMIN'),
    -- Except for the bootstrap insert (granted_by NULL), a user cannot grant/revoke their own role.
    CONSTRAINT user_role_no_self_grant_ck CHECK (granted_by IS NULL OR granted_by <> user_id),
    CONSTRAINT user_role_no_self_revoke_ck CHECK (revoked_by IS NULL OR revoked_by <> user_id),
    UNIQUE(user_id, role)
);
CREATE INDEX ix_user_account_role_active ON user_account_role(user_id, is_active, role);

CREATE TABLE auth_session (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES user_account(id),
    token_hash text NOT NULL UNIQUE,
    csrf_secret_hash text,
    active_role text CHECK (active_role IS NULL OR active_role IN ('ADMIN','EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
    active_role_set_at timestamptz,
    rotated_from_session_id uuid REFERENCES auth_session(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    idle_expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_reason text,
    created_ip inet,
    user_agent text
);
CREATE INDEX ix_auth_session_user_active ON auth_session(user_id, revoked_at, absolute_expires_at);

-- Authentication/rate-limit evidence. The application may additionally use an
-- in-memory limiter, but durable attempts support lockout diagnostics/security audit.
CREATE TABLE auth_login_attempt (
    id bigserial PRIMARY KEY,
    identifier_fingerprint text NOT NULL, -- server-generated fingerprint; do not store plaintext password
    ip_address inet,
    was_successful boolean NOT NULL,
    failure_reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_login_attempt_identifier_time ON auth_login_attempt(identifier_fingerprint, created_at DESC);
CREATE INDEX ix_login_attempt_ip_time ON auth_login_attempt(ip_address, created_at DESC);

CREATE TABLE security_event (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id uuid REFERENCES user_account(id),
    event_type text NOT NULL,
    request_id uuid, -- intentionally not FK yet because workflow_request is defined later
    routing_unit_id uuid REFERENCES routing_unit(id),
    ip_address inet,
    correlation_id text,
    details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_security_event_type_time ON security_event(event_type, created_at DESC);
CREATE INDEX ix_security_event_actor_time ON security_event(actor_user_id, created_at DESC);

-- Explicit source-label mappings used by the annual importer. Unknown labels are
-- blocked until Admin/HR maps them to an approved routing unit or formally adds a
-- new routing unit. The importer MUST NOT guess from similar text.
CREATE TABLE routing_unit_source_alias (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_label text NOT NULL UNIQUE,
    routing_unit_id uuid NOT NULL REFERENCES routing_unit(id),
    is_active boolean NOT NULL DEFAULT true,
    configured_by uuid REFERENCES user_account(id),
    configured_at timestamptz NOT NULL DEFAULT now(),
    notes text
);
CREATE INDEX ix_routing_alias_unit ON routing_unit_source_alias(routing_unit_id, is_active);


-- -----------------------------------------------------------------------------
-- 3. Import batches / annual eligible employee dataset
-- -----------------------------------------------------------------------------

CREATE TABLE import_batch (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_year integer NOT NULL,
    source_filename text NOT NULL,
    source_sha256 text,
    header_schema_validated boolean NOT NULL DEFAULT false,
    detected_headers_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    imported_by uuid REFERENCES user_account(id),
    imported_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL CHECK (status IN ('STAGED','VALIDATED','ACTIVATED','FAILED','SUPERSEDED')),
    total_rows integer NOT NULL DEFAULT 0,
    valid_rows integer NOT NULL DEFAULT 0,
    warning_rows integer NOT NULL DEFAULT 0,
    blocked_rows integer NOT NULL DEFAULT 0,
    notes text
);
CREATE INDEX ix_import_batch_year ON import_batch(snapshot_year, imported_at DESC);

CREATE TABLE employee_import_staging_row (
    id bigserial PRIMARY KEY,
    import_batch_id uuid NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
    source_row_number integer NOT NULL,
    raw_json jsonb NOT NULL,
    personnel_number text,
    employee_name text,
    subgroup text,
    source_routing_unit text,
    current_job_title text,
    performance_rating text,
    qualification_source_1 text,
    qualification_source_2 text,
    qualification_date date,
    mapped_routing_unit_id uuid REFERENCES routing_unit(id),
    validation_status text NOT NULL DEFAULT 'PENDING' CHECK (validation_status IN ('PENDING','VALID','WARNING','BLOCKED')),
    validation_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
    UNIQUE(import_batch_id, source_row_number)
);
CREATE INDEX ix_employee_staging_batch_status ON employee_import_staging_row(import_batch_id, validation_status);

CREATE TABLE employee (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    personnel_number text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The authoritative annual eligible workbook does NOT contain employee-level
-- "الإدارة" or "التبعية التنظيمية" fields. v1 MUST NOT infer them from النيابة.
-- Proposed secondment organizational dependency is entered manually by Organization.
CREATE TABLE employee_annual_snapshot (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL REFERENCES employee(id),
    import_batch_id uuid NOT NULL REFERENCES import_batch(id),
    snapshot_year integer NOT NULL,
    personnel_number text NOT NULL,
    employee_name text NOT NULL,
    subgroup text,
    source_routing_unit text,
    routing_unit_id uuid REFERENCES routing_unit(id),
    current_job_title text,
    performance_rating text CHECK (performance_rating IS NULL OR performance_rating IN ('ممتاز','جيد جدا','جيد')),
    qualification_source_1 text,
    qualification_source_2 text,
    qualification_date date,
    source_row_number integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(snapshot_year, personnel_number)
);
CREATE INDEX ix_snapshot_employee ON employee_annual_snapshot(employee_id, snapshot_year DESC);
CREATE INDEX ix_snapshot_routing_unit ON employee_annual_snapshot(snapshot_year, routing_unit_id);
CREATE INDEX ix_snapshot_personnel ON employee_annual_snapshot(personnel_number, snapshot_year DESC);

-- -----------------------------------------------------------------------------
-- 4. Manual approving-authority routing configuration
-- -----------------------------------------------------------------------------

-- Operational users are NOT imported from staff spreadsheets in v1.
-- Except for the first bootstrap Admin, Admin manually creates every account.
-- Approving-authority job titles are descriptive/manual because source wording is
-- inconsistent and MUST NOT determine authorization.
CREATE TABLE approving_authority_assignment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    routing_unit_id uuid NOT NULL REFERENCES routing_unit(id),
    user_account_id uuid NOT NULL REFERENCES user_account(id),
    authority_kind text NOT NULL CHECK (authority_kind IN ('DEPUTY','ASSISTANT','ACTING_DEPUTY','ACTING_ASSISTANT','OTHER')),
    authority_job_title text NOT NULL, -- manually entered/displayed title for this assignment
    is_primary boolean NOT NULL DEFAULT true,
    valid_from date NOT NULL DEFAULT CURRENT_DATE,
    valid_to date,
    is_active boolean NOT NULL DEFAULT true,
    configured_by uuid REFERENCES user_account(id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1,
    CONSTRAINT authority_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
    -- An Admin who also holds APPROVING_AUTHORITY may not configure their own authority assignment.
    -- Bootstrap does not create authority assignments, so configured_by should normally be non-null.
    CONSTRAINT authority_no_self_config_ck CHECK (configured_by IS NULL OR configured_by <> user_account_id)
);

-- Maximum one ACTIVE PRIMARY assignment per routing unit.
-- Full coverage of all 22 routing units is checked by application/pilot preflight.
CREATE UNIQUE INDEX uq_active_primary_authority_per_unit
ON approving_authority_assignment(routing_unit_id)
WHERE is_primary = true AND is_active = true;

-- The same authority user may cover multiple routing units when explicitly configured.
CREATE INDEX ix_authority_assignment_user
ON approving_authority_assignment(user_account_id, is_active);

CREATE TABLE authority_delegation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    authority_assignment_id uuid NOT NULL REFERENCES approving_authority_assignment(id),
    delegated_user_id uuid NOT NULL REFERENCES user_account(id),
    created_by uuid NOT NULL REFERENCES user_account(id),
    valid_from timestamptz NOT NULL DEFAULT now(),
    valid_to timestamptz,
    is_active boolean NOT NULL DEFAULT true,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1,
    CONSTRAINT delegation_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX ix_authority_delegation_active ON authority_delegation(authority_assignment_id, is_active, valid_to);

-- Defense-in-depth: delegation to the same primary authority is meaningless and is rejected.
CREATE OR REPLACE FUNCTION prevent_authority_self_delegation() RETURNS trigger AS $$
DECLARE
    primary_user uuid;
BEGIN
    SELECT user_account_id INTO primary_user
    FROM approving_authority_assignment
    WHERE id = NEW.authority_assignment_id;

    IF primary_user IS NULL THEN
        RAISE EXCEPTION 'Unknown authority assignment';
    END IF;

    IF NEW.delegated_user_id = primary_user THEN
        RAISE EXCEPTION 'An approving authority cannot be delegated to itself';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_authority_self_delegation
BEFORE INSERT OR UPDATE OF authority_assignment_id, delegated_user_id
ON authority_delegation
FOR EACH ROW EXECUTE FUNCTION prevent_authority_self_delegation();

-- -----------------------------------------------------------------------------
-- 5. User signature assets
-- -----------------------------------------------------------------------------

-- Signature images are versioned immutable assets. A user may upload a newer active
-- signature later, but historical signoffs keep referencing the exact asset version
-- used when the workflow action was completed.
CREATE TABLE user_signature_asset (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES user_account(id),
    storage_key text NOT NULL UNIQUE, -- opaque server-controlled path/key; never expose filesystem paths
    mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg')),
    file_size_bytes bigint NOT NULL CHECK (file_size_bytes > 0),
    width_px integer CHECK (width_px IS NULL OR width_px > 0),
    height_px integer CHECK (height_px IS NULL OR height_px > 0),
    file_sha256 text NOT NULL UNIQUE,
    is_active boolean NOT NULL DEFAULT true,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    replaced_at timestamptz,
    replaced_by_asset_id uuid REFERENCES user_signature_asset(id),
    uploaded_from_ip inet
);
CREATE INDEX ix_signature_user_active ON user_signature_asset(user_id, is_active, uploaded_at DESC);

-- -----------------------------------------------------------------------------
-- 6. Workflow request / form structure
-- -----------------------------------------------------------------------------

CREATE TABLE workflow_request (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_number text NOT NULL UNIQUE,
    request_type text NOT NULL CHECK (request_type IN ('SECONDMENT','PROMOTION')),
    cycle_year integer NOT NULL, -- annual employee-data/workflow cycle
    form_month smallint NOT NULL CHECK (form_month BETWEEN 1 AND 12),
    form_year integer NOT NULL CHECK (form_year BETWEEN 2000 AND 2200), -- editable official form movement year
    routing_unit_id uuid NOT NULL REFERENCES routing_unit(id),
    approving_authority_assignment_id uuid NOT NULL REFERENCES approving_authority_assignment(id),
    approving_authority_personnel_snapshot text NOT NULL,
    approving_authority_name_snapshot text NOT NULL,
    approving_authority_job_title_snapshot text NOT NULL,
    approving_authority_kind_snapshot text NOT NULL,
    created_by uuid NOT NULL REFERENCES user_account(id),
    status text NOT NULL CHECK (status IN ('DRAFT','IN_PROGRESS','RETURNED','CANCELLED','COMPLETED')),
    current_stage text,
    current_iteration_no integer NOT NULL DEFAULT 1 CHECK (current_iteration_no >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    cancelled_at timestamptz,
    frozen_at timestamptz,
    version integer NOT NULL DEFAULT 1
);
CREATE INDEX ix_request_unit_status ON workflow_request(routing_unit_id, status, current_stage, created_at DESC);
CREATE INDEX ix_request_creator ON workflow_request(created_by, created_at DESC);
CREATE INDEX ix_request_type_year ON workflow_request(request_type, cycle_year, created_at DESC);
CREATE INDEX ix_request_authority_assignment ON workflow_request(approving_authority_assignment_id, created_at DESC);

ALTER TABLE security_event
    ADD CONSTRAINT fk_security_event_request
    FOREIGN KEY (request_id) REFERENCES workflow_request(id);

-- This is the printed-form subsection represented in نموذج (1) as a drop-list
-- heading such as وظيفة مدير إدارة / وظيفة رئيس قسم.
CREATE TABLE request_form_section (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL REFERENCES workflow_request(id) ON DELETE RESTRICT,
    job_category_code text NOT NULL REFERENCES job_category_reference(code),
    display_order integer NOT NULL DEFAULT 0,
    created_by uuid NOT NULL REFERENCES user_account(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(request_id, job_category_code)
);
CREATE INDEX ix_form_section_request ON request_form_section(request_id, display_order);

CREATE TABLE request_candidate (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL REFERENCES workflow_request(id) ON DELETE RESTRICT,
    form_section_id uuid NOT NULL REFERENCES request_form_section(id),
    employee_snapshot_id uuid NOT NULL REFERENCES employee_annual_snapshot(id),
    display_order integer NOT NULL DEFAULT 0,
    -- Frozen/display fields ensure completed output is independent of later source changes.
    personnel_number_snapshot text NOT NULL,
    employee_name_snapshot text NOT NULL,
    current_job_snapshot text,
    routing_unit_name_snapshot text,
    subgroup_snapshot text,
    performance_rating_snapshot text,
    qualification_source_1_snapshot text,
    qualification_source_2_snapshot text,
    qualification_date_snapshot date,
    last_promotion_report text,
    performance_warning_acknowledged boolean NOT NULL DEFAULT false,
    performance_warning_ack_by uuid REFERENCES user_account(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1,
    UNIQUE(request_id, employee_snapshot_id)
);
CREATE INDEX ix_candidate_request ON request_candidate(request_id, display_order);
CREATE INDEX ix_candidate_section ON request_candidate(form_section_id, display_order);
CREATE INDEX ix_candidate_personnel ON request_candidate(personnel_number_snapshot);

CREATE TABLE workflow_iteration (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL REFERENCES workflow_request(id) ON DELETE RESTRICT,
    iteration_no integer NOT NULL,
    status text NOT NULL CHECK (status IN ('ACTIVE','RETURNED','CANCELLED','COMPLETED','RECALLED')),
    started_by uuid NOT NULL REFERENCES user_account(id),
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    restart_reason text,
    parent_iteration_id uuid REFERENCES workflow_iteration(id),
    UNIQUE(request_id, iteration_no)
);
CREATE INDEX ix_iteration_request ON workflow_iteration(request_id, iteration_no DESC);

CREATE TABLE stage_task (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    iteration_id uuid NOT NULL REFERENCES workflow_iteration(id) ON DELETE RESTRICT,
    request_id uuid NOT NULL REFERENCES workflow_request(id) ON DELETE RESTRICT,
    stage_code text NOT NULL,
    task_status text NOT NULL CHECK (task_status IN ('OPEN','CLAIMED','COMPLETED','RETURNED','CANCELLED')),
    assigned_user_id uuid REFERENCES user_account(id),
    claimed_role_snapshot text CHECK (claimed_role_snapshot IS NULL OR claimed_role_snapshot IN ('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
    claimed_at timestamptz,
    opened_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    due_at timestamptz,
    version integer NOT NULL DEFAULT 1
);
CREATE INDEX ix_task_queue ON stage_task(stage_code, task_status, assigned_user_id, opened_at);
CREATE INDEX ix_task_request ON stage_task(request_id, opened_at DESC);

-- Immutable snapshot of exactly what a workflow actor RECEIVED at a stage.
-- "View as PDF" renders this snapshot in the official form layout even after later
-- actors change the request. For shared Organization queues the snapshot is frozen
-- when the task is claimed; for directly assigned stages it is frozen when opened.
CREATE TABLE stage_received_snapshot (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stage_task_id uuid NOT NULL UNIQUE REFERENCES stage_task(id) ON DELETE RESTRICT,
    request_id uuid NOT NULL REFERENCES workflow_request(id) ON DELETE RESTRICT,
    iteration_id uuid NOT NULL REFERENCES workflow_iteration(id) ON DELETE RESTRICT,
    recipient_user_id uuid NOT NULL REFERENCES user_account(id),
    recipient_role_snapshot text NOT NULL CHECK (recipient_role_snapshot IN ('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
    snapshot_json jsonb NOT NULL,
    snapshot_sha256 text NOT NULL UNIQUE,
    template_version text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_received_snapshot_user ON stage_received_snapshot(recipient_user_id, received_at DESC);
CREATE INDEX ix_received_snapshot_request ON stage_received_snapshot(request_id, received_at);

-- -----------------------------------------------------------------------------
-- 7. Secondment / promotion decision data
-- -----------------------------------------------------------------------------

CREATE TABLE secondment_position_option (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_candidate_id uuid NOT NULL REFERENCES request_candidate(id) ON DELETE RESTRICT,
    iteration_id uuid NOT NULL REFERENCES workflow_iteration(id) ON DELETE RESTRICT,
    -- Manual fields explicitly shown as manual in نموذج (1)
    position_title text NOT NULL,
    organizational_dependency text,
    qualification_status_code text REFERENCES qualification_status_reference(code),
    entered_by uuid NOT NULL REFERENCES user_account(id),
    display_order integer NOT NULL DEFAULT 0,
    is_selected boolean NOT NULL DEFAULT false,
    selected_by uuid REFERENCES user_account(id),
    selected_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1
);
CREATE INDEX ix_secondment_option_candidate ON secondment_position_option(request_candidate_id, iteration_id, display_order);

CREATE TABLE promotion_decision (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_candidate_id uuid NOT NULL REFERENCES request_candidate(id) ON DELETE RESTRICT,
    iteration_id uuid NOT NULL REFERENCES workflow_iteration(id) ON DELETE RESTRICT,
    decision_type text NOT NULL CHECK (decision_type IN ('SAME_POSITION','OTHER_POSITION')),
    -- Manual field required only when OTHER_POSITION is chosen.
    target_job_title text,
    notes text,
    decided_by uuid NOT NULL REFERENCES user_account(id),
    decided_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT other_position_title_ck CHECK (
        (decision_type = 'OTHER_POSITION' AND nullif(btrim(target_job_title),'') IS NOT NULL)
        OR (decision_type = 'SAME_POSITION' AND (target_job_title IS NULL OR btrim(target_job_title)=''))
    ),
    UNIQUE(request_candidate_id, iteration_id)
);

CREATE TABLE stage_action (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL REFERENCES workflow_request(id) ON DELETE RESTRICT,
    iteration_id uuid NOT NULL REFERENCES workflow_iteration(id) ON DELETE RESTRICT,
    stage_task_id uuid REFERENCES stage_task(id),
    request_candidate_id uuid REFERENCES request_candidate(id),
    actor_user_id uuid NOT NULL REFERENCES user_account(id),
    actor_role_snapshot text NOT NULL CHECK (actor_role_snapshot IN ('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
    action_code text NOT NULL,
    reason text,
    payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_stage_action_request ON stage_action(request_id, created_at);

-- Append-only notes/messages passed between workflow actors. Any workflow actor may
-- add a request-level or candidate-level message. Notes are visible to authorized later
-- workflow actors and are never silently overwritten; v1 has no hidden/private workflow note.
-- Every create action must also emit an audit_event. ALL candidate-scoped notes are rendered in the official form's "ملاحظات" area in chronological order; there is no per-note print toggle in v1.
-- Request-scoped notes are workflow messages/history and are not printed in a candidate cell, but remain visible to later authorized actors and in the audit trail.
CREATE TABLE workflow_note (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL REFERENCES workflow_request(id) ON DELETE RESTRICT,
    iteration_id uuid NOT NULL REFERENCES workflow_iteration(id) ON DELETE RESTRICT,
    stage_task_id uuid REFERENCES stage_task(id) ON DELETE RESTRICT,
    request_candidate_id uuid REFERENCES request_candidate(id) ON DELETE RESTRICT,
    scope_code text NOT NULL CHECK (scope_code IN ('REQUEST','CANDIDATE')),
    author_user_id uuid NOT NULL REFERENCES user_account(id),
    author_role_snapshot text NOT NULL CHECK (author_role_snapshot IN ('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY')),
    message_text text NOT NULL CHECK (length(btrim(message_text)) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workflow_note_scope_ck CHECK (
        (scope_code='REQUEST' AND request_candidate_id IS NULL)
        OR (scope_code='CANDIDATE' AND request_candidate_id IS NOT NULL)
    )
);
CREATE INDEX ix_workflow_note_request ON workflow_note(request_id, created_at);
CREATE INDEX ix_workflow_note_candidate ON workflow_note(request_candidate_id, created_at) WHERE request_candidate_id IS NOT NULL;

-- Human-readable signature/signoff metadata rendered into the official PDF.
-- The authenticated server-side workflow action is authoritative; the signature image
-- is a visual artifact and MUST NOT be treated as authentication by itself.
CREATE TABLE workflow_signoff (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL REFERENCES workflow_request(id) ON DELETE RESTRICT,
    iteration_id uuid REFERENCES workflow_iteration(id) ON DELETE RESTRICT,
    stage_task_id uuid REFERENCES stage_task(id) ON DELETE RESTRICT,
    stage_code text NOT NULL,
    signer_user_id uuid NOT NULL REFERENCES user_account(id),
    signer_role_snapshot text NOT NULL,
    signer_name_snapshot text NOT NULL,
    signer_job_title_snapshot text,
    job_title_was_overridden boolean NOT NULL DEFAULT false,
    signature_asset_id uuid NOT NULL REFERENCES user_signature_asset(id),
    signature_sha256_snapshot text NOT NULL,
    signed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_signoff_request_iteration_stage ON workflow_signoff(request_id, iteration_id, stage_code);
CREATE INDEX ix_signoff_request_stage ON workflow_signoff(request_id, stage_code, signed_at);
CREATE INDEX ix_signoff_user ON workflow_signoff(signer_user_id, signed_at DESC);

-- -----------------------------------------------------------------------------
-- 8. Notifications, audit, signoffs and PDF
-- -----------------------------------------------------------------------------

CREATE TABLE notification (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id uuid NOT NULL REFERENCES user_account(id),
    request_id uuid REFERENCES workflow_request(id),
    notification_type text NOT NULL,
    title_ar text NOT NULL,
    body_ar text,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
);
CREATE INDEX ix_notification_unread ON notification(recipient_user_id, read_at, created_at DESC);

CREATE TABLE audit_event (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid REFERENCES workflow_request(id),
    iteration_id uuid REFERENCES workflow_iteration(id),
    request_candidate_id uuid REFERENCES request_candidate(id),
    actor_user_id uuid REFERENCES user_account(id),
    actor_name_snapshot text,
    actor_identifier_snapshot text,
    actor_role_snapshot text,
    routing_unit_id uuid REFERENCES routing_unit(id),
    approving_authority_assignment_id uuid REFERENCES approving_authority_assignment(id),
    action_code text NOT NULL,
    from_stage text,
    to_stage text,
    reason text,
    metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip_address inet,
    created_at timestamptz NOT NULL DEFAULT now(),
    previous_hash text,
    event_hash text NOT NULL UNIQUE
);
CREATE INDEX ix_audit_request_time ON audit_event(request_id, created_at);
CREATE INDEX ix_audit_unit_time ON audit_event(routing_unit_id, created_at);
CREATE INDEX ix_audit_actor_time ON audit_event(actor_user_id, created_at);

-- Application DB role should receive INSERT/SELECT but not UPDATE/DELETE on audit_event.

-- FORM document_state semantics:
-- RECEIVED = immutable stage-received snapshot; DRAFT = current saved in-progress form preview;
-- FINAL = frozen completed official form. AUDIT_LOG uses period/request filters independently.
CREATE TABLE pdf_generation_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    generated_by uuid NOT NULL REFERENCES user_account(id),
    document_type text NOT NULL CHECK (document_type IN ('FORM','AUDIT_LOG')),
    document_state text NOT NULL DEFAULT 'DRAFT' CHECK (document_state IN ('RECEIVED','DRAFT','FINAL')),
    request_id uuid REFERENCES workflow_request(id),
    stage_received_snapshot_id uuid REFERENCES stage_received_snapshot(id),
    routing_unit_id uuid REFERENCES routing_unit(id),
    period_code text CHECK (period_code IS NULL OR period_code IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY')),
    period_start date,
    period_end date,
    template_version text NOT NULL,
    file_sha256 text,
    generated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_pdf_generation_request ON pdf_generation_log(request_id, generated_at DESC);

-- -----------------------------------------------------------------------------
-- 9. Seed the 22 approved routing units
-- -----------------------------------------------------------------------------

INSERT INTO routing_unit(name_ar) VALUES
('التخطيط ومشروعات الغاز وتنمية الاعمال'),
('العمليات والشبكات'),
('الإنتاج وتنمية الحقول'),
('التبعية للعضو المنتدب التنفيذى'),
('الرقابة على الشركات الاجنبية والمشتركة'),
('الشئون المالية'),
('الشئون الإدارية'),
('الاتفاقيات والاستكشاف'),
('التجارة الخارجية'),
('الشئون القانونية'),
('التجارة الداخلية والشئون الاقتصادية'),
('المكتب الفنى والمشروعات الخاصة وسلامة العمليات'),
('الأمن'),
('العلاقات الحكومية'),
('نظم المعلومات والاتصالات'),
('الامانة العامة لمجلس الادارة'),
('الإعلام'),
('حماية البيئة'),
('العلاقات الدولية'),
('العقود'),
('السلامة والصحة المهنية'),
('الاستراتيجيات ودعم اتخاذ القرار')
ON CONFLICT (name_ar) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 10. Operational invariants implemented in CAP/service/bootstrap scripts
-- -----------------------------------------------------------------------------
-- 1) No public Admin sign-up route. First Admin is created with npm run admin:bootstrap.
-- 2) Bootstrap creates one user_account plus an active ADMIN user_account_role row with
--    can_manage_admins=true and must_change_password=true.
-- 3) Every later account/role assignment is created manually by an authorized Admin.
--    Staff identifiers are NOT hard-coded in schema seeds, documents or fixtures.
-- 4) A single account may have multiple roles. Admin Portal accepts accounts with an
--    active ADMIN role; Workflow Portal accepts active operational roles. If more than
--    one operational role exists, the user selects/switches active role. Each action is
--    authorized and audited ONLY under that active role; permissions are never unioned.
-- 5) Only an active ADMIN role with can_manage_admins=true may grant/revoke ADMIN roles
--    or change can_manage_admins; reject any operation leaving zero active privileged Admins.
-- 6) Approving Authority display name/staff identifier/default job title are manual.
--    Job-title text NEVER grants authorization. Admin explicitly maps authority accounts
--    to routing units; one authority may cover multiple units.
-- 7) npm run pilot:check verifies the approved active routing-unit set and exactly one
--    active PRIMARY ApprovingAuthorityAssignment per active unit.
-- 8) Request creation derives routing_unit_id from annual snapshot/source-alias mapping.
--    Unknown source labels are BLOCKED until explicitly mapped; never guessed.
-- 9) P1/S1 initial Employee Affairs submission and P2/S2 initial Organization submission
--    REQUIRE a valid workflow_signoff with immutable signature asset. The visible official
--    form uses those signoffs from the final completed iteration. Later EA/Organization
--    approvals remain audit evidence and MUST NOT replace the initial visible signatory row.
-- 10) At P5/S5 final confirmation Employee Affairs can view/print/download the final form.
-- 11) Every operational stage recipient can use "View as PDF" to render the immutable
--     stage_received_snapshot representing exactly the data that actor received.
-- 12) Any workflow actor may append notes/messages. Note creation is audited; ALL candidate-level
--     notes appear chronologically in the official candidate "ملاحظات" area. Request-level notes
--     remain workflow messages/history and are not forced into a candidate cell.
-- 13) Real Excel files, signatures, database backups, generated employee PDFs and .env
--     secrets remain outside Git. Code/import logic/schema/migrations use synthetic fixtures.

-- -----------------------------------------------------------------------------
-- 11. Annual XLSX import normalization rules
-- -----------------------------------------------------------------------------
-- Preferred operational command:
--   npm run data:import -- --file <xlsx> --year <YYYY>
-- The repository-owned importer reads .xlsx directly, stores raw staging rows, validates,
-- normalizes and explicitly activates the annual snapshot. Database GUI imports are not
-- the authoritative operational path.
--
-- Annual eligible dataset rules:
-- * Hard-validate the REQUIRED header names before staging any row. Import by header
--   name, not by fragile column position; column order may vary. Reject missing/duplicate
--   required headers and reject the wrong workbook.
-- * Normalize blank/whitespace performance and routing-unit values to NULL. For backward
--   compatibility with the stakeholder instruction, a literal trimmed "10" is ALSO
--   normalized to NULL if ever encountered; the current workbook contains blanks, not 10.
-- * routing_unit_id resolves only through approved routing-unit names/source aliases.
--   Unknown labels are BLOCKED until explicitly mapped or formally added as routing units.
-- * Personnel Number is required and unique within the annual batch.
-- * The supplied annual workbook is the authoritative eligible v1 population; do not
--   invent a second "level 1 and below" eligibility engine.
-- * Employee-level الإدارة / التبعية التنظيمية are absent from the authoritative workbook
--   and MUST NOT be inferred from النيابة. Proposed secondment organizational dependency
--   remains a manual Organization field.
-- * No staff/authority workbook auto-creates application users or authority assignments.



-- -----------------------------------------------------------------------------
-- 12. Final requirement-analysis freeze - PDF/signoff/view-as-received/notes
-- -----------------------------------------------------------------------------
-- Stage codes used by the service/state machine:
-- Promotion: P1 EA initial -> P2 Organization -> P3 EA review -> P4 Authority -> P5 EA final.
-- Secondment: S1 EA initial -> S2 Organization -> S3 Authority -> S4 Organization confirm -> S5 EA final.
--
-- 1) Employee Affairs may view/print/download a DRAFT official form at P1/S1. Later
--    fields remain blank while preserving the official form layout.
-- 2) form_month/form_year are editable official-form fields independent of snapshot year.
-- 3) Visible EA signatory block = P1/S1 signoff from the final completed iteration.
--    Visible Organization block = P2/S2 signoff from the final completed iteration.
--    Later P3/P5/S4/S5 actions do not replace those visible signatory identities.
-- 4) P1/S1 and P2/S2 signoffs require authenticated full name, default profile job title
--    with per-signoff override, and a mandatory immutable signature asset.
-- 5) EA and Organization signatory blocks render on one horizontal row in the official PDF.
-- 6) P5/S5 final confirmation can view/print/download the FINAL frozen official PDF.
-- 7) Every operational actor may click "View as PDF" for a stage task. This renders the
--    immutable stage_received_snapshot of the data that actor received, not a later-mutated
--    state. Unknown/later-owned fields remain blank in the official form layout.
--    Stages that can edit/decide may additionally preview the CURRENT saved form state
--    before submission; this preview is distinct from the immutable received-stage view.
-- 8) Any operational actor may append notes/messages. Authorship, active role, stage and
--    server timestamp are retained and audited. Request-scoped notes are workflow messages
--    visible to subsequent actors. ALL candidate-scoped notes are rendered chronologically
--    in the candidate "ملاحظات" area; nobody overwrites a previous actor's note.
-- 9) Replacing a user's active signature later MUST NOT change historical signoffs/PDFs.
-- 10) FINAL output derives only from frozen request/candidate/decision/signoff/note data.
-- 11) A signature image is visual evidence only; authenticated workflow action + audit
--     event + server timestamp are the authoritative approval evidence.

-- -----------------------------------------------------------------------------
-- 13. Security hardening implementation requirements (v0.6 / SRS v1.6 + final amendment)
-- -----------------------------------------------------------------------------
-- A) Secrets / Git
--    * No real secrets in this SQL file, source code, .env.example or fixtures.
--    * Runtime secrets come from machine-local/approved secret configuration.
--    * Repository security commands must scan for secrets/dependencies before release.
--    * If a secret is committed: revoke/rotate FIRST, then purge/rewrite Git history,
--      rescan branches/tags and document the incident.
--
-- B) Database access
--    * Runtime app role MUST NOT be postgres/superuser/table owner/BYPASSRLS.
--    * Use a separate migration/owner role and a least-privilege runtime role.
--    * Browser/frontends receive NO PostgreSQL credential/public DB key.
--    * All application queries use CAP/CDS or bound SQL parameters; never concatenate
--      untrusted values into SQL text.
--
-- C) RLS defense-in-depth scaffold
--    The CAP implementation should set transaction-local trusted context before
--    executing scoped queries, for example:
--      SELECT set_config('egas.user_id', '<uuid>', true);
--      SELECT set_config('egas.role', '<active-role>', true);
--    Policies may then reference current_setting(..., true). Do NOT enable brittle
--    policies until the corresponding service transactions/tests exist. Backend
--    authorization remains mandatory even after RLS is enabled.
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('egas.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION current_app_role() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('egas.role', true), '')
$$;

-- Example future migration pattern (NOT activated in this logical baseline):
-- ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY notification_read_own ON notification
--   FOR SELECT USING (recipient_user_id = current_app_user_id() OR current_app_role() = 'ADMIN');
-- Policies for INSERT/UPDATE and workflow tables must account for trusted backend
-- system actions, request stage, claims, authority assignments and delegations.
--
-- D) Record/field tamper controls
--    * version columns participate in optimistic concurrency/ETag checks.
--    * Workflow status/current_stage/actor/timestamps/snapshot fields are server-derived.
--    * Request DTOs use field allow-lists; unknown/protected fields are rejected.
--    * Organization claim remains a conditional transactional update/row lock.
--
-- E) Session/login controls
--    * Store only session token hashes in auth_session; raw cookie value is never stored.
--    * HttpOnly + Secure (HTTPS) + SameSite cookie; server-side revocation.
--    * Rotate sessions after login/password/privilege changes.
--    * Engineering defaults pending IT approval: 30m idle, 8h absolute.
--    * Login engineering baseline: 5 failures/10m -> 15m temporary lockout, plus IP
--      throttling; generic error messages; progressive anti-bot controls.
--    * csrf_secret_hash supports a per-session CSRF-token strategy if selected.
--
-- F) Input/output/file controls
--    * Validate all bodies/path/query parameters, lengths/enums/dates/page limits.
--    * API responses use explicit projections; never serialize password/session/internal
--      authorization fields or unnecessary HR columns.
--    * Render user content through safe React/UI5 text binding; no raw HTML injection.
--    * Annual import accepts approved .xlsx only; validate container/signature, size,
--      headers/sheets/row bounds; reject .xlsm/macros; stage before activation.
--    * Signature upload accepts only validated PNG/JPEG. Decode and re-encode server-side
--      into a canonical image, strip metadata, enforce compressed-size + decoded-pixel
--      limits/decompression-bomb checks, and store under opaque server-controlled keys
--      outside the web root. Serve only through authorization-checked endpoints with
--      fixed Content-Type/Content-Disposition and nosniff; never as public static files.
--    * Historical signature versions are immutable and signoff rows freeze the canonical
--      signature SHA-256 used at signing time.
--
-- G) Transport/storage/deployment controls
--    * HTTPS is mandatory for production-like deployment; localhost dev may use HTTP.
--    * Reverse proxy adds CSP, nosniff, frame protection, Referrer-Policy,
--      Permissions-Policy and HSTS after HTTPS is stable.
--    * Database/backup storage encryption and access controls follow EGAS IT standard.
--    * Backups, HR source files, generated real PDFs and real .env remain outside Git.
--
-- H) PDF renderer isolation / expensive-operation limits
--    * Headless Chromium/PDF renderer has no arbitrary internet/internal-network egress,
--      no uncontrolled file:// access, and loads only approved local/template assets.
--    * All user/manual text is output-encoded into PDF templates; never concatenate raw
--      HTML. Apply per-user PDF/report rate limits and bounded renderer concurrency.
--
-- I) Trusted time / security verification
--    * Pilot/production host uses EGAS-approved synchronized system time/NTP; workflow,
--      audit and signoff timestamps always come from the server, never browser clocks.
--    * Required release gates: authorization matrix/IDOR, active-role isolation for
--      multi-role users, mass assignment, CSRF, XSS, SQL injection, rate limit/lockout,
--      session revoke/rotation, invalid/oversized XLSX/signature files, PDF SSRF/template
--      isolation, CORS/headers/HTTPS, RLS tests where enabled, safe errors, dependency
--      scanning, secret scanning AND SAST against custom CAP/React code. Target OWASP
--      ASVS 5.0 Level 2 for production-intended build.
