CREATE TABLE IF NOT EXISTS assignment_notification_reminders (
  id TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  title TEXT NOT NULL,
  course_code TEXT NOT NULL,
  due_date TEXT NOT NULL,
  due_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  lead_minutes INTEGER NOT NULL CHECK (lead_minutes IN (5, 15, 30, 60, 1440)),
  next_fire_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(uid, assignment_id)
);

CREATE INDEX IF NOT EXISTS assignment_notification_due_idx
  ON assignment_notification_reminders(next_fire_at, locked_until);
