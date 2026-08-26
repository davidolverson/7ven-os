BEGIN;

CREATE INDEX IF NOT EXISTS application_reviewer_queue_idx
  ON app.application(submitted_at DESC, id DESC)
  WHERE state <> 'withdrawn';

CREATE INDEX IF NOT EXISTS application_owner_history_idx
  ON app.application(lower(email), submitted_at DESC, id DESC);

COMMIT;
