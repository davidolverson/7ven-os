BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM app.role_assignment
     WHERE (scope_type = 'organization' AND scope_id IS NOT NULL)
        OR (scope_type <> 'organization' AND scope_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'role_assignment contains invalid scope_type/scope_id combinations; refusing to normalize authorization data automatically';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'app.role_assignment'::regclass
       AND conname = 'role_assignment_scope_shape_check'
  ) THEN
    ALTER TABLE app.role_assignment
      ADD CONSTRAINT role_assignment_scope_shape_check
      CHECK (
        (scope_type = 'organization' AND scope_id IS NULL)
        OR
        (scope_type <> 'organization' AND scope_id IS NOT NULL)
      );
  END IF;
END;
$$;

COMMIT;
