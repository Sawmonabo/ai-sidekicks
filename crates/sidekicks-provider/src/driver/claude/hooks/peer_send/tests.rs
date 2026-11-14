use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;

use super::{
    ClaudePeerSendCheck, ClaudeTurnSenders, another_session, answer_goes_back, answer_peer_send,
};
use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::claude::hooks::registration::{
    ClaudeHookCallback, compose_claude_initialize_request,
};
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::session_messages::{no_session_named, target_unread_reason};
use crate::driver::test_registry::fixed_session_id;
use crate::port::agent_tree_lookup::{AgentTreeHelper, AgentTreeLookup};
use crate::port::session_directory_lookup::{DirectoryMatch, SessionDirectoryLookup};
use crate::port::session_message_reading_publisher::SessionMessageArrival;

/// The daemon's own inbox in these tests.
const DAEMON_INBOX: &str = "/tmp/cc-socks/d0123456789abcde.sock";

/// The calling session's own process, which its registry lists as `drafter`.
const CALLER_PROCESS_ID: u32 = 4100;

/// What a failed agent-tree read says.
const UNREAD_CAUSE: &str = "the agent tree is locked";

type Lookup<'a> = BoxFuture<'a, Result<Option<AgentTreeHelper>, Box<dyn Error + Send + Sync>>>;

// The session's helpers, each an id and the name the helper tool gave it; or a tree whose every
// read fails.
struct Helpers {
    helpers: Vec<(&'static str, &'static str)>,
    is_failing: bool,
}

impl Helpers {
    fn answer(&self, is_match: impl Fn(&(&str, &str)) -> bool) -> Lookup<'_> {
        if self.is_failing {
            return async { Err(UNREAD_CAUSE.into()) }.boxed();
        }
        let found = self
            .helpers
            .iter()
            .find(|helper| is_match(helper))
            .map(|(id, _)| AgentTreeHelper {
                child_handle: ChildHandle::new("child-1".to_owned()).expect("a handle"),
                subagent_id: (*id).to_owned(),
                provider_path: None,
                own_run_id: RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e")
                    .expect("a valid run id"),
                own_run_state: RunState::Running,
                own_run_stop_trigger: None,
            });
        async move { Ok(found) }.boxed()
    }
}

impl AgentTreeLookup for Helpers {
    fn helper_by_subagent_id(
        &self,
        _session_id: SessionId,
        _provider_name: ProviderId,
        subagent_id: String,
    ) -> Lookup<'_> {
        self.answer(|(id, _)| *id == subagent_id)
    }

    fn helper_by_name(&self, _session_id: SessionId, name: String) -> Lookup<'_> {
        self.answer(|(_, helper_name)| *helper_name == name)
    }

    fn helper_by_provider_path(&self, _session_id: SessionId, _path: String) -> Lookup<'_> {
        async { Ok(None) }.boxed()
    }
}

// A directory holding one session, `planner` (`s-4a10`), reached by its name and by a `did:`
// address.
struct OneSessionDirectory;

impl SessionDirectoryLookup for OneSessionDirectory {
    fn sessions_named(
        &self,
        target: String,
    ) -> BoxFuture<'_, Result<Vec<DirectoryMatch>, Box<dyn Error + Send + Sync>>> {
        let listed = ["planner", "did:plc:planner"]
            .contains(&target.as_str())
            .then(|| DirectoryMatch {
                id: "s-4a10".to_owned(),
                name: "planner".to_owned(),
            });
        async move { Ok(listed.into_iter().collect()) }.boxed()
    }
}

// Writes `contents` as the registry file of `process_id` under `config_folder`.
fn write_registry_file(config_folder: &Path, process_id: u32, contents: &str) {
    let registry = config_folder.join("sessions");
    std::fs::create_dir_all(&registry).expect("the registry folder is made");
    std::fs::write(registry.join(format!("{process_id}.json")), contents)
        .expect("the registry file is written");
}

