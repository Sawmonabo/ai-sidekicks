use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::{FutureExt as _, SinkExt as _, StreamExt as _};
use serde_json::{Map, Value, json};
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
use sidekicks_platforms::Spawner;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_workspace::git::process::NO_PROMPT_ENVIRONMENT;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader, DuplexStream, Lines};
use tokio::runtime::Handle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};

use super::bearer_token::RelayBearerToken;
use super::command_acts::write_input;
use super::endpoint::RelayEndpoint;
use super::executor::CodexExecutor;
use super::start_rewrite::{WrappedStart, wrap_start};
use super::{
    CodexExecRelay, CodexExecRelayDependencies, CodexThreadSessions, RelayedCommand, RelayedThread,
};
use crate::command::channel::PartyRecord;
use crate::command::channel::test_support::{
    end_party, new_party_keys, party_command, ready_parties, sent_requests, write_party_record,
};
use crate::command::running_set::RunningCommandSets;
use crate::command::running_set::unbound_running_command_sets;
use crate::command::waiting_checks::SystemInputWaitReader;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, start_scripted_codex_service, test_codex_service_dependencies,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
use crate::driver::codex::thread::settings::compose_codex_relay_environments;
use crate::driver::codex::thread::view::{THREAD_START_METHOD, TURN_START_METHOD};
use crate::driver::contract::DriverError;
use crate::driver::test_registry::new_run_id;
use crate::driver::test_registry::{new_session_id, test_driver_services};
use crate::port::running_command_publisher::{
    CommandStart, RunningCommandParams, RunningCommandPublisher as _,
};
use crate::runtime_binding::test_store::test_provider_account_id;

const THREAD: &str = "thread-1";
const COPY_THREAD: &str = "thread-copy";
const CALL: &str = "call-1";
const EXECUTOR_PROCESS: &str = "7-0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d";

// The executor's far side: the lines the relay wrote to it, and its output the test writes.
struct FakeExecutor {
    sent: Lines<BufReader<DuplexStream>>,
    output: DuplexStream,
}

impl FakeExecutor {
    async fn next_sent(&mut self) -> Value {
        let line = self
            .sent
            .next_line()
            .await
            .expect("the executor's input reads")
            .expect("the relay wrote a line");
        serde_json::from_str(&line).expect("the relay writes JSON")
    }

    async fn write(&mut self, message: &Value) {
        let line = format!("{message}\n");
        self.output
            .write_all(line.as_bytes())
            .await
            .expect("the executor's output takes the line");
    }
}

// A connection to a fake executor, initialized as the relay initializes a real one.
async fn initialized_executor() -> (Arc<CodexExecutor>, FakeExecutor) {
    let (input, sent) = tokio::io::duplex(1 << 16);
    let (output, read) = tokio::io::duplex(1 << 16);
    let executor = CodexExecutor::over(read, input, Some(std::process::id()));
    let mut fake = FakeExecutor {
        sent: BufReader::new(sent).lines(),
        output,
    };
    let answering = async {
        let initialize = fake.next_sent().await;
        assert_eq!(initialize["method"], "initialize");
        fake.write(&json!({ "id": initialize["id"], "result": { "sessionId": "executor-1" } }))
            .await;
        assert_eq!(fake.next_sent().await["method"], "initialized");
    };
    let (initialized, ()) = tokio::join!(executor.initialize(), answering);
    initialized.expect("the executor initializes");
    (executor, fake)
}

// A relay whose conversation `THREAD` and side question's copy `COPY_THREAD` belong to
// `session_id`, its running commands not registered, so no start is wrapped.
fn relay_for(session_id: SessionId, folder: &Path) -> Arc<CodexExecRelay> {
    relay_reporting_to(folder, None, session_threads(session_id))
}

// `THREAD` and the side question's copy `COPY_THREAD`, both `session_id`'s.
fn session_threads(session_id: SessionId) -> CodexThreadSessions {
    Arc::new(move |thread_id: &str| {
        [THREAD, COPY_THREAD]
            .contains(&thread_id)
            .then_some(RelayedThread {
                session_id,
                is_side_question: thread_id == COPY_THREAD,
            })
    })
}

