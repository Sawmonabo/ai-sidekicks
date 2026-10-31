//! The timed fires a provider keeps for a session: when each holds the session awake and when it
//! wakes the session from its sleep, and their rows, kept so the daemon's next start wakes each
//! session on its schedule. A one-shot fire holds the session until two minutes after it fires; a
//! recurring job lets it sleep and wakes it two minutes before each run, its runs matched in the
//! computer's own time zone.

use std::borrow::Cow;
use std::error::Error;

use croner::parser::{CronParser, Seconds, Year};
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};
use rusqlite::Connection;
use rusqlite::types::Value;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::{NotAnInstant, WireInstant};
use sidekicks_provider::driver::idle_sleep::KeptSchedule;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{optional_text_column, text_column};

/// How long before a fire its session wakes, and how long after a one-shot fire it stays held.
const FIRE_MARGIN: SignedDuration = SignedDuration::from_mins(2);

const SELECT_KEPT_SCHEDULES_SQL: &str = "SELECT session_id, fires_at, cron, next_fire_at
  FROM session_kept_schedules ORDER BY session_id, position";

const SELECT_SESSION_KEPT_SCHEDULES_SQL: &str = "SELECT fires_at, cron, next_fire_at
  FROM session_kept_schedules WHERE session_id = ?1 ORDER BY position";

const DELETE_KEPT_SCHEDULES_SQL: &str =
    "DELETE FROM session_kept_schedules WHERE session_id = @sessionId";

const INSERT_KEPT_SCHEDULE_SQL: &str = "INSERT INTO session_kept_schedules
    (session_id, position, fires_at, cron, next_fire_at)
  VALUES (@sessionId, @position, @firesAt, @cron, @nextFireAt)";

/// Whether `schedule` holds its session awake at `now`: a one-shot fire until two minutes after it
/// fires, a recurring job from two minutes before its next run, so a sleep never lands on a run.
pub(super) fn holds_awake(schedule: &KeptSchedule, now: Timestamp, zone: &TimeZone) -> bool {
    match schedule {
        KeptSchedule::Once { fires_at } => now < shifted(*fires_at, FIRE_MARGIN),
        KeptSchedule::Recurring { .. } => {
            next_fire(schedule, now, zone).is_some_and(|fire| fire <= shifted(now, FIRE_MARGIN))
        }
    }
}

/// The earliest instant one of `schedules` wakes its sleeping session: two minutes before its next
/// fire after `now`; `None` when none fires again.
pub(super) fn next_wake_at(
    schedules: &[KeptSchedule],
    now: Timestamp,
    zone: &TimeZone,
) -> Option<Timestamp> {
    schedules
        .iter()
        .filter_map(|schedule| next_fire(schedule, now, zone))
        .min()
        .map(|fire| shifted(fire, -FIRE_MARGIN))
}

// `instant` moved by `margin`, held at the ends of time.
fn shifted(instant: Timestamp, margin: SignedDuration) -> Timestamp {
    instant
        .saturating_add(margin)
        .expect("a signed duration carries no calendar unit")
}

// The schedule's next fire after `now`: a one-shot fire not yet past, or a recurring job's next
// run, the provider's own figure while it is ahead and its schedule's next match otherwise.
fn next_fire(schedule: &KeptSchedule, now: Timestamp, zone: &TimeZone) -> Option<Timestamp> {
    match schedule {
        KeptSchedule::Once { fires_at } => (*fires_at > now).then_some(*fires_at),
        KeptSchedule::Recurring { cron, next_fire_at } => next_fire_at
            .filter(|fire| *fire > now)
            .or_else(|| next_match(cron, now, zone)),
    }
}

// The first match of `cron`, a five-field schedule, after `now` in `zone`. A schedule that does not
// read fires never, written to the log, since the provider's job then never runs either.
fn next_match(cron: &str, now: Timestamp, zone: &TimeZone) -> Option<Timestamp> {
    let parser = CronParser::builder()
        .seconds(Seconds::Disallowed)
        .year(Year::Disallowed)
        .build();
    let found = parser
        .parse(cron)
        .and_then(|schedule| schedule.find_next_occurrence(&now.to_zoned(zone.clone()), false));
    match found {
        Ok(next) => Some(next.timestamp()),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a recurring job's schedule does not read, so it wakes no sleeping session"
            );
            None
        }
    }
}

