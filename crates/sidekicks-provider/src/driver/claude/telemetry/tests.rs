use std::sync::Arc;
use std::time::Duration;

use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use tokio::sync::watch;

use super::{CLAUDE_EXPORT_INTERVAL, ClaudeExportRegistration, ClaudeExports};
use crate::bounded_poll::poll_until;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::pricing::ClaudeRequestPricer;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::scripted::daemon_services::RecordingUsage;
use crate::driver::diagnostics::RecordedEvents;
use crate::driver::ports::DriverPorts;
use crate::port::usage_sink::MeteredUsageOwner;
use crate::pricing::live::LivePricing;
use crate::pricing::receiver::bearers::TelemetryHolderId;
use crate::pricing::receiver::records::read_unix_time_ms;
use crate::pricing::receiver::{TelemetryExport, TelemetryExportReader as _};
use crate::usage_delta_accountant::{UsageAxisCounts, UsageRequestFacts, meter_from_zero};

const PROVIDER_SESSION: &str = "claude-session-a";
const OTHER_PROVIDER_SESSION: &str = "claude-session-b";
const MODEL: &str = "claude-sonnet-5";
const NANOS_PER_MILLI: u64 = 1_000_000;

// Wall-clock milliseconds apart, so two marks the routes and the results stamp are ordered.
const WALL_STEP: Duration = Duration::from_millis(3);

// The four identity attributes Claude Code puts on every record, each with a value a leak shows.
const IDENTITY: [(&str, &str); 4] = [
    ("user.email", "identity-email-value"),
    ("user.account_id", "identity-account-value"),
    ("user.account_uuid", "identity-uuid-value"),
    ("organization.id", "identity-organization-value"),
];

// One driver's register over a recorded usage sink, its scheduler and its routes.
struct Register {
    scheduler: Arc<Scheduler>,
    usage: Arc<RecordingUsage>,
    exports: Arc<ClaudeExports>,
    routes: Arc<ClaudeRunRoutes>,
}

impl Register {
    fn new() -> Self {
        let scheduler = Arc::new(Scheduler::start(
            Arc::new(TestWallClock::default()),
            None,
            watch::channel(0).1,
        ));
        let usage = Arc::new(RecordingUsage::default());
        let ports = DriverPorts::new();
        ports
            .usage
            .register(Arc::clone(&usage) as _)
            .expect("the usage port registers once");
        let pricing = Arc::new(LivePricing::new(
            DESCRIPTOR.provider_id(),
            Arc::new(ClaudeRequestPricer),
            &ports,
        ));
        let exports = Arc::new(ClaudeExports::new(
            Arc::clone(&scheduler),
            Arc::clone(&ports.usage),
            pricing,
        ));
        Self {
            scheduler,
            usage,
            exports,
            routes: Arc::new(ClaudeRunRoutes::default()),
        }
    }

    // Registers process `holder` running `provider_session` for `session_id`.
    fn register(
        &self,
        holder: u64,
        session_id: SessionId,
        provider_session: &str,
    ) -> ClaudeExportRegistration {
        self.exports.register(
            TelemetryHolderId::new(holder),
            session_id,
            provider_session.to_owned(),
            Arc::clone(&self.routes),
        )
    }

    // Hands `export` to the reader as the receiver does for `holder`, and lets its filing run.
    async fn export(&self, holder: u64, export: TelemetryExport) {
        self.exports
            .read_telemetry_export(TelemetryHolderId::new(holder), export)
            .await;
        tokio::task::yield_now().await;
    }

    // The request keys of every row metered so far, with their binding and owner.
    fn metered(&self) -> Vec<(String, RuntimeBindingId, MeteredUsageOwner)> {
        self.usage
            .metered()
            .into_iter()
            .map(|metered| {
                let key = metered.delta.request.request_key.expect("a request key");
                (key.as_str().to_owned(), metered.binding_id, metered.owner)
            })
            .collect()
    }