// A relay in `folder` whose conversations `thread_sessions` reads, its running commands `sets`
// where given.
fn relay_reporting_to(
    folder: &Path,
    sets: Option<Arc<RunningCommandSets>>,
    thread_sessions: CodexThreadSessions,
) -> Arc<CodexExecRelay> {
    let command_output = Arc::new(PortRegistration::new("running commands"));
    if let Some(sets) = sets {
        assert!(command_output.register(sets).is_ok());
    }
    let spawner = Spawner::new(Handle::current()).expect("the spawner thread starts");
    let dependencies = Arc::new(CodexExecRelayDependencies {
        spawner: spawner.clone(),
        command_channel_root: folder.join("channels"),
        caller_processes: Arc::new(
            ProcessTableReader::for_this_program().expect("this program's reader builds"),
        ),
        input_waits: Arc::new(SystemInputWaitReader { spawner }),
        command_output,
        wrapper_program: folder.join("wrapper"),
        askpass_program: folder.join("askpass"),
    });
    CodexExecRelay::new(dependencies, thread_sessions, Arc::new(|| {}))
}

fn command_id() -> CommandId {
    CommandId::new(CALL.to_owned()).expect("a call id is a command id")
}

async fn next_text<Stream>(socket: &mut Stream) -> Value
where
    Stream: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    match socket.next().await {
        Some(Ok(Message::Text(text))) => serde_json::from_str(text.as_str()).expect("JSON"),
        other => panic!("the client expected a text message, got {other:?}"),
    }
}

