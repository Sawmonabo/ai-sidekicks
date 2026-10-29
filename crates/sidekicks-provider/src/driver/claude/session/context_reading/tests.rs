use std::sync::{Arc, Mutex};

use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::{SessionContextBreakdown, SessionContextReading};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::number::Percent;
use sidekicks_std::port_registration::PortRegistration;

use super::{ClaudeContextReadings, ClaudeSessionReads, compose_claude_context_read, window_row};
use crate::driver::claude::delivery::stream::ClaudeSessionStreams;
use crate::driver::claude::session::transport::declarations::ClaudeMessageUsageObservation;
use crate::port::context_reading_publisher::ContextReadingPublisher;
use crate::port::run_host::test_host::RecordingRunEngine;
use crate::run::delivery::LateAppendableRow;
use crate::usage_delta_accountant::UsageAxisCounts;

#[derive(Default)]
struct RecordingPublisher {
    readings: Mutex<Vec<SessionContextReading>>,
}

impl ContextReadingPublisher for RecordingPublisher {
    fn publish_context_reading(&self, reading: SessionContextReading) {
        self.readings
            .lock()
            .expect("the readings lock")
            .push(reading);
    }
}

fn session_id() -> SessionId {
    SessionId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d").expect("a valid session id")
}

fn percent(value: f64) -> Percent {
    Percent::new(value).expect("a percent")
}

fn reply(total_tokens: u64, max_tokens: u64) -> Box<RawValue> {
    RawValue::from_string(
        json!({
            "categories": [
                {"id": "system_prompt", "name": "System prompt", "tokens": 3_000, "kind": "used"},
                {"id": "system_tools", "name": "System tools", "tokens": 12_000, "kind": "used"},
                {"id": "messages", "name": "Messages", "tokens": 25_000, "kind": "used"},
                {"id": "free_space", "name": "Free space", "tokens": 120_000, "kind": "free"},
            ],
            "totalTokens": total_tokens,
            "maxTokens": max_tokens,
            "rawMaxTokens": max_tokens,
            "autoCompactThreshold": max_tokens / 2,
            "model": "claude-opus-5-5",
        })
        .to_string(),
    )
    .expect("a JSON reply")
}

// Fails when a mid-turn reading is made on a window other than the last read's, so a later read
// leaves a stale figure on the ring, when the stops are not where Claude Code's report puts them,
// when a message's repeated usage files a row again, or when a read whose session was forgotten
// still publishes. Mutations: `hold_read` keeping the first read, or skipping its task check;
// `read_mid_turn` dropping the cache counts or its repeated-message check; the bottom stop leaving
// out the headroom or the fixed-start rows.
#[test]
fn a_mid_turn_reading_is_made_on_the_last_read_and_the_next_read_replaces_it() {
    let publisher = Arc::new(RecordingPublisher::default());
    let registration: PortRegistration<Arc<dyn ContextReadingPublisher>> =
        PortRegistration::new("context readings");
    registration
        .register(Arc::clone(&publisher) as Arc<dyn ContextReadingPublisher>)
        .expect("the publisher registers once");
    let readings = ClaudeContextReadings::new(
        Arc::new(registration),
        Arc::new(RecordingRunEngine::default()),
        Arc::new(ClaudeSessionStreams::default()),
    );
    let run_id = RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a valid run id");
    let usage = |message_id: &str| ClaudeMessageUsageObservation {
        message_id: message_id.to_owned(),
        counts: UsageAxisCounts {
            input: Some(1_000),
            cached_input: Some(30_000),
            cache_write_input: Some(9_000),
            output: Some(500),
            ..UsageAxisCounts::default()
        },
    };
    assert!(
        readings
            .read_mid_turn(session_id(), run_id, &usage("msg-1"))
            .is_none(),
        "no mid-turn reading before the first read"
    );

    // A read under way holds the session, as `request_read` does.
    readings.sessions.lock().expect("the sessions lock").insert(
        session_id(),
        ClaudeSessionReads {
            reading_task: Some(0),
            ..ClaudeSessionReads::default()
        },
    );
    let first = compose_claude_context_read(session_id(), Some(&reply(40_000, 160_000)))
        .expect("a reply naming a window");
    let compaction = &first.reading.compaction;
    assert_eq!(compaction.top_stop_percent, percent(50.0));
    // 15,000 fixed-start tokens of 160,000 is 9.375 %, plus 10 %, rounded up.
    assert_eq!(compaction.bottom_stop_percent, Some(percent(20.0)));
    assert!(readings.hold_read(session_id(), 0, first));

    let Some(LateAppendableRow::UsageContextWindowUpdated(row)) =
        readings.read_mid_turn(session_id(), run_id, &usage("msg-1"))
    else {
        panic!("a mid-turn row");
    };
    assert_eq!(row.window_used_tokens.map(SafeInt::get), Some(40_000));
    assert_eq!(row.window_max_tokens.map(SafeInt::get), Some(160_000));
    assert!(
        readings
            .read_mid_turn(session_id(), run_id, &usage("msg-1"))
            .is_none(),
        "a message's repeated usage files no second row"
    );

    let second = compose_claude_context_read(session_id(), Some(&reply(42_000, 1_000_000)))
        .expect("a reply naming a window");
    assert!(readings.hold_read(session_id(), 0, second));
    let Some(LateAppendableRow::UsageContextWindowUpdated(row)) =
        readings.read_mid_turn(session_id(), run_id, &usage("msg-2"))
    else {
        panic!("a mid-turn row");
    };
    assert_eq!(row.window_max_tokens.map(SafeInt::get), Some(1_000_000));

    readings.forget_session(session_id());
    let stale = compose_claude_context_read(session_id(), Some(&reply(50_000, 1_000_000)))
        .expect("a reply naming a window");
    assert!(
        !readings.hold_read(session_id(), 0, stale),
        "a read under way when its process ended is not held"
    );

    let published = publisher
        .readings
        .lock()
        .expect("the readings lock")
        .clone();
    let used: Vec<_> = published
        .iter()
        .map(|reading| {
            let usage = reading
                .usage
                .as_ref()
                .expect("each reading carries its usage");
            let is_totals = matches!(usage.breakdown, SessionContextBreakdown::Totals { .. });
            (
                usage.used_tokens.get(),
                reading.window_tokens.get(),
                is_totals,
            )
        })
        .collect();
    assert_eq!(
        used,
        [
            (40_000, 160_000, false),
            (40_000, 160_000, true),
            (42_000, 1_000_000, false),
            (40_000, 1_000_000, true),
        ]
    );
}

// Fails when a read whose used tokens reach the window files its row as not exceeded, which
// overwrites the exceeded row the turn's `result` filed. Mutation: `exceeded: false`.
#[test]
fn a_read_at_the_window_files_its_row_exceeded() {
    let run_id = RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a valid run id");
    let exceeded = |total_tokens| {
        let read = compose_claude_context_read(session_id(), Some(&reply(total_tokens, 160_000)))
            .expect("a reply naming a window");
        let LateAppendableRow::UsageContextWindowUpdated(row) = window_row(&read, Some(run_id))
        else {
            panic!("a context-window row");
        };
        row.exceeded
    };

    assert!(exceeded(160_000));
    assert!(!exceeded(159_999));
}
