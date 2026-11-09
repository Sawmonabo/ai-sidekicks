//! A session ask's copy on Codex: what it may reach, its fork's profile check and, against a real
//! account, a pre-approved write it refuses.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::mpsc;
use tokio_util::task::TaskTracker;

use super::SERVE_WAIT;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::permission_level::{CodexProfileFolders, compose_codex_profile_name};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, bind_test_listener, test_codex_service_dependencies,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::session::detached_conversation::{
    CodexDetachedFrame, CodexDetachedFrames,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::side_questions::test_copies::{
    ANSWER, CopyTurnEnding, read_only_profile, resting_session_ask, serve_copy,
    serve_unprofiled_copy,
};
use crate::driver::codex::session::side_questions::{
    CodexSideQuestions, THREAD_FORK_METHOD, request_copy_fork, start_turn,
    wait_for_side_question_answer,
};
use crate::driver::codex::session::test_fixture::{TestCodexSession, test_thread_settings};
use crate::driver::codex::thread::settings::tool_servers::CODEX_DAEMON_TOOL_SERVER_NAMES;
use crate::driver::codex::thread::settings::{
    CodexThreadSettings, MCP_SERVERS_KEY, compose_codex_thread_start_params,
};
use crate::driver::codex::thread::view::{
    THREAD_START_METHOD, assert_active_permission_profile, read_thread,
};
use crate::driver::session_control::AskSideQuestionParams;
use crate::runtime_binding::test_store::test_provider_account_id;

// Killed by a session ask's copy that keeps the session's folder trusted, so the person's project
// rules and hooks load in it, by one that carries a daemon entry or a sandbox, and by an answer
// drawn on the asked session's stream.
#[tokio::test(flavor = "multi_thread")]
async fn a_session_ask_copy_runs_untrusted_with_no_daemon_entry_and_answers_only_its_asker() {
    let session = TestCodexSession::start().await;
    let Some(listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let tasks = TaskTracker::new();
    let side_questions = CodexSideQuestions::new(Arc::clone(&session.engine) as _, tasks.clone());
    let params = resting_session_ask(session.task.record.session_id, Path::new("/"));
    let profile = read_only_profile(folder.path());
    let served = tokio::spawn(serve_copy(
        listener,
        profile.clone(),
        CopyTurnEnding::Answered,
    ));

    let answer = side_questions
        .ask_at_rest(
            &establishment,
            params
                .resume
                .as_ref()
                .expect("the question is asked at rest"),
            &params,
            Arc::new(PortRegistration::new("usage")),
            Arc::clone(&session.task.pricing),
        )
        .await
        .expect("the copy takes the question");
    let fork = tokio::time::timeout(SERVE_WAIT, served)
        .await
        .expect("the daemon lets the copy's connection go once it answered")
        .expect("the service served the copy");
    tasks.close();
    tasks.wait().await;
    let answered = wait_for_side_question_answer(answer)
        .await
        .expect("the question is answered");

    assert_eq!(fork["permissions"], profile.as_str());
    assert!(
        !fork.contains_key("sandbox"),
        "a profile is never combined with a sandbox"
    );
    assert_eq!(fork["approvalPolicy"], "never");
    let copy_folder = fork["cwd"].as_str().expect("the fork names its folder");
    assert_eq!(
        fork["config"]["projects"][copy_folder],
        json!({"trust_level": "untrusted"})
    );
    let servers = &fork["config"][MCP_SERVERS_KEY];
    for name in CODEX_DAEMON_TOOL_SERVER_NAMES {
        assert!(servers.get(name).is_none(), "the copy holds {name}");
    }
    assert_eq!(
        answered.map(FreeFormText::into_string).as_deref(),
        Some(ANSWER)
    );
    assert!(
        !session
            .engine
            .deliveries()
            .iter()
            .any(|delivery| delivery.kind == "sessionEvent"),
        "the answer reached the asked session's stream"
    );
}

// Killed by a live session ask's copy that keeps its folder trusted (the live path's
// `is_project_untrusted_for` answering false), and by a mark under one spelling alone of a folder
// reached through a link, where the person's trust under the other would win.
#[cfg(unix)]
#[tokio::test]
async fn a_live_session_asks_copy_marks_its_folder_untrusted_under_both_spellings() {
    let mut session = TestCodexSession::start().await;
    let side_questions =
        CodexSideQuestions::new(Arc::clone(&session.engine) as _, TaskTracker::new());
    let real = tempfile::tempdir().expect("the test makes a folder");
    let links = tempfile::tempdir().expect("the test makes a folder");
    let linked = links.path().join("project");
    std::os::unix::fs::symlink(real.path(), &linked).expect("the test links the folder");
    session.task.record.thread_settings.working_directory = linked.clone();
    let params = AskSideQuestionParams {
        resume: None,
        ..resting_session_ask(session.task.record.session_id, Path::new("/"))
    };
    let script = &mut session.scripted.script;

    let (asked, fork) = tokio::time::timeout(SERVE_WAIT, async {
        tokio::join!(side_questions.ask(&session.task.record, &params), async {
            let read = script.next_sent().await;
            assert_eq!(read["method"], "config/read");
            script.answer(&read, &json!({"config": {}, "origins": {}}));
            let fork = script.next_sent().await;
            assert_eq!(fork["method"], THREAD_FORK_METHOD);
            // Refused, so the copy ends here with nothing left to let go.
            script.send(&json!({
                "jsonrpc": "2.0",
                "id": fork["id"],
                "error": {"code": -32600, "message": "not forked"},
            }));
            fork
        })
    })
    .await
    .expect("the ask ends once its fork is refused");

    assert!(asked.is_err(), "a refused fork asks nothing");
    let canonical = std::fs::canonicalize(&linked).expect("the linked folder resolves");
    let untrusted = json!({"trust_level": "untrusted"});
    assert_eq!(
        fork["params"]["config"]["projects"],
        json!({
            (canonical.to_string_lossy()): untrusted,
            (linked.to_string_lossy()): untrusted,
        })
    );
}

// Killed by dropping the profile check on the copy's fork: the copy would start its turn under
// whatever Codex runs it with.
#[tokio::test(flavor = "multi_thread")]
async fn a_copy_fork_whose_reply_names_no_permission_profile_is_refused_and_dropped() {
    let session = TestCodexSession::start().await;
    let Some(listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let side_questions =
        CodexSideQuestions::new(Arc::clone(&session.engine) as _, TaskTracker::new());
    let params = resting_session_ask(session.task.record.session_id, Path::new("/"));
    let served = tokio::spawn(serve_unprofiled_copy(listener));

    let refused = tokio::time::timeout(
        SERVE_WAIT,
        side_questions.ask_at_rest(
            &establishment,
            params
                .resume
                .as_ref()
                .expect("the question is asked at rest"),
            &params,
            Arc::new(PortRegistration::new("usage")),
            Arc::clone(&session.task.pricing),
        ),
    )
    .await
    .expect("the ask answers once the fork replied");
    let later = tokio::time::timeout(SERVE_WAIT, served)
        .await
        .expect("the daemon lets the copy's connection go")
        .expect("the service served the copy");

    assert!(matches!(refused, Err(CodexError::Transport { .. })));
    assert!(later.is_empty(), "the copy asked for more: {later:?}");
    assert!(lock(&side_questions.copy_stops).copies.is_empty());
}

/// How long each turn of the live copy test may take on a real account.
const LIVE_TURN_DEADLINE: Duration = Duration::from_secs(300);

// On the signed-in account home `SIDEKICKS_TEST_CODEX_HOME` names, with the Codex build
// `SIDEKICKS_TEST_CODEX_PROGRAM` names, on the model `SIDEKICKS_TEST_CODEX_MODEL` names: a session
// ask's copy of a conversation in a folder the service trusts, whose project rule pre-approves
// `touch`, writes nothing, calls no tool server and leaves no conversation file of its own. Killed
// by a copy that keeps the folder trusted, where the rule lets the write through.
#[tokio::test]
#[ignore = "needs a downloaded Codex release and a signed-in account"]
async fn a_session_ask_copy_refuses_a_pre_approved_write_and_leaves_no_file() {
    let program = std::env::var_os("SIDEKICKS_TEST_CODEX_PROGRAM")
        .expect("SIDEKICKS_TEST_CODEX_PROGRAM names the downloaded Codex program");
    let home = PathBuf::from(
        std::env::var_os("SIDEKICKS_TEST_CODEX_HOME")
            .expect("SIDEKICKS_TEST_CODEX_HOME names a signed-in Codex home"),
    );
    let model = std::env::var("SIDEKICKS_TEST_CODEX_MODEL")
        .expect("SIDEKICKS_TEST_CODEX_MODEL names a model the account runs");
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let work = folder.path().join("work");
    let rules = work.join(".codex").join("rules");
    let command_channel = folder.path().join("command-channel");
    for made in [&rules, &command_channel] {
        std::fs::create_dir_all(made).expect("the test makes its folders");
    }
    std::fs::write(
        rules.join("pre-approved.rules"),
        "prefix_rule(pattern = [\"touch\"], decision = \"allow\")\n",
    )
    .expect("the test writes the person's pre-approval");
    let environment: Vec<(String, String)> = ["HOME", "PATH"]
        .into_iter()
        .filter_map(|name| Some((name.to_owned(), std::env::var(name).ok()?)))
        .collect();
    let socket = folder.path().join("codex.sock");
    let service = CodexService::new(
        CodexServiceHome {
            codex_home: home.clone(),
            kind: CodexHomeKind::Account(test_provider_account_id()),
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Account,
        test_codex_service_dependencies(
            folder.path(),
            Arc::new(TestCodexProgram {
                program: PathBuf::from(program),
                environment: environment.clone(),
            }),
            Arc::new(UnheardEvents),
            Arc::new(UnrecordedChildren),
        ),
        // Trusted for the whole service, as the person's own Codex folder trusts a project.
        vec![format!(
            "projects={{\"{}\"={{trust_level=\"trusted\"}}}}",
            work.display()
        )],
    );
    let (events, mut frames) = CodexDetachedFrames::new();
    let connection = service
        .open_detached_connection(events)
        .await
        .expect("the service starts and is dialed");
    let settings = CodexThreadSettings {
        working_directory: work.clone(),
        model,
        profile_folders: CodexProfileFolders {
            working_directory: work.clone(),
            git_common_folder: None,
            deny_paths: Vec::new(),
            command_channel_folder: command_channel,
        },
        command_environment: environment,
        ..test_thread_settings()
    };
    let read_only_profile =
        compose_codex_profile_name(PermissionLevel::Readonly, &settings.profile_folders);

    let ran = tokio::time::timeout(LIVE_TURN_DEADLINE, async {
        let started = connection
            .request(
                THREAD_START_METHOD,
                &compose_codex_thread_start_params(&settings, Map::new()),
            )
            .await
            .expect("the session's conversation starts");
        let session_thread = read_thread(&started, THREAD_START_METHOD)
            .expect("the start names its conversation")
            .id;
        start_turn(
            &connection,
            &session_thread,
            &work,
            "Reply with the word ready.",
        )
        .await
        .expect("the session's turn starts");
        read_live_turn(&mut frames, &session_thread).await;
        let forked = request_copy_fork(&connection, &settings, &session_thread, true)
            .await
            .expect("the copy forks");
        let copy_thread = read_thread(&forked, THREAD_FORK_METHOD)
            .expect("the fork names its copy")
            .id;
        assert_active_permission_profile(&forked, &read_only_profile, THREAD_FORK_METHOD)
            .expect("the copy runs read-only");
        start_turn(
            &connection,
            &copy_thread,
            &work,
            "Run exactly this shell command once in the working folder: touch written. Then call \
             the sidekicks tool session_list.",
        )
        .await
        .expect("the copy's turn starts");
        let items = read_live_turn(&mut frames, &copy_thread).await;
        (copy_thread, items)
    })
    .await;
    service.stop().await;
    let (copy_thread, items) = ran.expect("the turns end within their deadline");

    assert!(
        !work.join("written").exists(),
        "the copy ran the pre-approved write"
    );
    assert!(
        !items.iter().any(|item| item["type"] == "mcpToolCall"),
        "the copy called a tool server"
    );
    assert!(
        !names_file(&home.join("sessions"), &copy_thread),
        "the copy left a conversation file"
    );
}

// The items of `thread_id`'s turn that completed on `frames`, read until that turn ended.
async fn read_live_turn(
    frames: &mut mpsc::UnboundedReceiver<CodexDetachedFrame>,
    thread_id: &str,
) -> Vec<Value> {
    let mut items = Vec::new();
    while let Some((method, params)) = frames.recv().await {
        let params: Value = serde_json::from_str(params.get()).expect("the params are JSON");
        if params["threadId"] != thread_id {
            continue;
        }
        match method.as_str() {
            "item/completed" => items.push(params["item"].clone()),
            "turn/completed" => break,
            _ => {}
        }
    }
    items
}

// Whether a file at any depth under `folder` has `name` in its file name.
fn names_file(folder: &Path, name: &str) -> bool {
    std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            let path = entry.path();
            if path.is_dir() {
                names_file(&path, name)
            } else {
                entry.file_name().to_string_lossy().contains(name)
            }
        })
}
