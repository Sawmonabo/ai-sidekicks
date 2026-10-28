use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::command::{AgentCommandEndedPayload, CommandEnding};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::mpsc;

use super::apart_run::ClaudeApartRunCommands;
use super::{ClaudeCommandFact, ClaudeCommandTasks, ClaudeTaskFrame};
use crate::command::running_set::{CommandEndingAppender, RunningCommandSets};
use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::session::answered_commands::{
    ClaudeOutputStyleDescriptions, read_claude_command_choices,
};
use crate::driver::claude::session::transport::readings::{
    ClaudeCreationFiguresReading, ClaudeLocalCommandReply, ClaudeReplyReserveReads,
};
use crate::port::running_command_publisher::{ReseedScope, RunningCommandPublisher as _};

fn session_id() -> SessionId {
    SessionId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d").expect("a valid session id")
}

fn run_id() -> RunId {
    RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a valid run id")
}

fn read(
    tasks: &mut ClaudeCommandTasks,
    kind: &ClaudeWireFrameKind,
    frame: &Value,
) -> Option<ClaudeCommandFact> {
    let frame = ClaudeTaskFrame::read(&frame.to_string()).expect("a task frame");
    tasks.read_frame(kind, &frame, session_id(), Some(run_id()))
}

fn started(task_id: &str, task_type: &str, tool_use_id: &str) -> Value {
    json!({
        "type": "system",
        "subtype": "task_started",
        "task_id": task_id,
        "task_type": task_type,
        "tool_use_id": tool_use_id,
        "description": "Run the tests",
        "is_backgrounded": true,
    })
}

// Fails when a cause of Claude Code's own stop is read as an ordinary end, so the row reads
// finished, or its summary is dropped; when a completed task reads as stopped; or when a row's line
// is not the text Claude Code's shell line runs, so no wrapper pairs with it. Mutations: in
// `ClaudeCommandTasks::read_frame`, `is_stopped_by_provider` read off `reason`, or `false`; the
// summary kept for every status; `line` set to the raw command.
#[rstest]
#[case::time_limit("stopped", None, true)]
#[case::agents_task_stop("stopped", None, true)]
#[case::worker_restart("stopped", Some("worker_restart"), true)]
#[case::completed("completed", None, false)]
fn a_stopped_command_task_ends_stopped_by_the_provider_with_its_summary(
    #[case] status: &str,
    #[case] reason: Option<&str>,
    #[case] is_stopped: bool,
) {
    let mut tasks = ClaudeCommandTasks::default();
    let call = json!({"message": {"content": [{
        "type": "tool_use",
        "id": "call-1",
        "name": "Bash",
        "input": {"command": "npm test > nul"},
    }]}});
    tasks.observe_calls(&serde_json::from_value::<ClaudeMessageFrame>(call).expect("a frame"));

    let Some(ClaudeCommandFact::Started(start)) = read(
        &mut tasks,
        &ClaudeWireFrameKind::SystemTaskStarted,
        &started("task-1", "local_bash", "call-1"),
    ) else {
        panic!("a shell task starts a row");
    };
    assert_eq!(start.line.as_deref(), Some("npm test > /dev/null"));
    assert_eq!(tasks.tool_use_id_of("task-1").as_deref(), Some("call-1"));

    let mut notification = json!({
        "type": "system",
        "subtype": "task_notification",
        "task_id": "task-1",
        "status": status,
        "summary": "Command timed out",
    });
    if let Some(reason) = reason {
        notification["reason"] = json!(reason);
    }
    let Some(ClaudeCommandFact::Ended { end, .. }) = read(
        &mut tasks,
        &ClaudeWireFrameKind::SystemTaskNotification,
        &notification,
    ) else {
        panic!("the task's notification ends its row");
    };
    assert_eq!(end.is_stopped_by_provider, is_stopped);
    assert_eq!(
        end.summary.as_deref(),
        is_stopped.then_some("Command timed out")
    );
}

// Fails when a tool server's, a helper's or a workflow's task is shown as a running command.
// Mutation: `is_command_task` answering `true` for every kind.
#[rstest]
#[case::tool_server("mcp_task")]
#[case::helper("local_agent")]
#[case::workflow("local_workflow")]
fn a_task_that_runs_no_command_makes_no_row(#[case] task_type: &str) {
    let mut tasks = ClaudeCommandTasks::default();

    let fact = read(
        &mut tasks,
        &ClaudeWireFrameKind::SystemTaskStarted,
        &started("task-1", task_type, "call-1"),
    );

    assert!(fact.is_none());
}

// Endings sent to the test as the set appends them.
struct SentEndings(mpsc::UnboundedSender<AgentCommandEndedPayload>);

impl CommandEndingAppender for SentEndings {
    fn append(
        &self,
        _binding_id: RuntimeBindingId,
        ending: AgentCommandEndedPayload,
        _summary: Option<String>,
    ) -> BoxFuture<'_, ()> {
        self.0.send(ending).unwrap_or(());
        async {}.boxed()
    }
}

