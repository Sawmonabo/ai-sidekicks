use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::event::envelope::{DAEMON_SCOPE_SENTINEL_SESSION_ID, EventOccurredAt};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_store::database::schema::schema_parts;
use sidekicks_store::database::writer::test_file::test_envelope;
use sidekicks_store::events::projection::SessionProjection as _;
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;
use sidekicks_store::events::test_log::{
    AT, SessionTestLog, run_write_statements, stored_envelope,
};

use super::{UsageWindowsProjection, usage_window_projection_statements};
use crate::port::usage_sink::ProviderQuotaWindow;

const ACCOUNT: &str = "account-a";
const FIVE_HOURS: i64 = 300;
const WEEK: i64 = 10_080;
const RESET: &str = "2026-10-14T14:00:00.000Z";
const NEXT_RESET: &str = "2026-10-14T19:00:00.000Z";

/// One reading as the usage record files it: the second it was read, past nine o'clock, whether
/// it is the account's whole set, and its windows.
pub(crate) struct Reading {
    pub(crate) second: u32,
    pub(crate) is_whole_set: bool,
    pub(crate) windows: Vec<ProviderQuotaWindow>,
}

/// A database holding the account [`ACCOUNT`], whose windows the readings fill.
pub(crate) fn log_with_account() -> SessionTestLog {
    let log = SessionTestLog::new(schema_parts());
    log.writer
        .execute(
            "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
               billing_mode, created_at, updated_at)
             VALUES (?1, 'codex', '/homes/a', 'subscription', ?2, ?2)",
            params![ACCOUNT, AT],
        )
        .expect("the test registers its account");
    log
}

