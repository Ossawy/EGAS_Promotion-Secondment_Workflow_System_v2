ALTER TABLE audit_event
  ADD COLUMN actor_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN subject_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN audit_event.actor_snapshot IS
  'Immutable, non-secret actor identity captured when the event is written.';

COMMENT ON COLUMN audit_event.subject_snapshot IS
  'Immutable, non-secret business label captured when the event is written.';