    // How many export checks the scheduler holds.
    fn export_checks(&self) -> usize {
        self.scheduler
            .waiting_job_names()
            .into_iter()
            .filter(|name| *name == "telemetry export check")
            .count()
    }
}

fn session() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

fn run() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
}

fn binding(name: &str) -> RuntimeBindingId {
    RuntimeBindingId::new(name.to_owned()).expect("a binding id")
}

fn text(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue {
            value: Some(Value::StringValue(value.to_owned())),
        }),
        ..Default::default()
    }
}

fn count(key: &str, value: i64) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue {
            value: Some(Value::IntValue(value)),
        }),
        ..Default::default()
    }
}

// The attributes a request's record or span shares: its session, id, model and counts, and the
// four identity attributes.
fn request_attributes(provider_session: &str, request_id: &str) -> Vec<KeyValue> {
    let mut attributes = vec![
        text("session.id", provider_session),
        text("request_id", request_id),
        text("model", "claude-sonnet-5[1m]"),
        count("input_tokens", 100),
        count("output_tokens", 20),
        count("cache_read_tokens", 0),
        count("cache_creation_tokens", 0),
    ];
    attributes.extend(IDENTITY.map(|(key, value)| text(key, value)));
    attributes
}

// The `claude_code.llm_request` span of `request_id`, run at `at_ms` in the interaction `trace`.
fn llm_span(provider_session: &str, request_id: &str, at_ms: u64, trace: u8) -> Span {
    Span {
        trace_id: vec![trace; 16],
        name: "claude_code.llm_request".to_owned(),
        start_time_unix_nano: at_ms * NANOS_PER_MILLI,
        end_time_unix_nano: at_ms * NANOS_PER_MILLI,
        attributes: request_attributes(provider_session, request_id),
        ..Default::default()
    }
}

// The `claude_code.interaction` span of the prompt numbered `sequence`, in the trace `trace`.
fn interaction_span(sequence: i64, trace: u8) -> Span {
    Span {
        trace_id: vec![trace; 16],
        name: "claude_code.interaction".to_owned(),
        attributes: vec![count("interaction.sequence", sequence)],
        ..Default::default()
    }
}

// The `api_request` record of `request_id`, stamped at `at_ms`.
fn api_record(request_id: &str, at_ms: u64) -> LogRecord {
    let mut attributes = request_attributes(PROVIDER_SESSION, request_id);
    attributes.push(text("event.name", "api_request"));
    LogRecord {
        time_unix_nano: at_ms * NANOS_PER_MILLI,
        attributes,
        ..Default::default()
    }
}

fn traces(spans: Vec<Span>) -> TelemetryExport {
    TelemetryExport::Traces(ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(Resource::default()),
            scope_spans: vec![ScopeSpans {
                spans,
                ..Default::default()
            }],
            ..Default::default()
        }],
    })
}

fn logs(records: Vec<LogRecord>) -> TelemetryExport {
    TelemetryExport::Logs(ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(Resource::default()),
            scope_logs: vec![ScopeLogs {
                log_records: records,
                ..Default::default()
            }],
            ..Default::default()
        }],
    })
}

// Now by the wall clock, after a step, so it is later than every mark taken before.
fn wall_after_step() -> u64 {
    std::thread::sleep(WALL_STEP);
    read_unix_time_ms()
}

