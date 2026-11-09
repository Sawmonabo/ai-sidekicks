use serde_json::json;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::orchestration::CHILD_RUN_RESULT_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_store::database::writer::test_file::insert_test_event;

use crate::agent_tree::read::tests::{
    NodeStart, SessionLog, agent_id, at, head, helper_link, run_link,
};
use crate::agents::projection::test_fixture::{binding, project, resolved_run_queued};

// Writes one piece of `run_id`'s provider message `message_id` with `body`, through the log's own
// insert so the piece stands as a row with its stored body.
fn message(session: &mut SessionLog, run_id: RunId, message_id: &str, body: &str, at: &str) {
    let (sequence, _) = insert_test_event(
        &session.connection,
        session.session_id,
        json!({
            "type": "agent.message.sent",
            "payload": {
                "sessionId": session.session_id,
                "runId": run_id,
                "providerMessageId": message_id,
            },
        }),
        Some(body),
        at,
    );
    session.sequence = sequence + 1;
}

fn tool_call(session: &mut SessionLog, run_id: RunId, tool_name: &str, at: &str) {
    session.event(
        SessionEventType::AgentToolCallInvoked,
        &json!({ "runId": run_id, "toolName": tool_name }),
        Some(run_id),
        at,
    );
}

// Writes `run_id`'s terminal record of `event_type` at `occurred_at`, stamped with the run's key as
// the log's terminal rows must be.
fn run_end(
    session: &mut SessionLog,
    event_type: SessionEventType,
    payload: &serde_json::Value,
    run_id: RunId,
    occurred_at: &str,
) {
    session
        .connection
        .execute(
            "INSERT INTO session_events
               (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload,
                run_id, run_version)
             VALUES (?1, ?2, ?3, ?4, ?3, ?5, ?6, ?7, ?8, 2)",
            rusqlite::params![
                mint_uuid_v7().to_string(),
                session.session_id.text().as_str(),
                session.sequence,
                occurred_at,
                event_type.category().as_str(),
                event_type.as_str(),
                payload.to_string(),
                run_id.text().as_str(),
            ],
        )
        .expect("the test writes the terminal row");
    session.sequence += 1;
}

// The person's send `queue_item_id` with `words`, admitted into `run_id`.
fn admitted_send(session: &mut SessionLog, run_id: RunId, queue_item_id: &str, words: &str) {
    session.event(
        SessionEventType::UserMessageSent,
        &json!({ "queueItemId": queue_item_id, "message": words }),
        None,
        &at(1),
    );
    session.event(
        SessionEventType::AgentQueueItemAdmitted,
        &json!({ "queueItemId": queue_item_id, "runId": run_id }),
        None,
        &at(1),
    );
}

// An ended run's head reads its agent's name, the send that started it, its own tool calls, the
// newest of them, the opening of its newest message cut to the cap and when it ended; a live run's
// head reads its tool calls but no end and no result. Killed by the tool count or the activity
// read across runs, by the oldest tool call or message taken for the newest, by a later send taken
// for the ask, by the cut dropped, by a result or an end read for a live run, and by the agent's
// name left out.
#[test]
fn a_run_head_reads_its_tool_calls_activity_result_ask_and_end_from_its_own_log() {
    let mut session = SessionLog::new();
    let lead = session.lead;
    let lead_run = session.run(None, RunState::Running, lead, &at(0));
    let reviewer = agent_id();
    let ended = session.run(
        Some((lead_run, ChildRunProvenance::BridgeRun)),
        RunState::Completed,
        reviewer,
        &at(1),
    );
    project(
        &session.connection,
        session.session_id,
        &resolved_run_queued(
            session.session_id,
            ended.text().as_str(),
            reviewer.text().as_str(),
            &binding(PROVIDERS[0].id, "model-r"),
        ),
    );
    admitted_send(&mut session, ended, "q-1", "Review the diff.");
    admitted_send(&mut session, ended, "q-2", "Also check the docs.");
    tool_call(&mut session, ended, "read", &at(2));
    tool_call(&mut session, ended, "bash", &at(3));
    tool_call(&mut session, lead_run, "grep", &at(4));
    message(&mut session, ended, "m-1", "Looking.", &at(5));
    let final_words = "Two findings, both fixed. ".repeat(200);
    message(&mut session, ended, "m-2", &final_words, &at(6));
    run_end(
        &mut session,
        SessionEventType::AgentRunCompleted,
        &json!({ "runId": ended }),
        ended,
        &at(9),
    );
    let live = session.run(
        Some((lead_run, ChildRunProvenance::WorkflowStep)),
        RunState::Running,
        lead,
        &at(10),
    );
    tool_call(&mut session, live, "edit", &at(11));
    message(&mut session, live, "m-3", "Halfway.", &at(12));

    let tree = session.read();
    let ended_head = head(run_link(&tree, ended));
    assert_eq!(
        ended_head.agent_name.as_ref().map(FreeFormText::as_str),
        Some("reviewer")
    );
    assert_eq!(
        ended_head.ask.as_ref().map(FreeFormText::as_str),
        Some("Review the diff."),
        "the send that started it"
    );
    assert_eq!(ended_head.tool_count.get(), 2, "its own calls only");
    assert_eq!(
        ended_head
            .activity
            .as_ref()
            .map(|activity| activity.tool_name.as_str()),
        Some("bash")
    );
    let cut: String = final_words.chars().take(CHILD_RUN_RESULT_MAX_LEN).collect();
    assert_eq!(
        ended_head.result.as_ref().map(FreeFormText::as_str),
        Some(cut.as_str()),
        "its newest message, cut to the cap"
    );
    assert_eq!(
        ended_head.ended_at.as_ref().map(WireInstant::as_str),
        Some(at(9).as_str())
    );
    assert_eq!(ended_head.failure_reason, None);

    let live_head = head(run_link(&tree, live));
    assert_eq!(live_head.tool_count.get(), 1);
    assert_eq!(
        live_head
            .activity
            .as_ref()
            .map(|activity| activity.tool_name.as_str()),
        Some("edit")
    );
    assert_eq!(live_head.result, None, "a live run has no result yet");
    assert_eq!(live_head.ended_at, None);
    assert_eq!(live_head.ask, None, "no send started it");
}