/// Every stored kept schedule, by session, in each session's order. Fails when SQLite refuses the
/// read or a stored id or instant does not read.
pub fn read_stored_schedules(
    reader: &Connection,
) -> rusqlite::Result<Vec<(SessionId, KeptSchedule)>> {
    reader
        .prepare_cached(SELECT_KEPT_SCHEDULES_SQL)?
        .query_map([], |row| {
            let session_id = text_column(row, 0, |text| SessionId::new(&text))?;
            Ok((session_id, stored_schedule(row, 1)?))
        })?
        .collect()
}

/// `session_id`'s stored kept schedules, in its order, read by the table's key. Fails when SQLite
/// refuses the read or a stored instant does not read.
pub fn read_session_schedules(
    reader: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<KeptSchedule>> {
    reader
        .prepare_cached(SELECT_SESSION_KEPT_SCHEDULES_SQL)?
        .query_map([session_id.text().as_str()], |row| stored_schedule(row, 0))?
        .collect()
}

// The schedule a row stores in its columns from `first` on: the one-shot fire, the cron and the
// recurring job's next run.
fn stored_schedule(row: &rusqlite::Row<'_>, first: usize) -> rusqlite::Result<KeptSchedule> {
    let fires_at = optional_text_column(row, first, stored_instant)?;
    let cron: Option<String> = row.get(first + 1)?;
    let next_fire_at = optional_text_column(row, first + 2, stored_instant)?;
    Ok(match (fires_at, cron) {
        (Some(fires_at), _) => KeptSchedule::Once { fires_at },
        (None, cron) => KeptSchedule::Recurring {
            cron: cron.expect("the table's check holds a cron where no fire is stored"),
            next_fire_at,
        },
    })
}

/// The statements that replace `session_id`'s stored schedules with `schedules`, in one write. A
/// fire before the year 0000, which no stored instant writes, is left out.
pub(super) fn replace_schedules_statements(
    session_id: SessionId,
    schedules: &[KeptSchedule],
) -> Vec<WriteStatement> {
    let session_text = session_id.text();
    let mut statements = vec![delete_schedules_statement(session_id)];
    for (position, schedule) in schedules.iter().enumerate() {
        let (fires_at, cron, next_fire_at) = match schedule {
            KeptSchedule::Once { fires_at } => {
                let Some(fires_at) = WireInstant::from_timestamp(*fires_at) else {
                    continue;
                };
                (Some(fires_at), None, None)
            }
            KeptSchedule::Recurring { cron, next_fire_at } => (
                None,
                Some(cron.as_str()),
                next_fire_at.and_then(WireInstant::from_timestamp),
            ),
        };
        statements.push(WriteStatement {
            sql: Cow::Borrowed(INSERT_KEPT_SCHEDULE_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@sessionId", session_text.as_str()),
                (
                    Cow::Borrowed("@position"),
                    Value::Integer(
                        i64::try_from(position).expect("a list's position fits an integer"),
                    ),
                ),
                nullable_text_binding("@firesAt", fires_at.as_ref().map(WireInstant::as_str)),
                nullable_text_binding("@cron", cron),
                nullable_text_binding(
                    "@nextFireAt",
                    next_fire_at.as_ref().map(WireInstant::as_str),
                ),
            ]),
            expected_row_count: Some(1),
        });
    }
    statements
}

/// The statement that drops every stored schedule of `session_id`.
pub(super) fn delete_schedules_statement(session_id: SessionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(DELETE_KEPT_SCHEDULES_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@sessionId",
            session_id.text().as_str(),
        )]),
        expected_row_count: None,
    }
}

// A stored instant read back as a timestamp.
fn stored_instant(text: String) -> Result<Timestamp, NotAnInstant> {
    WireInstant::try_from(text)?.timestamp().ok_or(NotAnInstant)
}