// A message from `planner` (`s-4a10`) that the daemon delivered, starting its turn or taken in by
// one under way.
fn planner_arrival(is_turn_start: bool) -> SessionMessageArrival {
    SessionMessageArrival {
        session_id: fixed_session_id(),
        run_id: None,
        message_id: "message-1".to_owned(),
        sender_message_id: None,
        from: format!("uds:{DAEMON_INBOX}"),
        from_session: Some("s-4a10".to_owned()),
        from_name: Some("planner".to_owned()),
        hop_chain: Vec::new(),
        sender_process_id: None,
        body: Some("go on".to_owned()),
        is_turn_start,
    }
}

/// Which messages from other sessions the open turn holds.
#[derive(Clone, Copy, Debug)]
enum TurnMessages {
    None,
    Started,
    Absorbed,
}

// The check of a call to `to` in a turn holding `messages`, reading `helpers`, `directory` and
// the registries under `folders`.
fn check(
    to: &str,
    messages: TurnMessages,
    helpers: Option<Helpers>,
    directory: Option<Arc<dyn SessionDirectoryLookup>>,
    folders: Vec<PathBuf>,
) -> ClaudePeerSendCheck<'_> {
    let mut senders = ClaudeTurnSenders::default();
    match messages {
        TurnMessages::None => {}
        TurnMessages::Started => senders.observe(&planner_arrival(true)),
        TurnMessages::Absorbed => senders.observe(&planner_arrival(false)),
    }
    ClaudePeerSendCheck {
        session_id: fixed_session_id(),
        caller_process_id: CALLER_PROCESS_ID,
        to,
        senders,
        daemon_inbox: DAEMON_INBOX,
        agent_tree: helpers.map(|helpers| Arc::new(helpers) as Arc<dyn AgentTreeLookup>),
        directory,
        registry_folders: async move { Ok(folders) }.boxed(),
    }
}

/// The answer a case expects.
#[derive(Clone, Copy, Debug)]
enum Expected {
    Pass,
    AnswerGoesBack,
    AnotherSession(&'static str, &'static str),
    NoSession,
    Unread,
}