// A failed child's head carries the cause and the provider's words its failure recorded. Killed
// by the failure record read as a plain end, by the cause or the words dropped, and by the end's
// instant read from another row.
#[test]
fn a_failed_child_carries_its_reason() {
    let mut session = SessionLog::new();
    let lead = session.lead;
    let lead_run = session.run(None, RunState::Running, lead, &at(0));
    let failed = session.run(
        Some((lead_run, ChildRunProvenance::WorkflowStep)),
        RunState::Failed,
        lead,
        &at(1),
    );
    run_end(
        &mut session,
        SessionEventType::AgentRunFailed,
        &json!({
            "runId": failed,
            "failureCause": { "cause": "retriesExhausted", "origin": "provider" },
            "providerFailureDetail": "The service is overloaded.",
        }),
        failed,
        &at(4),
    );

    let tree = session.read();
    let failed_head = head(run_link(&tree, failed));
    assert_eq!(
        serde_json::to_value(&failed_head.failure_reason).expect("the reason serializes"),
        json!({
            "failureCause": { "cause": "retriesExhausted", "origin": "provider" },
            "providerFailureDetail": "The service is overloaded.",
        })
    );
    assert_eq!(
        failed_head.ended_at.as_ref().map(WireInstant::as_str),
        Some(at(4).as_str())
    );
}

// A provider helper's head names it as its provider did, else by the role it started in, and
// carries the ask its start named; its end and activity are its own run's. Killed by the role
// put before the name, by the role fallback dropped, by the ask dropped, and by the end or the
// activity read for the helper's parent run.
#[test]
fn a_provider_helpers_head_carries_its_name_ask_and_end() {
    let mut session = SessionLog::new();
    let lead = session.lead;
    let lead_run = session.run(None, RunState::Running, lead, &at(0));
    let named_run = session.own_run(lead_run, "h1", RunState::Completed, &at(1));
    let named = session.node_on(
        named_run,
        "h1",
        None,
        &at(1),
        &NodeStart {
            name: Some("explorer"),
            role: Some("worker"),
            ask: Some("Map the auth module."),
            ..NodeStart::default()
        },
    );
    tool_call(&mut session, named_run, "read", &at(2));
    tool_call(&mut session, lead_run, "bash", &at(3));
    run_end(
        &mut session,
        SessionEventType::AgentRunCompleted,
        &json!({ "runId": named_run }),
        named_run,
        &at(5),
    );
    let role_run = session.own_run(lead_run, "h2", RunState::Running, &at(6));
    let role_only = session.node_on(
        role_run,
        "h2",
        None,
        &at(6),
        &NodeStart {
            role: Some("general-purpose"),
            ..NodeStart::default()
        },
    );

    let tree = session.read();
    let named_head = head(helper_link(&tree, &named));
    assert_eq!(
        named_head.agent_name.as_ref().map(FreeFormText::as_str),
        Some("explorer")
    );
    assert_eq!(
        named_head.ask.as_ref().map(FreeFormText::as_str),
        Some("Map the auth module.")
    );
    assert_eq!(named_head.tool_count.get(), 1);
    assert_eq!(
        named_head
            .activity
            .as_ref()
            .map(|activity| activity.tool_name.as_str()),
        Some("read")
    );
    assert_eq!(
        named_head.ended_at.as_ref().map(WireInstant::as_str),
        Some(at(5).as_str())
    );

    let role_head = head(helper_link(&tree, &role_only));
    assert_eq!(
        role_head.agent_name.as_ref().map(FreeFormText::as_str),
        Some("general-purpose")
    );
    assert_eq!(role_head.ask, None);
    assert_eq!(role_head.ended_at, None);
}
