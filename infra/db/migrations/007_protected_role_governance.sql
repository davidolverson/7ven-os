BEGIN;

CREATE TABLE app.role_change_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation text NOT NULL CHECK (operation IN ('grant', 'revoke')),
  target_person_id uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  target_assignment_id uuid REFERENCES app.role_assignment(id) ON DELETE RESTRICT,
  role_key text NOT NULL CHECK (role_key IN (
    'integrity_officer','safeguarding_officer','finance_submitter','finance_approver',
    'finance_reconciler','council','privileged_admin'
  )),
  scope_type text NOT NULL CHECK (scope_type IN ('organization','title','team','event','case','finance')),
  scope_id uuid,
  requested_ends_at timestamptz,
  requested_by uuid NOT NULL REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  request_reason text NOT NULL CHECK (char_length(btrim(request_reason)) BETWEEN 10 AND 500),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','executed','rejected','cancelled')),
  reviewed_by uuid REFERENCES app.person_profile(id) ON DELETE RESTRICT,
  review_reason text CHECK (review_reason IS NULL OR char_length(btrim(review_reason)) BETWEEN 10 AND 500),
  reviewed_at timestamptz,
  result_assignment_id uuid REFERENCES app.role_assignment(id) ON DELETE RESTRICT,
  executed_at timestamptz,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT role_change_request_scope_shape CHECK (
    (scope_type = 'organization' AND scope_id IS NULL)
    OR
    (scope_type <> 'organization' AND scope_id IS NOT NULL)
  ),
  CONSTRAINT role_change_request_operation_shape CHECK (
    (operation = 'grant' AND target_assignment_id IS NULL)
    OR
    (operation = 'revoke' AND target_assignment_id IS NOT NULL AND requested_ends_at IS NULL)
  ),
  CONSTRAINT role_change_request_time_shape CHECK (
    requested_ends_at IS NULL OR requested_ends_at > created_at
  ),
  CONSTRAINT role_change_request_reviewer_separation CHECK (
    reviewed_by IS NULL OR reviewed_by <> requested_by
  ),
  CONSTRAINT role_change_request_state_shape CHECK (
    (
      state = 'pending'
      AND reviewed_by IS NULL
      AND review_reason IS NULL
      AND reviewed_at IS NULL
      AND result_assignment_id IS NULL
      AND executed_at IS NULL
    )
    OR
    (
      state = 'executed'
      AND reviewed_by IS NOT NULL
      AND review_reason IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND result_assignment_id IS NOT NULL
      AND executed_at IS NOT NULL
    )
    OR
    (
      state = 'rejected'
      AND reviewed_by IS NOT NULL
      AND review_reason IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND result_assignment_id IS NULL
      AND executed_at IS NULL
    )
    OR
    (
      state = 'cancelled'
      AND reviewed_by IS NULL
      AND review_reason IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND result_assignment_id IS NULL
      AND executed_at IS NULL
    )
  )
);

CREATE UNIQUE INDEX role_change_request_pending_grant_unique
  ON app.role_change_request (
    target_person_id,
    role_key,
    scope_type,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE state = 'pending' AND operation = 'grant';

CREATE UNIQUE INDEX role_change_request_pending_revoke_unique
  ON app.role_change_request (target_assignment_id)
  WHERE state = 'pending' AND operation = 'revoke';

CREATE INDEX role_change_request_queue_idx
  ON app.role_change_request (state, created_at);

CREATE INDEX role_change_request_target_idx
  ON app.role_change_request (target_person_id, role_key, created_at DESC);

COMMIT;
