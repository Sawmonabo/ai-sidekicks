//! The timed fires a provider keeps for each session, its one-shot wake-ups and jobs and its
//! recurring jobs, kept so the daemon's next start wakes each sleeping session on its schedule.

/// The kept schedules' table, keyed by the session and each schedule's place in its list.
pub(super) const SESSION_KEPT_SCHEDULES_SCHEMA_SQL: &str = "
-- ---------------------------------------------------------------------------
-- Kept schedules: each session's timed fires as its provider last reported
-- them, replaced whole at each change, read at the daemon's start.
-- ---------------------------------------------------------------------------
CREATE TABLE session_kept_schedules (
  session_id    TEXT NOT NULL,
  position      INTEGER NOT NULL CHECK (position >= 0),
  fires_at      TEXT,          -- a one-shot fire's instant, RFC 3339 UTC, ms precision
  cron          TEXT,          -- a recurring job's five-field schedule, in local time
  next_fire_at  TEXT,          -- the recurring job's next run, where the provider said
  CHECK ((fires_at IS NULL) <> (cron IS NULL)),
  CHECK (cron IS NOT NULL OR next_fire_at IS NULL),
  PRIMARY KEY (session_id, position)
) STRICT;
";
