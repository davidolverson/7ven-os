BEGIN;

CREATE TABLE app.offboarding_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES app.person_profile(id),
  requested_by uuid NOT NULL REFERENCES app.person_profile(id),
  decision_ref text NOT NULL,
  reason text NOT NULL,
  state text NOT NULL CHECK (state IN ('org_disabled', 'identity_in_progress', 'identity_failed', 'complete')),
  correlation_id uuid NOT NULL UNIQUE,
  identity_error_code text,
  identity_attempt_token uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  org_disabled_at timestamptz NOT NULL,
  last_identity_attempt_at timestamptz,
  identity_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offboarding_execution_decision_unique UNIQUE (person_id, decision_ref),
  CONSTRAINT offboarding_execution_state_shape CHECK (
    (
      state = 'complete'
      AND identity_completed_at IS NOT NULL
      AND identity_error_code IS NULL
      AND identity_attempt_token IS NULL
    )
    OR
    (
      state = 'identity_failed'
      AND identity_completed_at IS NULL
      AND identity_error_code IS NOT NULL
      AND identity_attempt_token IS NULL
    )
    OR
    (
      state = 'identity_in_progress'
      AND identity_completed_at IS NULL
      AND identity_error_code IS NULL
      AND identity_attempt_token IS NOT NULL
      AND last_identity_attempt_at IS NOT NULL
    )
    OR
    (
      state = 'org_disabled'
      AND identity_completed_at IS NULL
      AND identity_error_code IS NULL
      AND identity_attempt_token IS NULL
    )
  )
);

CREATE UNIQUE INDEX offboarding_execution_one_incomplete_per_person
  ON app.offboarding_execution (person_id)
  WHERE state IN ('org_disabled', 'identity_in_progress', 'identity_failed');

CREATE INDEX offboarding_execution_state_idx
  ON app.offboarding_execution (state, updated_at);

COMMIT;
