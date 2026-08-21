-- Phase 3: Generic workflow engine performance and correctness constraints

-- 1. Database-level workflow invariants
CREATE UNIQUE INDEX IF NOT EXISTS workflow_iteration_one_active_per_request
  ON workflow_iteration(request_id)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS stage_execution_one_open_per_iteration
  ON stage_execution(iteration_id)
  WHERE status = 'OPEN';

-- 2. Non-destructive performance indexes
CREATE INDEX IF NOT EXISTS idx_workflow_request_routing_status
  ON workflow_request(routing_unit_id, status);

CREATE INDEX IF NOT EXISTS idx_workflow_request_created_by
  ON workflow_request(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_stage_execution_responsible_status
  ON stage_execution(responsible_unit_id, status);

CREATE INDEX IF NOT EXISTS idx_work_assignment_active_user
  ON work_assignment(assigned_to_user_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_note_request
  ON workflow_note(request_id, created_at);

CREATE INDEX IF NOT EXISTS idx_stage_action_execution
  ON stage_action(stage_execution_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_recipient_read
  ON notification(recipient_user_id, is_read, created_at DESC);