// Everything the service and the executor say passes unchanged, but the client's `initialize`,
// answered from the relay's own, and a start, whose environment gains the no-prompt variables
// where no wrapper runs it and whose command is recorded under its call until the executor
// reports it ended. A connection without the start's token is refused.
#[tokio::test]
async fn passes_an_exchange_and_admits_only_the_token() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let relay = relay_for(session_id, folder.path());
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(executor);
    let token = RelayBearerToken::mint().expect("a token mints");
    let presented = format!("Bearer {}", token.text());
    let endpoint = RelayEndpoint::listen(Arc::downgrade(&relay), token)
        .await
        .expect("the relay listens");
    let url = endpoint.url();
    *lock(&relay.endpoint) = Some(endpoint);

    for authorization in [None, Some("Bearer not-the-token")] {
        let mut request = url.as_str().into_client_request().expect("a request");
        if let Some(authorization) = authorization {
            request.headers_mut().insert(
                header::AUTHORIZATION,
                HeaderValue::from_static(authorization),
            );
        }
        assert!(
            tokio_tungstenite::connect_async(request).await.is_err(),
            "{authorization:?} is refused"
        );
    }
    let mut request = url.as_str().into_client_request().expect("a request");
    request.headers_mut().insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&presented).expect("a header value"),
    );
    let (mut socket, _response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("the token is admitted");

    let send = |message: Value| Message::text(message.to_string());
    socket
        .send(send(
            json!({ "id": 1, "method": "initialize", "params": { "clientName": "codex" } }),
        ))
        .await
        .expect("the client writes");
    assert_eq!(
        next_text(&mut socket).await,
        json!({ "id": 1, "result": { "sessionId": "executor-1" } })
    );
    socket
        .send(send(json!({ "method": "initialized" })))
        .await
        .expect("the client writes");
    let read =
        json!({ "id": 2, "method": "process/read", "params": { "processId": "p", "afterSeq": 0 } });
    socket
        .send(send(read.clone()))
        .await
        .expect("the client writes");
    assert_eq!(
        fake.next_sent().await,
        read,
        "no initialize reaches the executor"
    );
    let output = json!({
        "method": "process/output",
        "params": { "processId": "p", "seq": 1, "chunk": "aGk=" },
    });
    fake.write(&output).await;
    assert_eq!(next_text(&mut socket).await, output);

    let start = json!({ "id": 3, "method": "process/start", "params": {
        "processId": EXECUTOR_PROCESS,
        "argv": ["/bin/sh", "-lc", "echo hi"],
        "cwd": "file:///tmp",
        "env": { "KEPT": "1" },
        "tty": false,
        "arg0": null,
        "metadata": { "threadId": THREAD, "toolCallId": CALL },
    }});
    socket
        .send(send(start.clone()))
        .await
        .expect("the client writes");
    let mut started = fake.next_sent().await;
    let environment = started["params"]["env"]
        .as_object_mut()
        .expect("the start carries its environment")
        .clone();
    assert_eq!(environment["KEPT"], "1");
    assert_eq!(environment["GIT_TERMINAL_PROMPT"], "0");
    started["params"]["env"] = start["params"]["env"].clone();
    assert_eq!(
        started, start,
        "only the environment changes where no channel is open"
    );
    let answer = json!({ "id": 3, "result": {} });
    fake.write(&answer).await;
    assert_eq!(next_text(&mut socket).await, answer);
    assert_eq!(
        relay.relayed_command(session_id, &command_id()),
        Some(RelayedCommand {
            session_id,
            thread_id: THREAD.to_owned(),
            executor_process_id: EXECUTOR_PROCESS.to_owned(),
            terminal_process_id: "7".to_owned(),
            accepts_input: false,
            service_start: 0,
        })
    );

    let terminate = json!({
        "id": 4,
        "method": "process/terminate",
        "params": { "processId": EXECUTOR_PROCESS },
    });
    socket
        .send(send(terminate.clone()))
        .await
        .expect("the client writes");
    assert_eq!(fake.next_sent().await, terminate);
    let exited = json!({
        "method": "process/exited",
        "params": { "processId": EXECUTOR_PROCESS, "seq": 2, "exitCode": 0 },
    });
    fake.write(&exited).await;
    assert_eq!(next_text(&mut socket).await, exited);
    for _turn in 0..100 {
        if relay.relayed_command(session_id, &command_id()).is_none() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the ended command is still recorded");
}

// A start the wrapper runs names the wrapper, the channel, the executor's process, the command's
// own name and its terminal ahead of its words, runs a login shell's line in a non-login shell,
// sends no name of its own on, and sends its git and ssh prompts to the askpass. Killed by a
// login shell left to run the person's profile over the composed environment.
#[test]
fn wraps_a_start_with_its_name_and_terminal() {
    let mut params: Map<String, Value> = serde_json::from_value(json!({
        "argv": ["/bin/zsh", "-lc", "git status"],
        "arg0": "zsh",
        "tty": true,
        "env": { "KEPT": "1" },
    }))
    .expect("params");
    let channel_environment = [("SIDEKICKS_CHANNEL".to_owned(), "/channel".to_owned())];

    wrap_start(
        &mut params,
        &WrappedStart {
            wrapper_program: Path::new("/wrapper"),
            askpass_program: Path::new("/askpass"),
            channel_folder: Path::new("/channel"),
            channel_environment: &channel_environment,
            executor_process_id: EXECUTOR_PROCESS,
        },
    );

    assert_eq!(
        params["argv"],
        json!([
            "/wrapper",
            "--conversation",
            "/channel",
            "--process",
            EXECUTOR_PROCESS,
            "--arg0",
            "zsh",
            "--tty",
            "--",
            "/bin/zsh",
            "-c",
            "git status"
        ])
    );
    assert_eq!(params["arg0"], Value::Null);
    assert_eq!(
        params["env"],
        json!({
            "KEPT": "1",
            "SIDEKICKS_CHANNEL": "/channel",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS": "/askpass",
            "SSH_ASKPASS": "/askpass",
            "SSH_ASKPASS_REQUIRE": "force",
        })
    );
}

// A session's start runs under the wrapper even where it asks the executor for its own snapshot,
// which it then no longer asks for; a side question's copy's start runs unwrapped with the whole
// no-prompt environment and no askpass; a start the executor refuses is not kept. Killed by
// skipping the wrapper for a start that carries `shellSnapshot`, by wrapping a copy's start or
// giving it the askpass, by setting only git's terminal prompt off, and by keeping a refused start.
#[tokio::test]
async fn wraps_a_sessions_start_and_gives_a_copys_start_no_way_to_ask() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let relay = relay_reporting_to(
        folder.path(),
        Some(unbound_running_command_sets()),
        session_threads(session_id),
    );
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let start = |id: u64, thread: &str, call: &str, process: &str| {
        json!({ "id": id, "method": "process/start", "params": {
            "processId": process,
            "argv": ["/usr/bin/git", "fetch"],
            "cwd": "file:///tmp",
            "env": { "KEPT": "1" },
            "tty": false,
            "arg0": null,
            "shellSnapshot": {
                "scopeId": "scope-1",
                "shell": { "name": "bash", "path": "/bin/bash" },
            },
            "metadata": { "threadId": thread, "toolCallId": call },
        }})
        .to_string()
    };

    let session_start = tokio::spawn(Arc::clone(&relay).forward_process_start(
        Arc::clone(&executor),
        start(1, THREAD, CALL, EXECUTOR_PROCESS),
    ));
    let wrapped = fake.next_sent().await;
    let copy_start = tokio::spawn(Arc::clone(&relay).forward_process_start(
        Arc::clone(&executor),
        start(2, COPY_THREAD, "call-copy", "8-copy"),
    ));
    let unwrapped = fake.next_sent().await;
    fake.write(&json!({ "id": 2, "error": { "code": -32603, "message": "spawn failed" } }))
        .await;
    copy_start.await.expect("the copy's start is passed on");

    let params = &wrapped["params"];
    assert_eq!(params["argv"][0], json!(folder.path().join("wrapper")));
    assert_eq!(params["argv"][4], EXECUTOR_PROCESS);
    assert!(params.get("shellSnapshot").is_none(), "{params}");
    assert_eq!(
        params["env"]["GIT_ASKPASS"],
        json!(folder.path().join("askpass"))
    );
    let params = &unwrapped["params"];
    assert_eq!(params["argv"], json!(["/usr/bin/git", "fetch"]));
    let environment = params["env"].as_object().expect("an environment");
    for (name, value) in NO_PROMPT_ENVIRONMENT {
        assert_eq!(environment[name], value, "{name}");
    }
    assert!(!environment.contains_key("SSH_ASKPASS"), "{environment:?}");
    let copy_call = CommandId::new("call-copy".to_owned()).expect("a call id");
    assert_eq!(relay.relayed_command(session_id, &copy_call), None);
    assert!(relay.relayed_command(session_id, &command_id()).is_some());
    session_start.abort();
}