/// The events `reading` files: one per window on the sentinel session, each naming the reading's
/// whole set where it is one.
pub(crate) fn file(reading: &Reading) -> Vec<UnsequencedEventEnvelope> {
    let whole_set: Vec<_> = reading.windows.iter().map(window_key).collect();
    reading
        .windows
        .iter()
        .map(|window| {
            let mut payload = window_key(window);
            payload["provider"] = json!("codex");
            payload["providerAccountId"] = json!(ACCOUNT);
            payload["credentialGeneration"] = json!(1);
            payload["usedPercent"] = json!(window.used_percent);
            if let Some(resets_at) = window.resets_at {
                payload["resetsAt"] =
                    json!(resets_at.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
            }
            if reading.is_whole_set {
                payload["wholeSet"] = json!(whole_set);
            }
            let event: SessionEvent = serde_json::from_value(
                json!({"type": "usage.rateLimit.updated", "payload": payload}),
            )
            .expect("the test writes a quota event");
            let mut envelope = test_envelope(*DAEMON_SCOPE_SENTINEL_SESSION_ID, &event);
            envelope.occurred_at =
                EventOccurredAt::new(format!("2026-10-14T09:00:{:02}.000Z", reading.second))
                    .expect("an occurredAt");
            envelope
        })
        .collect()
}

// What names `window` on the wire: its limit, and its length and label where it has them.
fn window_key(window: &ProviderQuotaWindow) -> serde_json::Value {
    let mut key = json!({"limitId": window.limit_id});
    if let Some(window_mins) = window.window_mins {
        key["windowMins"] = json!(window_mins);
    }
    if let Some(label) = &window.label {
        key["label"] = json!(label);
    }
    key
}

/// Writes each event's window as the append's own write does, in order.
pub(crate) fn append(log: &SessionTestLog, envelopes: &[UnsequencedEventEnvelope]) {
    for envelope in envelopes {
        run_write_statements(
            &log.writer,
            &usage_window_projection_statements(envelope).expect("the payload reads"),
        );
    }
}

/// Clears the sentinel session's rows and folds its log again, as the projection rebuild does.
fn rebuild(log: &SessionTestLog, envelopes: &[UnsequencedEventEnvelope]) {
    let sentinel = *DAEMON_SCOPE_SENTINEL_SESSION_ID;
    let mut statements = UsageWindowsProjection.clear_statements(&sentinel);
    let mut fold = UsageWindowsProjection.fold(&sentinel);
    for (sequence, envelope) in envelopes.iter().enumerate() {
        let envelope = stored_envelope(envelope, sequence + 1);
        let event = SessionEvent::from_envelope(&envelope).expect("the event reads");
        fold.apply(&envelope, &event, &mut statements)
            .expect("the fold takes the event");
    }
    run_write_statements(&log.writer, &statements);
}

/// One stored window as [`rows`] answers it: its limit, length and label, then its share used,
/// reset, read time and source.
pub(crate) type StoredRow = (
    String,
    Option<i64>,
    Option<String>,
    f64,
    Option<String>,
    String,
    String,
);

/// Every stored window, by its limit and length.
pub(crate) fn rows(log: &SessionTestLog) -> Vec<StoredRow> {
    let reader = log.reader();
    let mut statement = reader
        .prepare(
            "SELECT limit_id, window_mins, label, used_percent, resets_at, observed_at, source
               FROM provider_account_usage_windows ORDER BY limit_id, window_mins",
        )
        .expect("the read prepares");
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .expect("the rows read")
        .collect::<rusqlite::Result<_>>()
        .expect("each row reads")
}

/// A window of `limit_id`, `window_mins` long, `used_percent` used, resetting at `resets_at`.
pub(crate) fn window(
    limit_id: &str,
    window_mins: i64,
    used_percent: f64,
    resets_at: Option<&str>,
) -> ProviderQuotaWindow {
    ProviderQuotaWindow {
        limit_id: limit_id.to_owned(),
        window_mins: Some(window_mins),
        label: None,
        used_percent,
        resets_at: resets_at.map(|resets_at| resets_at.parse().expect("a reset instant")),
    }
}

fn push(second: u32, windows: Vec<ProviderQuotaWindow>) -> Reading {
    Reading {
        second,
        is_whole_set: false,
        windows,
    }
}

fn whole(second: u32, windows: Vec<ProviderQuotaWindow>) -> Reading {
    Reading {
        second,
        is_whole_set: true,
        windows,
    }
}

// What one stored row reads, as `rows` answers it.
fn row(
    limit_id: &str,
    window_mins: i64,
    used_percent: f64,
    resets_at: Option<&str>,
    second: u32,
    source: &str,
) -> StoredRow {
    (
        limit_id.to_owned(),
        Some(window_mins),
        None,
        used_percent,
        resets_at.map(str::to_owned),
        format!("2026-10-14T09:00:{second:02}.000Z"),
        source.to_owned(),
    )
}

// The readings in order, written as each append writes them, leave the rows; a rebuild of the
// sentinel session's log leaves the same rows, and a rebuild of another session touches none.
// Killed by a whole set that keeps a window it does not name, by a push that deletes one it does
// not name, by ordering on arrival (an older reading displaces a newer one), by a tie that a push
// wins, by the high-water guard dropped (a lower reading inside one reset is stored), by the guard
// freezing a window that reset, and by a clear that deletes every session's rows or none.
#[rstest]
#[case::a_whole_read_replaces_the_set(
    vec![
        push(
            1,
            vec![
                window("session", FIVE_HOURS, 10.0, None),
                window("weekly_all", WEEK, 5.0, None),
            ],
        ),
        whole(2, vec![window("session", FIVE_HOURS, 20.0, None)]),
    ],
    vec![row("session", FIVE_HOURS, 20.0, None, 2, "probe")]
)]
#[case::a_push_merges_into_the_set(
    vec![
        whole(
            1,
            vec![
                window("session", FIVE_HOURS, 10.0, None),
                window("weekly_all", WEEK, 5.0, None),
            ],
        ),
        push(2, vec![window("weekly_all", WEEK, 6.0, None)]),
    ],
    vec![
        row("session", FIVE_HOURS, 10.0, None, 1, "probe"),
        row("weekly_all", WEEK, 6.0, None, 2, "run"),
    ]
)]
#[case::an_older_reading_never_displaces_a_newer_one(
    vec![
        push(5, vec![window("session", FIVE_HOURS, 40.0, Some(RESET))]),
        push(3, vec![window("session", FIVE_HOURS, 70.0, Some(NEXT_RESET))]),
        whole(4, vec![window("session", FIVE_HOURS, 90.0, Some(NEXT_RESET))]),
    ],
    vec![row("session", FIVE_HOURS, 40.0, Some(RESET), 5, "run")]
)]
#[case::on_a_tie_the_limits_read_wins(
    vec![
        whole(5, vec![window("session", FIVE_HOURS, 40.0, None)]),
        push(5, vec![window("session", FIVE_HOURS, 45.0, None)]),
        push(6, vec![window("weekly_all", WEEK, 1.0, None)]),
        push(6, vec![window("weekly_all", WEEK, 2.0, None)]),
    ],
    vec![
        row("session", FIVE_HOURS, 40.0, None, 5, "probe"),
        row("weekly_all", WEEK, 1.0, None, 6, "run"),
    ]
)]
#[case::a_same_window_reading_never_moves_backward(
    vec![
        push(1, vec![window("session", FIVE_HOURS, 80.0, Some(RESET))]),
        whole(2, vec![window("session", FIVE_HOURS, 30.0, Some(RESET))]),
    ],
    vec![row("session", FIVE_HOURS, 80.0, Some(RESET), 1, "run")]
)]
#[case::a_reset_window_starts_low(
    vec![
        push(1, vec![window("session", FIVE_HOURS, 80.0, Some(RESET))]),
        push(2, vec![window("session", FIVE_HOURS, 3.0, Some(NEXT_RESET))]),
    ],
    vec![row("session", FIVE_HOURS, 3.0, Some(NEXT_RESET), 2, "run")]
)]
fn each_reading_leaves_the_newest_window_and_a_rebuild_leaves_the_same(
    #[case] readings: Vec<Reading>,
    #[case] expected: Vec<StoredRow>,
) {
    let log = log_with_account();
    let envelopes: Vec<_> = readings.iter().flat_map(file).collect();

    append(&log, &envelopes);
    let live = rows(&log);
    run_write_statements(
        &log.writer,
        &UsageWindowsProjection.clear_statements(&log.session_id),
    );
    let after_other_clear = rows(&log);
    rebuild(&log, &envelopes);

    assert_eq!(live, expected);
    assert_eq!(
        after_other_clear, expected,
        "another session's clear keeps the windows"
    );
    assert_eq!(rows(&log), expected, "a rebuild leaves the live rows");
}