// The next ending the set appends, or a failure once a second has passed without one.
async fn next_ending(
    endings: &mut mpsc::UnboundedReceiver<AgentCommandEndedPayload>,
) -> AgentCommandEndedPayload {
    tokio::time::timeout(Duration::from_secs(1), endings.recv())
        .await
        .expect("a row ends")
        .expect("the set keeps its appender")
}

// Fails when the review's task frames make no row, or make one under another run; when its
// background list ends the session process's own background rows, or leaves its own unlisted one
// running; when the session process's whole list or its end ends the review's rows; and when a row
// the review left open outlives its process. Mutations: in `ClaudeApartRunCommands::read_frame`,
// return before the task frame is read, or publish the `Listed` fact as the set's reseed; in
// `ClaudeApartRunCommands::new`, mark no apart run; in `RunningCommandSets::commands_listed` or
// `provider_exited`, drop the apart-run check; in `ClaudeApartRunCommands::end`, end nothing.
#[tokio::test]
async fn a_staged_reviews_commands_are_rows_under_its_run_ending_with_its_process() {
    let (sender, mut endings) = mpsc::unbounded_channel();
    let binding_id = RuntimeBindingId::new("binding-1".to_owned()).expect("a binding id");
    let sets = Arc::new(RunningCommandSets::new(
        Arc::new(move |_session: &SessionId| Some(binding_id.clone())),
        Arc::new(SentEndings(sender)),
    ));
    sets.start_test_command(session_id(), run_id());
    let review_run = RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5f").expect("a valid run id");
    let review = ClaudeApartRunCommands::new(session_id(), review_run, Arc::clone(&sets));
    let calls = json!({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "call-1", "name": "Bash", "input": {"command": "sleep 60"}},
        {"type": "tool_use", "id": "call-2", "name": "Bash", "input": {"command": "npm test"}},
    ]}});
    let mut foreground = started("task-2", "local_bash", "call-2");
    foreground["is_backgrounded"] = json!(false);

    review.read_frame("assistant", &calls.to_string());
    review.read_frame(
        "system/task_started",
        &started("task-1", "local_bash", "call-1").to_string(),
    );
    review.read_frame("system/task_started", &foreground.to_string());
    review.read_frame(
        "system/background_tasks_changed",
        &json!({"type": "system", "subtype": "background_tasks_changed", "tasks": []}).to_string(),
    );
    let unlisted = next_ending(&mut endings).await;
    assert!(sets.has_running_commands(session_id()));
    sets.commands_listed(session_id(), ReseedScope::EveryCommand, Vec::new());
    let session_unlisted = next_ending(&mut endings).await;
    sets.provider_exited(session_id());
    assert!(sets.has_running_commands(session_id()));
    review.end();
    let left_open = next_ending(&mut endings).await;

    for (ending, command_id) in [(unlisted, "task-1"), (left_open, "task-2")] {
        assert_eq!(ending.run_id, review_run);
        assert_eq!(ending.command_id.as_str(), command_id);
        assert_eq!(ending.ending, CommandEnding::Failed);
    }
    assert_eq!(session_unlisted.run_id, run_id());
    assert!(!sets.has_running_commands(session_id()));
}

fn figures(output_style: ClaudeLocalCommandReply) -> ClaudeCreationFiguresReading {
    ClaudeCreationFiguresReading {
        output_style_names: vec!["Explanatory".to_owned(), "Learning: Deep".to_owned()],
        output_style,
        advisor: ClaudeLocalCommandReply {
            is_listed: false,
            text: None,
            outcome: None,
        },
        reply_reserve_reads: ClaudeReplyReserveReads::Refused {
            detail: "not read".to_owned(),
        },
        context_reads: Vec::new(),
    }
}

// Fails when a colon inside a style's name or description moves the split between them, or when a
// build that no longer lists `/output-style` reads as printing no descriptions rather than as the
// version fault it is. Mutations: in `read_output_style_descriptions`, split each row at its first
// `": "`; in `read_claude_command_choices`, the unlisted arm read as `Listed` of nothing.
#[test]
fn style_descriptions_keep_their_colons_and_an_unlisted_command_is_a_version_fault() {
    let listed = read_claude_command_choices(&figures(ClaudeLocalCommandReply {
        is_listed: true,
        text: Some(
            "- Explanatory (current): Explains choices: why, then how\n- Learning: Deep: Asks you"
                .to_owned(),
        ),
        outcome: None,
    }));
    let unlisted = read_claude_command_choices(&figures(ClaudeLocalCommandReply {
        is_listed: false,
        text: None,
        outcome: None,
    }));

    let ClaudeOutputStyleDescriptions::Listed(descriptions) = listed.output_styles else {
        panic!("the descriptions are listed");
    };
    assert_eq!(
        descriptions.get("Explanatory").map(String::as_str),
        Some("Explains choices: why, then how")
    );
    assert_eq!(
        descriptions.get("Learning: Deep").map(String::as_str),
        Some("Asks you")
    );
    assert_eq!(
        unlisted.output_styles,
        ClaudeOutputStyleDescriptions::Unlisted {
            line: "This Claude Code build does not list style descriptions.".to_owned(),
        }
    );
}
