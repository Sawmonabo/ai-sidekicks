use std::collections::HashMap;
use std::sync::Mutex;

use sidekicks_contracts::context_window::ContextWindowSource;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::SessionContextReading;

use super::{
    CodexContextWindowReading, CodexReadingSettings, CodexSessionContextReadings,
    compose_settings_reading, publish_counted,
};
use crate::driver::codex::model_windows::{CodexModelWindow, CodexModelWindows};
use crate::port::context_reading_publisher::ContextReadingPublisher;
use crate::usage_delta_accountant::{UsageAxisCounts, WindowTelemetry};

const MODEL: &str = "gpt-5.5";

fn session_id() -> SessionId {
    SessionId::new("0192f3a4-5b6c-7d8e-9f01-23456789abcd").expect("the text is a UUID")
}

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
        session_id(),
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
        reading
            .compaction
            .bottom_stop_percent
            .map(|bottom| bottom.get()),
        Some(20.0),
        "the fixed start of a tenth plus a tenth of headroom"
    );
}

// A reading composed off the session's task is dropped once another was published after it began,
// so a report's reading is never replaced by an older one with no usage.
#[test]
fn a_late_reading_never_replaces_one_published_after_it_began() {
    let published = Mutex::new(0);
    let collected = CollectedReadings::default();
    let reading = compose_settings_reading(session_id(), &catalog(), &settings(None), None, None)
        .expect("the catalog lists the model");
    let began_at = *published.lock().expect("no test thread panicked");

    publish_counted(&published, None, &collected, reading.clone());
    publish_counted(&published, Some(began_at), &collected, reading);

    assert_eq!(
        collected.0.lock().expect("no test thread panicked").len(),
        1
    );
}

// The fixed start is the conversation's first request's input; a resumed conversation's first
// report, whose total holds its history, leaves it unknown.
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
    let mut readings = CodexSessionContextReadings::new(session_id());
    readings.note_fixed_start(&report(false, 180_000));
    assert_eq!(readings.fixed_start_tokens, None);
    readings.note_fixed_start(&report(true, 12_000));
    readings.note_fixed_start(&report(true, 40_000));
    assert_eq!(readings.fixed_start_tokens, Some(12_000));
}
