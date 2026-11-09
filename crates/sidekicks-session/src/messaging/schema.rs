//! The messaging part of the daemon's schema: the exchanges between pairs of sessions, the
//! messages held for a paused session, what each session waits on and the reminders a session set.
//! Each is daemon state its own writes keep, never a projection of the log, and no table holds a
//! message's words, which stay in the sending session's own events. No table refers to `sessions`:
//! the purge deletes a session's rows before its directory row.

use sidekicks_store::database::schema::{SchemaPart, SchemaParts};
use sidekicks_store::database::sql_list::sql_list_of_every;

use sidekicks_provider::driver::agent_tools::AgentToolWait;

/// The store's own list, which holds the session directory every write here is checked against,
/// and the messaging part.
pub fn schema_parts() -> SchemaParts {
    sidekicks_store::database::schema::schema_parts()
        .with_part(SchemaPart::new("session_messaging", messaging_schema_sql()))
}

fn messaging_schema_sql() -> String {
    let wait_forms = sql_list_of_every::<AgentToolWait>();
    format!(
        "
-- ---------------------------------------------------------------------------
-- Sessions talking to each other.
-- ---------------------------------------------------------------------------
-- One row per pair of sessions trading messages, the two ids in ascending order so A to B and B
-- to A are one row and one count. The row is made at the pair's first message and deleted when
-- the person writes in either session, so a row always counts at least one message.
CREATE TABLE session_exchanges (
  session_id                 TEXT NOT NULL,   -- the lower of the pair's two ids
  peer_session_id            TEXT NOT NULL,   -- the higher; each session's line reads the other
  -- The messages the two traded since the person last wrote in either: a fact each session's row
  -- shows, never a limit.
  messages_since_user_wrote  INTEGER NOT NULL CHECK (messages_since_user_wrote >= 1),
  started_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,   -- the latest message, which picks a session's line
  PRIMARY KEY (session_id, peer_session_id),
  -- An interrupt on either session reads this row to reach the other, so the pair is stored and
  -- the direction of the last message is not.
  CHECK (session_id < peer_session_id)
) STRICT;

CREATE INDEX idx_session_exchanges_peer ON session_exchanges(peer_session_id);

-- Every message addressed to a paused session, in arrival order, delivered one at a time in that
-- order when it continues; each row is deleted in the write that records its delivery, so the
-- table is empty whenever nothing is held.
CREATE TABLE session_paused_message_queue (
  target_session_id  TEXT NOT NULL,     -- the paused session the message is addressed to
  -- Arrival order at the daemon, per target: a counter, never a time, so two arrivals in one
  -- millisecond keep their order.
  arrival_sequence   INTEGER NOT NULL CHECK (arrival_sequence >= 1),
  source_session_id  TEXT NOT NULL,     -- the sending session
  -- The send's own tool event in the sending session's log, which holds the words; no body
  -- column, so the words are never kept twice.
  source_event_id    TEXT NOT NULL,
  arrived_at         TEXT NOT NULL,
  PRIMARY KEY (target_session_id, arrival_sequence),
  -- One hold per send, so a delivery tried again after a restart holds nothing twice.
  UNIQUE (target_session_id, source_event_id)
) STRICT;

-- What each session waits on: one row per awaited session of one waiting call, so the call is
-- answered or woken at the first of them to finish or need the person, and still is after a
-- restart.
CREATE TABLE session_waits (
  session_id          TEXT NOT NULL,   -- the waiting session
  tool_call_id        TEXT NOT NULL,   -- the provider's id of the call that waits
  awaited_session_id  TEXT NOT NULL,
  -- How the caller's provider waits: the call held open, or answered at once and the session
  -- woken later.
  form                TEXT NOT NULL CHECK (form IN ({wait_forms})),
  created_at          TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_call_id, awaited_session_id)
) STRICT;

-- The calls waiting on a session, which its finish or its need of the person wakes.
CREATE INDEX idx_session_waits_awaited ON session_waits(awaited_session_id);

-- Each reminder a session set, kept until it fires, so one due while the daemon was down fires
-- when it is back, naming both when it was set and when it was due.
CREATE TABLE session_reminders (
  id          TEXT PRIMARY KEY,   -- minted, so two reminders set in one millisecond stay two
  session_id  TEXT NOT NULL,
  note        TEXT NOT NULL,      -- the session's own words for what to do when it wakes
  set_at      TEXT NOT NULL,
  due_at      TEXT NOT NULL       -- RFC 3339 UTC, ms precision, so text order is time order
) STRICT;

-- The earliest due of all, which the scheduler's one timer is armed at, and those now due.
CREATE INDEX idx_session_reminders_due ON session_reminders(due_at);
CREATE INDEX idx_session_reminders_session ON session_reminders(session_id);
"
    )
}