// A command whose service was started again while it ran ends its row at its process's end,
// whether it ended before the new start or after it; one of the current start waits for its item.
// Killed by leaving every row to its item's end, or by forgetting a command that ended before the
// new start.
#[tokio::test]
async fn ends_the_row_of_a_former_service_starts_command_at_its_process_end() {
    let folder = tempfile::tempdir().expect("a test folder");
    // One session per command, so each one's rows read apart; each a side question's copy, whose
    // starts run unwrapped.
    let sessions = [new_session_id(), new_session_id(), new_session_id()];
    let sets = unbound_running_command_sets();
    let relay = relay_reporting_to(
        folder.path(),
        Some(Arc::clone(&sets)),
        Arc::new(move |thread_id: &str| {
            let index: usize = thread_id.strip_prefix("thread-")?.parse().ok()?;
            Some(RelayedThread {
                session_id: *sessions.get(index)?,
                is_side_question: true,
            })
        }),
    );
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let run_id = new_run_id();
    let mut starts = Vec::new();
    for (index, call) in ["call-early", "call-late", "call-current"]
        .into_iter()
        .enumerate()
    {
        if index == 2 {
            relay
                .start(tokio::process::Command::new("false"))
                .await
                .expect("the relay starts again over its running executor");
        }
        let process = format!("{index}-process");
        let session_id = sessions[index];
        sets.command_started(CommandStart {
            session_id,
            command_id: call_id(call),
            run_id,
            name: NonEmptyText::new("sleep 60".to_owned()).expect("a name"),
            started_at: WireInstant::now(),
            line: None,
            process_id: Some(process.clone()),
            is_backgrounded: false,
            can_move_to_background: false,
            accepts_input: false,
        });
        let line = json!({ "id": index, "method": "process/start", "params": {
            "processId": process,
            "argv": ["/bin/sleep", "60"],
            "cwd": "file:///tmp",
            "env": {},
            "tty": false,
            "arg0": null,
            "metadata": { "threadId": format!("thread-{index}"), "toolCallId": call },
        }});
        starts.push(tokio::spawn(
            Arc::clone(&relay).forward_process_start(Arc::clone(&executor), line.to_string()),
        ));
        fake.next_sent().await;
        fake.write(&json!({ "id": index, "result": {} })).await;
        if index == 0 {
            fake.write(&exited(&process)).await;
            wait_until(|| relay.relayed_command(session_id, &call_id(call)).is_none()).await;
        }
    }
    for process in ["1-process", "2-process"] {
        fake.write(&exited(process)).await;
    }

    for start in starts {
        start.await.expect("each start's watch ends");
    }
    assert!(
        !sets.has_running_commands(sessions[0]),
        "ended before the new start"
    );
    assert!(
        !sets.has_running_commands(sessions[1]),
        "ended after the new start"
    );
    assert!(sets.has_running_commands(sessions[2]), "waits for its item");
}

