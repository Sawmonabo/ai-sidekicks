//! Another session's ask on Claude Code: the copy that answers it asks no one, holds none of the
//! daemon's tool servers, loads none of the person's settings files and carries their deny rules,
//! while the person's own side question keeps the session's reach.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::session::controls::methods::SideQuestionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::{PathRules, ProgramStart, Spawner};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use super::session_controls::{FULL_MODEL_ID, one_turn_reply};
use crate::background_work::BackgroundWorkForms;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::claude::session::conversation_home::claude_conversation_home_metadata;
use crate::driver::claude::session::scripted::binding_id;
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, resume_params};
use crate::driver::claude::session::scripted::starts::ScriptedOneTurnReach;
use crate::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::spawn::launch::ClaudeProcessLauncher;
use crate::driver::claude::spawn::launch::bring_up::ClaudeSessionSpawn;
use crate::driver::claude::spawn::launch::one_turn::{ClaudeOneTurnRequest, run_claude_one_turn};
use crate::driver::claude::spawn::settings::{ClaudePreApprovals, ClaudeSessionAdvisor};
use crate::driver::ports::DriverPorts;
use crate::driver::session_control::{
    AskSideQuestionParams, ResumeSessionParams, SideQuestionPurpose,
};
use crate::driver::test_registry::{new_session_id, registered_test_accounts};
use crate::driver::{CurrentProviderAccount, PROVIDERS};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};
use crate::port::in_process_tool_servers::{
    InProcessToolServerError, InProcessToolServerOutbound, InProcessToolServers,
};
use crate::process_registry::ProviderProcessRegistry;
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::spawned_version::ResolvedProviderExecutable;

// The deny rule the person keeps in their own settings file.
const PERSON_DENY_RULE: &str = "Read(./secrets/**)";

// The allow rule the person keeps beside it, which pre-approves every write.
const PERSON_ALLOW_RULE: &str = "Write";

// The daemon's in-process tool servers, named but never called.
struct NamedServers;

impl InProcessToolServers for NamedServers {
    fn server_names(&self, _session_id: &SessionId) -> Vec<String> {
        vec!["sidekicks".to_owned()]
    }

    fn handle(
        &self,
        _session_id: SessionId,
        server_name: String,
        _message: Box<RawValue>,
        _outbound: Arc<dyn InProcessToolServerOutbound>,
    ) -> BoxFuture<'static, Result<Option<Box<RawValue>>, InProcessToolServerError>> {
        async move { Err(InProcessToolServerError::ServerNotFound { server_name }) }.boxed()
    }
}

// Killed by a session ask's copy that keeps the daemon's tool servers or the person's settings
// files, runs in plan mode rather than asking no one, drops the person's deny rules or carries
// their allow rule, or tells the asked session of the ask; and by a person's copy locked down.
#[tokio::test(start_paused = true)]
async fn a_session_asks_copy_is_locked_down_and_the_persons_keeps_the_sessions_reach() {
    let fixture = ScriptedDriver::new();
    fixture
        .services
        .ports
        .in_process_tool_servers
        .register(Arc::new(NamedServers))
        .expect("the tool servers register once");
    // Each copy at rest reads the build's catalog once.
    for _ in 0..2 {
        fixture.starts.script_catalog(json!({"models": [
            {"value": "opus", "displayName": "Opus", "resolvedModel": FULL_MODEL_ID},
        ]}));
    }
    fixture
        .starts
        .script_one_turn(one_turn_reply("for the person", None));
    fixture
        .starts
        .script_one_turn(one_turn_reply("for the session", None));
    let conversation_home = fixture.folder.path().join("conversation-home");
    std::fs::create_dir_all(&conversation_home).expect("the home is made");
    std::fs::write(
        conversation_home.join("settings.json"),
        json!({"permissions": {"allow": [PERSON_ALLOW_RULE], "deny": [PERSON_DENY_RULE]}})
            .to_string(),
    )
    .expect("the person's settings are written");
    let session_id = new_session_id();
    let ask = |purpose| AskSideQuestionParams {
        session_id,
        purpose,
        binding_id: binding_id("lead"),
        side_question_id: SideQuestionId::try_from(mint_uuid_v7()).expect("a UUID is an id"),
        question: "Why?".to_owned(),
        resume: Some(ResumeSessionParams {
            runtime_metadata: claude_conversation_home_metadata(&conversation_home),
            ..resume_params(session_id)
        }),
    };

    let for_person = fixture
        .driver
        .ask_side_question(ask(SideQuestionPurpose::Person))
        .await
        .expect("the person's question is answered");
    let for_session = fixture
        .driver
        .ask_side_question(ask(SideQuestionPurpose::SessionAsk))
        .await
        .expect("the session's ask is answered");

    let texts = [for_person, for_session].map(|answer| answer.map(FreeFormText::into_string));
    assert_eq!(
        texts,
        [
            Some("for the person".to_owned()),
            Some("for the session".to_owned()),
        ]
    );
    let published = fixture
        .engine
        .deliveries()
        .iter()
        .filter(|delivery| delivery.kind == "sessionEvent")
        .count();
    assert_eq!(published, 1, "only the person's answer reaches the stream");
    let modes: Vec<_> = fixture
        .starts
        .take_one_turns()
        .into_iter()
        .map(|record| record.permission_mode)
        .collect();
    assert_eq!(
        modes,
        [
            Some(ClaudePermissionMode::Plan),
            Some(ClaudePermissionMode::DontAsk),
        ]
    );
    let reaches = fixture.starts.take_one_turn_reaches();
    assert_eq!(
        reaches[0],
        ScriptedOneTurnReach {
            deny_rules_only: None,
            has_tool_servers: true,
        }
    );
    assert!(!reaches[1].has_tool_servers);
    let deny_rules = reaches[1]
        .deny_rules_only
        .as_deref()
        .expect("the ask's copy carries only deny rules");
    assert!(deny_rules.iter().any(|rule| rule == PERSON_DENY_RULE));
    assert!(!deny_rules.iter().any(|rule| rule == PERSON_ALLOW_RULE));
}

