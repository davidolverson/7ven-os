BEGIN;

CREATE TABLE IF NOT EXISTS app.rate_limit_bucket (
  bucket text NOT NULL,
  key_hash char(64) NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, key_hash)
);

CREATE INDEX IF NOT EXISTS rate_limit_bucket_updated_idx
  ON app.rate_limit_bucket(updated_at);

COMMIT;