fn exited(process: &str) -> Value {
    json!({
        "method": "process/exited",
        "params": { "processId": process, "seq": 1, "exitCode": 3 },
    })
}

fn call_id(call: &str) -> CommandId {
    CommandId::new(call.to_owned()).expect("a call id")
}

// Yields until `holds` reads true, failing after a bound.
async fn wait_until(mut holds: impl FnMut() -> bool) {
    for _turn in 0..1_000 {
        if holds() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    panic!("the condition never held");
}

// A write whose answer is late goes out once more under the same write id, which the executor
// takes once.
#[tokio::test(start_paused = true)]
async fn resends_a_late_write_under_its_write_id() {
    let (executor, mut fake) = initialized_executor().await;
    let command = RelayedCommand {
        session_id: new_session_id(),
        thread_id: THREAD.to_owned(),
        executor_process_id: EXECUTOR_PROCESS.to_owned(),
        terminal_process_id: "7".to_owned(),
        accepts_input: true,
        service_start: 0,
    };
    let answering = async {
        let first = fake.next_sent().await;
        let second = fake.next_sent().await;
        fake.write(&json!({ "id": second["id"], "result": { "status": "accepted" } }))
            .await;
        (first, second)
    };

    let command_id = command_id();
    let (written, (first, second)) = tokio::join!(
        write_input(&executor, &command, "yes\n", &command_id),
        answering
    );

    assert!(written.is_ok(), "{written:?}");
    assert_eq!(first["method"], "process/write");
    assert_ne!(first["id"], second["id"]);
    assert_eq!(first["params"], second["params"]);
    assert_eq!(first["params"]["chunk"], "eWVzCg==");
}

// A terminate of a command a wrapper runs first has the wrapper asked, through the session's real
// channel, to end its command, and is held until the executor reports the command ended or the
// hold runs out. Killed by a terminate passed on at once.
#[tokio::test]
async fn a_terminate_asks_the_paired_wrapper_first_and_passes_on_at_the_commands_end() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let sets = unbound_running_command_sets();
    let relay = relay_reporting_to(
        folder.path(),
        Some(Arc::clone(&sets)),
        session_threads(session_id),
    );
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let channel = relay
        .session_channel(session_id, &executor)
        .await
        .expect("the session's channel opens")
        .expect("the running commands are registered");
    relay.record_command(
        CALL.to_owned(),
        RelayedCommand {
            session_id,
            thread_id: THREAD.to_owned(),
            executor_process_id: EXECUTOR_PROCESS.to_owned(),
            terminal_process_id: "7".to_owned(),
            accepts_input: false,
            service_start: 0,
        },
    );
    sets.command_started(CommandStart {
        session_id,
        command_id: command_id(),
        run_id: new_run_id(),
        name: NonEmptyText::new("sleep 60".to_owned()).expect("a name"),
        started_at: WireInstant::now(),
        line: None,
        process_id: Some(EXECUTOR_PROCESS.to_owned()),
        is_backgrounded: false,
        can_move_to_background: false,
        accepts_input: false,
    });
    // The wrapper: a process under the executor's, whose start names the executor's process.
    let keys = new_party_keys();
    let mut wrapper = party_command(&keys, None)
        .spawn()
        .expect("the wrapper starts");
    let mut lines = std::io::BufRead::lines(std::io::BufReader::new(
        wrapper.stdout.take().expect("its output"),
    ));
    let party = ready_parties(&mut lines, 1)[0];
    write_party_record(
        &channel.channel,
        &keys,
        party,
        1,
        &PartyRecord::Starting {
            command: "sleep 60".to_owned(),
            stdout_path: None,
            process: Some(EXECUTOR_PROCESS.to_owned()),
        },
    );
    wait_until(|| sets.paired_wrapper(session_id, &command_id()) == Some(party)).await;
    // The wrapper's pairing sends it `Go`, so the stop is the second request written whole.
    let written_requests = || {
        sent_requests(&channel.channel)
            .iter()
            .filter(|name| {
                Path::new(name)
                    .extension()
                    .is_none_or(|extension| extension != "tmp")
            })
            .count()
    };
    wait_until(|| written_requests() == 1).await;
    // From here the clock moves only once nothing can run, so the hold cannot run out before the
    // poll below, and a terminate passed on at once reaches the executor before it.
    tokio::time::pause();

    let terminate = json!({

        "id": 4,
        "method": "process/terminate",
        "params": { "processId": EXECUTOR_PROCESS },
    });
    let terminating = tokio::spawn(
        Arc::clone(&relay).forward_terminate(Arc::clone(&executor), terminate.to_string()),
    );
    wait_until(|| written_requests() == 2).await;

    // Held once the wrapper is asked: nothing has reached the executor yet. `next_line` is
    // cancel-safe, so this one poll loses no line.
    let sent_early = fake.next_sent().now_or_never();
    assert!(sent_early.is_none(), "sent at once: {sent_early:?}");
    assert!(!terminating.is_finished());
    fake.write(&exited(EXECUTOR_PROCESS)).await;
    assert_eq!(fake.next_sent().await, terminate);
    terminating.await.expect("the terminate passed on");
    end_party(wrapper);
}