// A real Claude Code run as a session ask's copy runs: `dontAsk`, none of the person's settings
// files and none of the daemon's tool servers. The project's own settings pre-approve every write,
// and the copy still refuses one, and it leaves no conversation file in the home. Killed by
// pre-approvals carried into the copy. The program and the signed-in home are the ones
// `SIDEKICKS_TEST_CLAUDE_PROGRAM` and `SIDEKICKS_TEST_CLAUDE_HOME` name.
#[tokio::test]
#[ignore = "needs an installed Claude Code and a signed-in home"]
async fn a_real_session_asks_copy_refuses_a_pre_approved_write_and_leaves_no_file() {
    let program = PathBuf::from(
        std::env::var_os("SIDEKICKS_TEST_CLAUDE_PROGRAM")
            .expect("SIDEKICKS_TEST_CLAUDE_PROGRAM names the installed Claude Code program"),
    );
    let home = PathBuf::from(
        std::env::var_os("SIDEKICKS_TEST_CLAUDE_HOME")
            .expect("SIDEKICKS_TEST_CLAUDE_HOME names a signed-in Claude Code home"),
    );
    let folder = tempfile::tempdir().expect("a test folder");
    let project = folder.path().join("project");
    std::fs::create_dir_all(project.join(".claude")).expect("the project is made");
    std::fs::write(
        project.join(".claude").join("settings.json"),
        json!({"permissions": {"allow": ["Write", "Edit", "Bash"]}}).to_string(),
    )
    .expect("the project's settings are written");
    let target = project.join("made.txt");
    let launcher = ClaudeProcessLauncher::new(
        Spawner::new(Handle::current()).expect("a spawner"),
        Arc::new(UnrecordedChildren),
        Arc::new(ProviderProcessRegistry::default()),
        registered_test_accounts(CurrentProviderAccount::NoneRegistered),
        DriverPorts::new().raw_provider_messages,
        folder.path(),
    );
    let mut environment: Vec<(String, String)> = std::env::vars()
        .filter(|(name, _value)| name != "CLAUDE_CONFIG_DIR")
        .collect();
    environment.push((
        "CLAUDE_CONFIG_DIR".to_owned(),
        home.to_string_lossy().into_owned(),
    ));
    let executable = ResolvedProviderExecutable {
        requested_command: "claude".to_owned(),
        resolved_executable_path: program.clone(),
        start: ProgramStart {
            program,
            leading_arguments: Vec::new(),
        },
        environment,
    };
    let legs = ClaudeSpawnBoundLegs {
        session_id: new_session_id(),
        model: "haiku".to_owned(),
        execution_posture: None,
        working_directory: project.clone(),
        callback_tools: None,
        subagent_policy: None,
        tool_servers: Vec::new(),
        output_schema: None,
        on_callback_tool_call: None,
        on_mcp_server_status: None,
        credential_deny_paths: Vec::new(),
        memory_folders: Vec::new(),
        background_work: Arc::new(BackgroundWorkForms::of_providers(PROVIDERS)),
        spawn_environment: Vec::new(),
        advisor: ClaudeSessionAdvisor::Unpicked,
        output_style: None,
        command_channel: None,
    };
    let conversation_files = count_conversation_files(&home.join("projects"));

    let turn = run_claude_one_turn(
        &launcher,
        &executable,
        ClaudeOneTurnRequest {
            spawn: ClaudeSessionSpawn {
                legs: &legs,
                session_rules: &[],
                step_bound: None,
                in_process_servers: None,
                path_rules: PathRules::NATIVE,
            },
            provider_account_id: test_provider_account_id(),
            resume_handle: None,
            permission_mode: Some(ClaudePermissionMode::DontAsk),
            pre_approvals: ClaudePreApprovals::DenyRulesOnly(&[]),
            text: OutboundText {
                text: format!(
                    "Use the Write tool to create the file {} holding the word made, then answer \
                     with the one word DONE.",
                    target.display()
                ),
                origin: OutboundTextOrigin::DriverCommand,
            },
            stop: CancellationToken::new(),
        },
    );
    tokio::time::timeout(Duration::from_secs(180), turn)
        .await
        .expect("the copy answers within three minutes")
        .expect("the copy's turn ends");

    assert!(!target.exists(), "the copy wrote a pre-approved file");
    assert_eq!(
        count_conversation_files(&home.join("projects")),
        conversation_files,
        "the copy left a conversation file"
    );
}

// The conversation files under `folder`, at any depth.
fn count_conversation_files(folder: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return 0;
    };
    entries
        .map(|entry| entry.expect("the folder lists").path())
        .map(|path| {
            if path.is_dir() {
                count_conversation_files(&path)
            } else {
                usize::from(
                    path.extension()
                        .is_some_and(|extension| extension == "jsonl"),
                )
            }
        })
        .sum()
}
