use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::mcp::server::McpServerStatus;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

use crate::driver::codex::session::state::CodexTurnInput;
use crate::driver::codex::session::test_fixture::status_sink::{
    CountingStatusSink, mcp_server_startup,
};
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};
use crate::driver::mcp_server::status::McpServerReading;
use crate::usage_delta_accountant::UsageAxisCounts;

// The other conversation is one the session moved off while a command of it runs, which the
// router still routes as the session's own. Killed by reporting a startup by its method alone,
// or by its route alone: the left conversation's server would reach the sink.
#[tokio::test(start_paused = true)]
async fn only_a_startup_on_the_sessions_own_conversation_reaches_its_status_sink() {
    let mut session = TestCodexSession::start().await;
    let sink = Arc::new(CountingStatusSink::default());
    session.task.record.on_mcp_server_status = Some(Arc::clone(&sink) as _);
    session
        .task
        .routing
        .hold_thread("thread-left".to_owned(), true);

    session
        .task
        .handle(mcp_server_startup("thread-left", "left", "ready", None))
        .await;
    session
        .task
        .handle(mcp_server_startup(TEST_THREAD, "github", "ready", None))
        .await;

    let reported = sink.reported();
    let names: Vec<&str> = reported
        .iter()
        .map(|emission| emission.server_name.as_str())
        .collect();
    assert_eq!(names, ["github"]);
}

// One startup round lists once, after its last server settles, every page, each server with
// its tools and with its startup's status and text, so a failed server keeps its reason; a
// settle outside the round lists nothing. Killed by listing while a server of the round still
// starts, by the list's second page dropped, by the listed tools dropped, by the list's status
// or its empty text replacing the startup's, and by listing again on a settle outside the
// round.
#[tokio::test(start_paused = true)]
async fn a_startup_round_lists_its_servers_once_keeping_each_startups_status() {
    let mut session = TestCodexSession::start().await;
    let sink = Arc::new(CountingStatusSink::default());
    session.task.record.on_mcp_server_status = Some(Arc::clone(&sink) as _);

    for inbound in [
        mcp_server_startup(TEST_THREAD, "github", "starting", None),
        mcp_server_startup(TEST_THREAD, "docs", "starting", None),
        mcp_server_startup(TEST_THREAD, "github", "ready", None),
    ] {
        session.task.handle(inbound).await;
    }
    let script = &mut session.scripted.script;
    let answer = async {
        let first = script.next_sent().await;
        assert_eq!(first["method"], "mcpServerStatus/list");
        assert_eq!(
            first["params"],
            json!({"threadId": TEST_THREAD, "detail": "toolsAndAuthOnly"})
        );
        script.answer(
            &first,
            &json!({
                "data": [{"name": "github", "runtimeStatus": "connected", "tools": {
                    "search": {"name": "search"}
                }}],
                "nextCursor": "page-2"
            }),
        );
        let second = script.next_sent().await;
        assert_eq!(second["params"]["cursor"], "page-2");
        script.answer(
            &second,
            &json!({"data": [{"name": "docs", "runtimeStatus": "failed", "tools": {
                "read": {"name": "read"}
            }}]}),
        );
    };
    tokio::join!(
        session.task.handle(mcp_server_startup(
            TEST_THREAD,
            "docs",
            "failed",
            Some("handshake timed out")
        )),
        answer
    );

    let listed: Vec<_> = sink.reported()[4..]
        .iter()
        .map(|emission| {
            (
                emission.server_name.as_str().to_owned(),
                emission.reading,
                emission.failure_text.clone(),
                emission
                    .tool_names
                    .as_ref()
                    .map(|names| names.iter().map(|name| name.as_str().to_owned()).collect()),
            )
        })
        .collect();
    assert_eq!(
        listed,
        [
            (
                "github".to_owned(),
                McpServerReading::Observed(McpServerStatus::Connected),
                None,
                Some(vec!["search".to_owned()])
            ),
            (
                "docs".to_owned(),
                McpServerReading::Observed(McpServerStatus::Failed),
                Some("handshake timed out".to_owned()),
                Some(vec!["read".to_owned()])
            ),
        ]
    );

    session
        .task
        .handle(mcp_server_startup(TEST_THREAD, "reused", "ready", None))
        .await;
    let script = &mut session.scripted.script;
    assert!(
        tokio::time::timeout(Duration::from_secs(1), script.next_sent())
            .await
            .is_err(),
        "a settle outside the round listed again"
    );
}

