DROP INDEX IF EXISTS timetable_notification_due_idx;

ALTER TABLE timetable_notification_reminders RENAME TO timetable_notification_reminders_old;

CREATE TABLE timetable_notification_reminders (
  id TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('weekly', 'exam', 'event')),
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

INSERT INTO timetable_notification_reminders
  (id, uid, source_type, source_id, title, course_code, local_date, day_of_week, local_time, time_zone, location, lead_minutes, next_fire_at, locked_until, updated_at)
SELECT id, uid, source_type, source_id, title, course_code, local_date, day_of_week, local_time, time_zone, location, lead_minutes, next_fire_at, locked_until, updated_at
FROM timetable_notification_reminders_old;

DROP TABLE timetable_notification_reminders_old;

CREATE INDEX timetable_notification_due_idx
  ON timetable_notification_reminders(next_fire_at, locked_until);
