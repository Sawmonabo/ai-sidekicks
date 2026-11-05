use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Map, Value, json};
use sidekicks_contracts::context_window::ContextWindowSource;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::inspector::SessionContextReading;
use sidekicks_contracts::wire::number::Percent;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    CodexContextWindowReading, CodexFixedStart, CodexReadingSettings, CodexSessionContextReadings,
    LateReading, PublishedReadings, compose_settings_reading, publish_counted,
};
use crate::driver::codex::model_windows::{CodexModelWindow, CodexModelWindows};
use crate::driver::codex::service::home::CodexConversationHome;
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::fixed_session_id;
use crate::port::context_reading_publisher::ContextReadingPublisher;
use crate::runtime_binding::store::{mint_runtime_binding_id, read_binding};
use crate::runtime_binding::test_store::{
    binding_input, open_store, spawn_config_on, spawned_build, test_provider_account_id,
};
use crate::usage_delta_accountant::{UsageAxisCounts, WindowTelemetry};

const MODEL: &str = "gpt-5.5";

fn catalog() -> CodexModelWindows {
    HashMap::from([(
        MODEL.to_owned(),
        CodexModelWindow {
            context_window: Some(272_000),
            max_context_window: Some(1_000_000),
            usable_percent: 95,
            auto_compact_token_limit: None,
        },
    )])
}

fn settings(requested_window: Option<u64>) -> CodexReadingSettings {
    CodexReadingSettings {
        model: MODEL.to_owned(),
        requested_window,
    }
}

#[derive(Default)]
struct CollectedReadings(Mutex<Vec<SessionContextReading>>);

impl ContextReadingPublisher for CollectedReadings {
    fn publish_context_reading(&self, reading: SessionContextReading) {
        self.0
            .lock()
            .expect("no test thread panicked")
            .push(reading);
    }
}

// Before any report the reading's window is the usable share Codex will report, of the window the
// session runs, and its top stop is Codex's own default point, nine tenths of the whole window.
#[rstest::rstest]
#[case::default_window(None, None, 258_400, 244_800)]
#[case::larger_window(Some(1_000_000), None, 950_000, 900_000)]
#[case::calibrated(None, Some(230_000), 258_400, 230_000)]
fn a_reading_before_any_report_carries_the_catalogs_usable_window(
    #[case] requested_window: Option<u64>,
    #[case] calibrated: Option<u64>,
    #[case] window_tokens: u64,
    #[case] top_stop_tokens: u64,
) {
    let reading = compose_settings_reading(
        fixed_session_id(),
        &catalog(),
        &settings(requested_window),
        calibrated,
        Some(window_tokens / 10),
    )
    .expect("the catalog lists the model");
    assert_eq!(reading.window_tokens.get(), window_tokens);
    assert_eq!(reading.usage, None);
    #[expect(
        clippy::cast_precision_loss,
        reason = "the test's counts stay far below 2^52"
    )]
    let top_stop = top_stop_tokens as f64 * 100.0 / window_tokens as f64;
    assert!((reading.compaction.top_stop_percent.get() - top_stop).abs() < 1e-9);
    assert_eq!(
        reading.compaction.bottom_stop_percent.map(Percent::get),
        Some(20.0),
        "the fixed start of a tenth plus a tenth of headroom"
    );
}

// A reading composed off the session's task is dropped once another was published after it began,
// so a report's reading is never replaced by an older one with no usage, and once a later
// settings change began, so a session switched from one model to another never ends on the first
// one's window. Killed by dropping either check from `publish_counted`.
#[test]
fn a_late_reading_never_replaces_a_newer_one() {
    let published = Mutex::new(PublishedReadings::default());
    let collected = CollectedReadings::default();
    let reading = |requested_window| {
        compose_settings_reading(
            fixed_session_id(),
            &catalog(),
            &settings(requested_window),
            None,
            None,
        )
        .expect("the catalog lists the model")
    };
    let late = |published_before, settings_generation| {
        Some(LateReading {
            published_before,
            settings_generation,
        })
    };

    publish_counted(&published, None, &collected, reading(None));
    publish_counted(&published, late(0, 0), &collected, reading(None));
    published
        .lock()
        .expect("no test thread panicked")
        .settings_generation = 2;
    publish_counted(&published, late(1, 1), &collected, reading(None));
    publish_counted(&published, late(1, 2), &collected, reading(Some(1_000_000)));

    assert_eq!(
        *collected.0.lock().expect("no test thread panicked"),
        [reading(None), reading(Some(1_000_000))]
    );
}

