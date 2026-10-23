CREATE TABLE IF NOT EXISTS email_reminder_rate_limits (
  uid TEXT PRIMARY KEY NOT NULL,
  window_key INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0 AND request_count <= 5)
);
