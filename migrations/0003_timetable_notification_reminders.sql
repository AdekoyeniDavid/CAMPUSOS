CREATE TABLE IF NOT EXISTS timetable_notification_reminders (
  id TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('weekly', 'exam')),
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  course_code TEXT NOT NULL,
  local_date TEXT,
  day_of_week INTEGER,
  local_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  lead_minutes INTEGER NOT NULL CHECK (lead_minutes IN (5, 15, 30, 60)),
  next_fire_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(uid, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS timetable_notification_due_idx
  ON timetable_notification_reminders(next_fire_at, locked_until);
