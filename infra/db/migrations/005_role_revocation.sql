BEGIN;

ALTER TABLE app.role_assignment
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by uuid REFERENCES app.person_profile(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revocation_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'role_assignment_revocation_shape'
       AND conrelid = 'app.role_assignment'::regclass
  ) THEN
    ALTER TABLE app.role_assignment
      ADD CONSTRAINT role_assignment_revocation_shape
      CHECK (
        (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
        OR
        (
          revoked_at IS NOT NULL
          AND revocation_reason IS NOT NULL
          AND char_length(btrim(revocation_reason)) BETWEEN 10 AND 500
        )
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS role_assignment_unrevoked_person_idx
  ON app.role_assignment(person_id, role_key, starts_at, ends_at)
  WHERE revoked_at IS NULL;

COMMIT;