// A stop of Codex's own background terminal is answered done only when Codex says it terminated.
#[tokio::test]
async fn stops_only_on_codex_terminated() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let mut scripted = start_scripted_codex_service();
    let mut driver = CodexDriver::new(&test_driver_services());
    driver.registry = CodexServiceRegistry::holding(&scripted);
    let relay = scripted
        .service
        .exec_relay_or_insert_with(|| relay_for(session_id, folder.path()));
    let (executor, _fake) = initialized_executor().await;
    relay.take_executor(executor);
    let params = || RunningCommandParams {
        session_id,
        binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a binding id"),
        command_id: command_id(),
    };

    for (terminated, answers_done) in [(false, false), (true, true)] {
        relay.record_command(
            CALL.to_owned(),
            RelayedCommand {
                session_id,
                thread_id: THREAD.to_owned(),
                executor_process_id: EXECUTOR_PROCESS.to_owned(),
                terminal_process_id: "7".to_owned(),
                accepts_input: false,
                service_start: 0,
            },
        );
        let answering = async {
            let request = scripted
                .next_request("thread/backgroundTerminals/terminate")
                .await;
            assert_eq!(
                request["params"],
                json!({ "threadId": THREAD, "processId": "7" })
            );
            scripted
                .script
                .answer(&request, &json!({ "terminated": terminated }));
        };
        let (stopped, ()) = tokio::join!(driver.stop_command(params()), answering);
        match stopped {
            Ok(()) => assert!(answers_done),
            Err(DriverError::Refused(refusal)) => {
                assert!(!answers_done);
                assert_eq!(refusal.code, RefusalCode::AgentCommandNotStopped);
            }
            Err(other) => panic!("the stop failed otherwise: {other:?}"),
        }
    }
}

/// The one command the parity turn asks Codex to run: two lines, one on standard error, and a
/// failing exit code, so output, order and code are all compared.
const PARITY_COMMAND: &str = "printf 'one\\n'; printf 'two\\n' >&2; exit 3";

/// How long the parity turn may take on a real account.
const PARITY_TURN_DEADLINE: Duration = Duration::from_secs(300);