// The fixed start is a new conversation's first request's input; a resumed conversation's first
// report, whose total holds its history, leaves it unknown, and so does any report of a resumed
// conversation whose binding kept none. Killed by noting a resumed conversation's start.
#[test]
fn only_the_conversations_first_request_sets_the_fixed_start() {
    let report = |is_conversation_start: bool, input: u64| CodexContextWindowReading {
        thread_id: "thread".to_owned(),
        turn_id: None,
        window: WindowTelemetry::CountsAbsent {
            window_source: ContextWindowSource::ProviderReported,
            exceeded: false,
        },
        breakdown: UsageAxisCounts {
            input: Some(input),
            ..UsageAxisCounts::default()
        },
        is_conversation_start,
    };
    let mut readings =
        CodexSessionContextReadings::new(fixed_session_id(), CodexFixedStart::FirstRequest);
    readings.note_fixed_start(&report(false, 180_000));
    assert_eq!(readings.fixed_start_tokens, None);
    readings.note_fixed_start(&report(true, 12_000));
    readings.note_fixed_start(&report(true, 40_000));
    assert_eq!(readings.fixed_start_tokens, Some(12_000));
    let mut resumed =
        CodexSessionContextReadings::new(fixed_session_id(), CodexFixedStart::Kept(None));
    resumed.note_fixed_start(&report(true, 180_000));
    assert_eq!(resumed.fixed_start_tokens, None);
}

// A first binding keeps the fixed start and the home in the bind's own write, and is marked only
// once a write holding the fixed start succeeded. Killed by writing empty recovery data, which
// fails an account home's first binding on a store failure (step 1); by the composer dropping the
// home, or marking after a write that held no fixed start (step 2); by marking before the write
// (step 3); by the composer dropping the fixed start, or no mark after a write that held it
// (step 4); and by dropping the early return on a marked binding (step 5).
#[tokio::test]
async fn a_first_binding_keeps_the_fixed_start_and_marks_it_once_written() {
    let database = TestDatabase::new(schema_parts());
    let store = open_store(&database).await;
    let recorded = store
        .create(binding_input(
            spawn_config_on(test_provider_account_id()),
            spawned_build("2.0.0", "/opt/provider/2.0.0/bin"),
        ))
        .await
        .expect("the binding is recorded")
        .id;
    let unrecorded = mint_runtime_binding_id();
    let kept_data = || -> Map<String, Value> {
        read_binding(&database.reader(), &recorded)
            .expect("the binding reads")
            .expect("the binding has a row")
            .runtime_metadata
    };
    let kept_on = |readings: &CodexSessionContextReadings| -> Option<RuntimeBindingId> {
        lock(&readings.fixed_start_kept_on).clone()
    };
    let mut readings =
        CodexSessionContextReadings::new(fixed_session_id(), CodexFixedStart::Kept(None));

    readings
        .keep_on_first_binding(&store, &unrecorded, CodexConversationHome::Account)
        .await
        .expect("an account home with no fixed start writes nothing");

    readings
        .keep_on_first_binding(&store, &recorded, CodexConversationHome::Switching)
        .await
        .expect("the home is kept");
    assert_eq!(
        Value::Object(kept_data()),
        json!({ "conversationHome": "switching" })
    );
    assert_eq!(kept_on(&readings), None);

    readings.fixed_start_tokens = Some(12_000);
    readings
        .keep_on_first_binding(&store, &unrecorded, CodexConversationHome::Account)
        .await
        .expect_err("a binding with no row fails the write");
    assert_eq!(kept_on(&readings), None);

    readings
        .keep_on_first_binding(&store, &recorded, CodexConversationHome::Account)
        .await
        .expect("the fixed start is kept");
    assert_eq!(
        Value::Object(kept_data()),
        json!({ "contextFixedStartTokens": 12_000 })
    );
    assert_eq!(kept_on(&readings), Some(recorded.clone()));

    readings.fixed_start_tokens = Some(99);
    readings
        .keep_on_first_binding(&store, &recorded, CodexConversationHome::Account)
        .await
        .expect("a marked binding is not written again");
    assert_eq!(
        Value::Object(kept_data()),
        json!({ "contextFixedStartTokens": 12_000 })
    );
}