// The thread runs `gpt-5.4`; the kept turn `turn-1` was sent at `gpt-5.5`, and `turn-daemon`, one
// the daemon started, keeps no input. Each case reads its reading's tier, thread tier and model.
// A restored helper's reading names the model its conversation's `thread/read` gives.
// Killed by the thread's tier on a per-turn request, by the per-turn tier as the thread's, by no
// fallback to the thread's tier or model, by a made-up tier where none was declared, by a reroute
// not applied or applied only when its row has a run, by a root turn's tier or model on a helper's
// reading, and by a restored helper's model never read.
#[rstest]
#[case::turn_sent_at_its_own_tier(
    Some("default"), Some("priority"), "turn-1", None, false,
    (Some("priority"), Some("default"), Some("gpt-5.5"))
)]
#[case::turn_the_daemon_started(
    Some("default"), Some("priority"), "turn-daemon", None, false,
    (Some("default"), Some("default"), Some("gpt-5.4"))
)]
#[case::no_tier_declared_or_sent(
    None, None, "turn-1", None, false,
    (None, None, Some("gpt-5.5"))
)]
#[case::rerouted_turn_with_no_run(
    Some("default"), Some("priority"), "turn-1", Some("gpt-5.5-cyber"), false,
    (Some("priority"), Some("default"), Some("gpt-5.5-cyber"))
)]
#[case::restored_helper_naming_the_kept_turn(
    Some("default"), Some("priority"), "turn-1", None, true,
    (Some("default"), Some("default"), Some("gpt-5.4-mini"))
)]
#[tokio::test(start_paused = true)]
async fn a_usage_reading_carries_its_turns_tier_the_threads_tier_and_its_model(
    #[case] declared: Option<&str>,
    #[case] sent: Option<&str>,
    #[case] named_turn: &str,
    #[case] rerouted_to: Option<&str>,
    #[case] is_helper: bool,
    #[case] expected: (Option<&str>, Option<&str>, Option<&str>),
) {
    let mut session = TestCodexSession::start().await;
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let task = &mut session.task;
    task.record.thread_settings.model = "gpt-5.4".to_owned();
    task.record.declared_output_speed = declared.map(|word| ProviderOutputSpeedState {
        declared: FreeFormText::new(word.to_owned()).expect("a tier word is text"),
        reason: None,
    });
    task.record.turn_input_by_turn_id.insert(
        "turn-1".to_owned(),
        CodexTurnInput {
            messages: Vec::new(),
            client_message_ids: Vec::new(),
            output_speed_for_turn: sent.map(str::to_owned),
            sent_output_speed_for_turn: sent.map(str::to_owned),
            model: "gpt-5.5".to_owned(),
        },
    );
    if let Some(to_model) = rerouted_to {
        let reroute = json!({
            "threadId": TEST_THREAD, "turnId": named_turn, "fromModel": "gpt-5.5",
            "toModel": to_model, "reason": "highRiskCyberActivity"
        });
        task.routing
            .route_notification(
                &delivery,
                &mut task.record,
                "model/rerouted".to_owned(),
                raw(&reroute),
            )
            .await;
    }
    let reading_thread = if is_helper {
        let script = &mut session.scripted.script;
        let answer_read = async {
            let read = script.next_sent().await;
            assert_eq!(read["method"], "thread/read", "{read}");
            assert_eq!(read["params"]["threadId"], "helper-1", "{read}");
            script.answer(
                &read,
                &json!({"thread": {"id": "helper-1", "model": "gpt-5.4-mini"}}),
            );
        };
        tokio::join!(
            task.routing.restore_helper_thread(
                &delivery,
                &mut task.record,
                "helper-1".to_owned(),
                UsageAxisCounts::default(),
            ),
            answer_read
        );
        "helper-1"
    } else {
        TEST_THREAD
    };
    let usage = json!({
        "threadId": reading_thread, "turnId": named_turn,
        "tokenUsage": {"total": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}
    });

    let routed = task
        .routing
        .route_notification(
            &delivery,
            &mut task.record,
            "thread/tokenUsage/updated".to_owned(),
            raw(&usage),
        )
        .await;

    let request = &routed
        .metered_usage
        .last()
        .expect("the reading metered")
        .request;
    assert_eq!(
        (
            request.speed.as_ref().map(BoundedText::as_str),
            request.thread_speed.as_ref().map(BoundedText::as_str),
            request.model_id.as_ref().map(FreeFormText::as_str),
        ),
        expected
    );
}

// A notification's params as the wire carries them.
fn raw(params: &Value) -> Box<RawValue> {
    RawValue::from_string(params.to_string()).expect("the params are JSON")
}