// One command run in one turn on the signed-in account home `SIDEKICKS_TEST_CODEX_HOME` names,
// with the downloaded Codex build `SIDEKICKS_TEST_CODEX_PROGRAM` names, reads the same output and
// exit code through the relay, on the account's service with the relay's environment selected, as
// when Codex runs it itself, on a service of the same home with no relay. Killed by a relayed
// side that runs its command locally, which the relay's count of process starts shows.
#[tokio::test]
#[ignore = "needs a downloaded Codex release and a signed-in account"]
async fn a_relayed_commands_output_reads_as_codexs_own() {
    let program = std::env::var_os("SIDEKICKS_TEST_CODEX_PROGRAM")
        .expect("SIDEKICKS_TEST_CODEX_PROGRAM names the downloaded Codex program");
    let home = PathBuf::from(
        std::env::var_os("SIDEKICKS_TEST_CODEX_HOME")
            .expect("SIDEKICKS_TEST_CODEX_HOME names a signed-in Codex home"),
    );
    let (relayed, relayed_starts) = run_parity_turn(
        &program,
        &home,
        CodexHomeKind::Account(test_provider_account_id()),
    )
    .await;
    let (local, _) = run_parity_turn(&program, &home, CodexHomeKind::CapabilityRead).await;
    assert!(!relayed.is_empty(), "the turn ran the command");
    assert!(relayed_starts > 0, "the command went through the relay");
    assert_eq!(relayed, local);
}

// The output and exit code of each command one turn on `home` ran, on a service of `kind`, and
// the process starts its relay forwarded: an account's selects the relay's environment, so its
// commands go through the relay, a capability read's runs them itself.
async fn run_parity_turn(
    program: &OsString,
    home: &Path,
    kind: CodexHomeKind,
) -> (Vec<(Option<String>, Option<i64>)>, u64) {
    let is_relayed = matches!(kind, CodexHomeKind::Account(_));
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let environment = ["HOME", "PATH"]
        .into_iter()
        .filter_map(|name| Some((name.to_owned(), std::env::var(name).ok()?)))
        .collect();
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program: PathBuf::from(program),
            environment,
        }),
        Arc::new(UnheardEvents),
    );
    let socket = folder.path().join("codex.sock");
    let service = CodexService::new(
        CodexServiceHome {
            codex_home: home.to_owned(),
            kind,
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Account,
        dependencies,
        Vec::new(),
    );
    let (events, mut frames) = CodexDetachedFrames::new();
    let connection = service
        .open_detached_connection(events)
        .await
        .expect("the service starts and is dialed");
    let mut thread_start = json!({
        "cwd": folder.path(),
        "ephemeral": true,
        "approvalPolicy": "never",
        "sandbox": "danger-full-access",
    });
    if is_relayed {
        thread_start["environments"] = json!(compose_codex_relay_environments(folder.path()));
    }
    let started = connection
        .request(THREAD_START_METHOD, &thread_start)
        .await
        .expect("a conversation starts");
    let started: Value = serde_json::from_str(started.get()).expect("the reply is JSON");
    let prompt = format!(
        "Run exactly this shell command once, with no other command, then stop: {PARITY_COMMAND}"
    );
    connection
        .request(
            TURN_START_METHOD,
            &json!({
                "threadId": started["thread"]["id"],
                "input": [{ "type": "text", "text": prompt }],
            }),
        )
        .await
        .expect("the turn starts");
    let mut commands = Vec::new();
    let collected = tokio::time::timeout(PARITY_TURN_DEADLINE, async {
        while let Some((method, params)) = frames.recv().await {
            let params: Value = serde_json::from_str(params.get()).expect("the params are JSON");
            match method.as_str() {
                "item/completed" if params["item"]["type"] == "commandExecution" => {
                    commands.push((
                        params["item"]["aggregatedOutput"]
                            .as_str()
                            .map(str::to_owned),
                        params["item"]["exitCode"].as_i64(),
                    ));
                }
                "turn/completed" => return,
                _ => {}
            }
        }
    })
    .await;
    let relayed_starts = service
        .exec_relay()
        .map_or(0, |relay| relay.process_starts());
    service.stop().await;
    collected.expect("the turn ends within its deadline");
    (commands, relayed_starts)
}