// A lone span begun in run 2's turn, whose interaction says prompt 3, beside a request with its
// record and span in run 1's turn: after the result, nothing until two intervals past the
// export, then the lone span once on run 2's binding, and the recorded one never, the process's
// end included. Killed by deciding at the result or before two intervals, by pricing a request
// its record puts inside Claude Code's figure, by joining on the sequence, and by pricing a
// request twice.
#[tokio::test(start_paused = true)]
async fn a_lone_span_is_priced_once_after_two_intervals_on_the_run_live_at_its_start() {
    let register = Register::new();
    let session_id = session();
    let (first, second) = (run(), run());
    let _registration = register.register(1, session_id, PROVIDER_SESSION);
    register
        .routes
        .hold_turn(first, session_id, binding("binding-1"))
        .expect("the turn is free");
    let recorded_at = wall_after_step();
    register.routes.unbind_run(first);
    std::thread::sleep(WALL_STEP);
    register
        .routes
        .hold_turn(second, session_id, binding("binding-2"))
        .expect("the turn was released");
    let lone_at = wall_after_step();
    std::thread::sleep(WALL_STEP);
    register.exports.result_stated(TelemetryHolderId::new(1));

    register
        .export(
            1,
            traces(vec![
                llm_span(PROVIDER_SESSION, "req-recorded", recorded_at, 1),
                llm_span(PROVIDER_SESSION, "req-lone", lone_at, 2),
                interaction_span(3, 2),
            ]),
        )
        .await;
    register
        .export(1, logs(vec![api_record("req-recorded", recorded_at)]))
        .await;
    assert!(register.metered().is_empty(), "nothing is decided at once");

    tokio::time::advance((CLAUDE_EXPORT_INTERVAL * 2).saturating_sub(Duration::from_millis(1)))
        .await;
    register.export(1, logs(Vec::new())).await;
    assert!(
        register.metered().is_empty(),
        "two intervals have not passed"
    );

    tokio::time::advance(Duration::from_millis(1)).await;
    register.export(1, logs(Vec::new())).await;
    poll_until(|| register.metered().len(), |rows| *rows >= 1).await;
    register
        .exports
        .process_ended(TelemetryHolderId::new(1), true)
        .await;
    assert_eq!(
        register.metered(),
        [(
            "req-lone".to_owned(),
            binding("binding-2"),
            MeteredUsageOwner::Run
        )]
    );
}

// Result 1 states R1; R2's record and span come after it and the process exits with no second
// result: R2 is priced once at the end and R1 never. Killed by deciding only at a result (R2
// never priced) and by pricing every request (R1 priced too).
#[tokio::test(start_paused = true)]
async fn a_call_after_the_last_result_is_priced_once_at_the_process_end() {
    let register = Register::new();
    let session_id = session();
    let _registration = register.register(1, session_id, PROVIDER_SESSION);
    register
        .routes
        .hold_turn(run(), session_id, binding("binding-1"))
        .expect("the turn is free");
    let first_at = wall_after_step();
    std::thread::sleep(WALL_STEP);
    register.exports.result_stated(TelemetryHolderId::new(1));
    let second_at = wall_after_step();

    register
        .export(
            1,
            logs(vec![
                api_record("req-1", first_at),
                api_record("req-2", second_at),
            ]),
        )
        .await;
    register
        .export(
            1,
            traces(vec![
                llm_span(PROVIDER_SESSION, "req-1", first_at, 1),
                llm_span(PROVIDER_SESSION, "req-2", second_at, 1),
            ]),
        )
        .await;
    tokio::time::advance(CLAUDE_EXPORT_INTERVAL * 3).await;
    register.export(1, logs(Vec::new())).await;
    assert!(register.metered().is_empty(), "no result states R2");

    register
        .exports
        .process_ended(TelemetryHolderId::new(1), true)
        .await;
    assert_eq!(
        register.metered(),
        [(
            "req-2".to_owned(),
            binding("binding-1"),
            MeteredUsageOwner::Run
        )]
    );
}

// A priced request's line names its request but carries none of the four identity attributes,
// neither key nor value. Killed by logging the whole record, and by logging no line.
#[tokio::test]
async fn a_priced_request_s_log_line_carries_no_identity_attribute() {
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();
    let register = Register::new();
    let session_id = session();
    let _registration = register.register(1, session_id, PROVIDER_SESSION);
    register
        .routes
        .hold_turn(run(), session_id, binding("binding-1"))
        .expect("the turn is free");
    let at_ms = wall_after_step();
    register
        .export(
            1,
            traces(vec![llm_span(PROVIDER_SESSION, "req-logged", at_ms, 1)]),
        )
        .await;
    register
        .exports
        .process_ended(TelemetryHolderId::new(1), true)
        .await;

    assert_eq!(register.metered().len(), 1);
    assert!(
        recorded
            .messages()
            .iter()
            .any(|message| message == "claude code request read for price")
    );
    let texts = recorded.texts().join("\n");
    assert!(texts.contains("req-logged"));
    for (key, value) in IDENTITY {
        assert!(!texts.contains(key), "the log names {key}");
        assert!(!texts.contains(value), "the log carries {key}'s value");
    }
}

