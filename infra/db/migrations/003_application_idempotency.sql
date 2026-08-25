BEGIN;

ALTER TABLE app.application
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS application_idempotency_unique
  ON app.application(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
