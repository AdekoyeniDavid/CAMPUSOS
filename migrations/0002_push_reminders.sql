CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS push_subscriptions_uid_idx ON push_subscriptions(uid);

CREATE TABLE IF NOT EXISTS push_reminder_rate_limits (
  uid TEXT PRIMARY KEY NOT NULL,
  window_key INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0 AND request_count <= 30)
);