// One input per rule of the hook, `{socks}` standing for the running sessions' socket folder. A
// helper named like a running session passing kills a deny before the helper check; the `did:`
// address denied kills `did:` passing; the absorbed sender getting the another-session words by
// its id kills the answer-goes-back words for an absorbed sender; a pipe written with `?` denied
// kills a pipe read by its `.` form alone; the shared name sent to by id kills the name kept; the
// caller's own name passing and its own socket reading as no session kill a registry walk that
// lists the caller.
#[rstest]
#[case::a_helper_by_id("c4d8b8d7a99274f48", TurnMessages::None, false, Expected::Pass)]
#[case::a_helper_named_like_a_session("tester", TurnMessages::None, false, Expected::Pass)]
#[case::the_lead("main", TurnMessages::Started, false, Expected::Pass)]
#[case::the_daemon_inbox_in_a_turn_a_message_started(
    "uds:/tmp/cc-socks/d0123456789abcde.sock",
    TurnMessages::Started,
    false,
    Expected::AnswerGoesBack
)]
#[case::the_daemon_inbox_in_a_turn_that_took_one_in(
    "/tmp/cc-socks/d0123456789abcde.sock",
    TurnMessages::Absorbed,
    false,
    Expected::AnotherSession("planner", "s-4a10")
)]
#[case::the_daemon_inbox_with_no_message(
    "/tmp/cc-socks/d0123456789abcde.sock",
    TurnMessages::None,
    false,
    Expected::NoSession
)]
#[case::an_address_in_the_directory(
    "did:plc:planner",
    TurnMessages::None,
    false,
    Expected::AnotherSession("planner", "planner")
)]
#[case::the_socket_of_a_running_session(
    "uds:{socks}/4101.sock",
    TurnMessages::None,
    false,
    Expected::AnotherSession("builder", "builder")
)]
#[case::an_address_no_session_has(
    "bridge:session_x",
    TurnMessages::None,
    false,
    Expected::NoSession
)]
#[case::a_pipe_no_session_has(
    r"\\?\pipe\cc-msg-0123",
    TurnMessages::None,
    false,
    Expected::NoSession
)]
#[case::a_name_in_the_directory(
    "planner",
    TurnMessages::None,
    false,
    Expected::AnotherSession("planner", "planner")
)]
#[case::a_running_sessions_name(
    "builder",
    TurnMessages::None,
    false,
    Expected::AnotherSession("builder", "builder")
)]
#[case::a_name_two_running_sessions_share(
    "reviewer",
    TurnMessages::None,
    false,
    Expected::AnotherSession("reviewer", "s-reviewer-1")
)]
#[case::any_other_name("courier", TurnMessages::Started, false, Expected::Pass)]
#[case::the_callers_own_name("drafter", TurnMessages::None, false, Expected::Pass)]
#[case::the_callers_own_socket(
    "uds:{socks}/4100.sock",
    TurnMessages::None,
    false,
    Expected::NoSession
)]
#[case::an_unread_tree("courier", TurnMessages::None, true, Expected::Unread)]
#[tokio::test]
async fn a_message_call_passes_to_a_helper_and_is_denied_to_another_session(
    #[case] to: &str,
    #[case] messages: TurnMessages,
    #[case] is_tree_failing: bool,
    #[case] expected: Expected,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let socks = scratch.path().join("socks");
    std::fs::create_dir(&socks).expect("the socket folder is made");
    let config = scratch.path().join("config");
    let registry = [
        (CALLER_PROCESS_ID, "drafter", "s-drafter"),
        (4101, "builder", "s-builder"),
        (4102, "reviewer", "s-reviewer-1"),
        (4103, "reviewer", "s-reviewer-2"),
        (4104, "tester", "s-tester"),
    ];
    for (process_id, name, session_id) in registry {
        write_registry_file(
            &config,
            process_id,
            &json!({
                "sessionId": session_id,
                "name": name,
                "messagingSocketPath": socks.join(format!("{process_id}.sock")),
            })
            .to_string(),
        );
    }
    let to = to.replace("{socks}", &socks.display().to_string());
    let helpers = Helpers {
        helpers: vec![
            ("c4d8b8d7a99274f48", "scout"),
            ("a0c1d2e3f4a5b6c7d", "tester"),
        ],
        is_failing: is_tree_failing,
    };

    let answer = answer_peer_send(check(
        &to,
        messages,
        Some(helpers),
        Some(Arc::new(OneSessionDirectory)),
        vec![config],
    ))
    .await;

    let expected = match expected {
        Expected::Pass => ClaudeHookAnswer::Pass,
        Expected::AnswerGoesBack => ClaudeHookAnswer::Deny {
            reason: answer_goes_back("planner", "s-4a10"),
        },
        Expected::AnotherSession(name, target) => ClaudeHookAnswer::Deny {
            reason: another_session(name, target),
        },
        Expected::NoSession => ClaudeHookAnswer::Deny {
            reason: no_session_named(&to),
        },
        Expected::Unread => ClaudeHookAnswer::Deny {
            reason: target_unread_reason(UNREAD_CAUSE),
        },
    };
    assert_eq!(answer, expected);
}

// The words name the session, and send the model to it by the given target as a JSON string.
// Killed by either text's wording or its target changing.
#[test]
fn the_refusals_read_as_the_model_is_told() {
    assert_eq!(
        another_session("builder", "builder"),
        r#"builder is another session. Send with session_send {"to": "builder"}."#
    );
    assert_eq!(
        answer_goes_back("planner", "s-4a10"),
        "Your answer already reaches planner when you finish this turn. To say more, use \
         session_send {\"to\": \"s-4a10\"}."
    );
}

// Every session, with or without a helper policy, holds the send hook on the message tool, held
// as long as Claude Code allows. Killed by the hook registered only under a helper policy, or on
// another tool.
#[test]
fn every_session_registers_the_send_hook_on_the_message_tool() {
    let ClaudeControlRequest::Initialize {
        hooks: Some(hooks), ..
    } = compose_claude_initialize_request(None, Vec::new())
    else {
        panic!("a first initialize carries the hooks");
    };

    let send_hooks: Vec<(Option<&str>, bool)> = hooks
        .pre_tool_use
        .iter()
        .filter(|hook| hook.hook_callback_ids == [ClaudeHookCallback::PeerSend.id()])
        .map(|hook| (hook.matcher.as_deref(), hook.timeout.is_some()))
        .collect();
    assert_eq!(send_hooks, [(Some("^SendMessage$"), true)]);
}