// Process A's export naming process B's session is refused and counted and priced nowhere,
// while B's own request is priced on B's session. Killed by finding the process by the record's
// session (A's foreign span priced on B) and by trusting the bearer alone (priced on A).
#[tokio::test]
async fn a_record_under_one_process_s_bearer_naming_another_s_session_is_dropped_and_counted() {
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();
    let register = Register::new();
    let (session_a, session_b) = (session(), session());
    let _registration_a = register.register(1, session_a, PROVIDER_SESSION);
    let _registration_b = register.register(2, session_b, OTHER_PROVIDER_SESSION);
    register
        .routes
        .hold_turn(run(), session_a, binding("binding-a"))
        .expect("A's turn is free");
    register
        .routes
        .hold_turn(run(), session_b, binding("binding-b"))
        .expect("B's turn is free");
    let at_ms = wall_after_step();

    register
        .export(
            1,
            traces(vec![llm_span(
                OTHER_PROVIDER_SESSION,
                "req-foreign",
                at_ms,
                1,
            )]),
        )
        .await;
    register
        .export(
            2,
            traces(vec![llm_span(OTHER_PROVIDER_SESSION, "req-own", at_ms, 2)]),
        )
        .await;
    for holder in [1, 2] {
        register
            .exports
            .process_ended(TelemetryHolderId::new(holder), true)
            .await;
    }

    let refused = recorded
        .counters()
        .iter()
        .filter(|counter| *counter == "driver.telemetry.recordRefused")
        .count();
    assert_eq!(refused, 1);
    let sessions: Vec<SessionId> = register
        .usage
        .metered()
        .into_iter()
        .map(|metered| metered.session_id)
        .collect();
    assert_eq!(sessions, [session_b]);
    assert_eq!(register.metered()[0].0, "req-own");
}

// The export status' budget: at most one export check per process, none while idle. Killed by a
// check per turn (2 after two request turns), a check on a turn with no request (1 after the
// first), and an export that leaves the check armed (1 after it).
#[tokio::test(start_paused = true)]
async fn a_process_holds_one_export_check_only_while_request_turns_wait_for_an_export() {
    let register = Register::new();
    let holder = TelemetryHolderId::new(1);
    let _registration = register.register(1, session(), PROVIDER_SESSION);
    let message = meter_from_zero(
        DESCRIPTOR.provider_id(),
        PROVIDER_SESSION.to_owned(),
        UsageAxisCounts {
            input: Some(10),
            output: Some(2),
            ..UsageAxisCounts::default()
        },
        UsageRequestFacts {
            model_id: Some(FreeFormText::new(MODEL.to_owned()).expect("a model id")),
            ..UsageRequestFacts::default()
        },
    );
    assert_eq!(register.export_checks(), 0);

    register.exports.result_stated(holder);
    assert_eq!(register.export_checks(), 0);

    for _ in 0..2 {
        register.exports.streamed(holder, &message);
        register.exports.result_stated(holder);
    }
    assert_eq!(register.export_checks(), 1);

    register.export(1, logs(Vec::new())).await;
    assert_eq!(register.export_checks(), 0);

    // A turn begun after the export, so the export does not count for it.
    tokio::time::advance(Duration::from_millis(2)).await;
    register.exports.streamed(holder, &message);
    register.exports.result_stated(holder);
    assert_eq!(register.export_checks(), 1);
}
