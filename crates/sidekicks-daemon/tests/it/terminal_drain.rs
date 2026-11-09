//! The terminals' drain at the service's stop: a shell that ignores its stop is killed at the
//! terminals' own bound, so the rest of the stop's time stays the drivers'; a shell asked for once
//! the drain began is refused; and a client that leaves drains nothing.

use std::fs;
use std::path::Path;
use std::pin::pin;
use std::time::Duration;

use futures::StreamExt as _;
use rusqlite::{Connection, params};
use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint};
use sidekicks_contracts::daemon::lifecycle::{DAEMON_STOP_TERMINAL_DRAIN_MS, DaemonStop};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};
use sidekicks_contracts::terminal::control::{TerminalControlTake, TerminalControlTakeRequest};
use sidekicks_contracts::terminal::{
    TerminalOpen, TerminalOpenRequest, TerminalOutputSubscribe, TerminalOutputSubscribeRequest,
    TerminalWrite, TerminalWriteRequest,
};
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_daemon::daemon::schema::schema_parts;
use sidekicks_platforms::{
    DaemonRunFolder, PinnedProcess, create_missing_private_folders, default_shell,
    pin_running_process, run_test_as_own_root,
};
use sidekicks_shell::mode::SHELL_MODE;
use sidekicks_store::data_folder::data_folder;
use sidekicks_store::database::connection::writer_open::{
    DAEMON_DATABASE_FILE_NAME, open_database,
};
use sidekicks_terminal::{
    CommandLine, DrainResult, ShellCommand, SpawnRequest, TerminalError, TerminalEvent, Terminals,
};
use sidekicks_workspace::test_rows::{PARENT_ROWS_AT, insert_held_managed_mount};
use tokio::process::Child;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::helpers::{
    DAEMON_PROGRAM, KeepAllOutput, NoListener, SERVICE_RUN_BOUND, service_run_folder, short_home,
    spawner, start_ready_service,
};

/// The bound on each wait for a shell to start or to write, so a shell that hangs fails the test.
const WAIT_BOUND: Duration = Duration::from_secs(30);

/// How often a wait reads whether the shell still runs or has written its process id.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// What the stop-ignoring shell writes once its stop is ignored.
const STOP_IGNORED_MARK: &str = "stop-ignored";

/// The service, ready, with one shell open through its socket that ignores its stop and has
/// written its process id.
struct ServiceWithShell {
    /// The service's home, removed when the test ends.
    _home: tempfile::TempDir,
    /// The service's process.
    service: Child,
    /// Standard error past the ready line, read to its end.
    standard_error: JoinHandle<String>,
    /// Where the service's socket and token are.
    run_folder: DaemonRunFolder,
    /// The client's connection the shell was opened on.
    connection: DaemonConnection,
    /// The shell's process.
    shell: PinnedProcess,
}

impl ServiceWithShell {
    /// Waits for the service to end and answers its standard error; panics when it runs past its
    /// bound or exits other than 0.
    async fn wait_for_clean_exit(mut self) -> String {
        let ended = tokio::time::timeout(SERVICE_RUN_BOUND, self.service.wait())
            .await
            .expect("the service ends within its bound")
            .expect("the service's end reads");
        let standard_error = self
            .standard_error
            .await
            .expect("standard error is read to its end");
        assert_eq!(ended.code(), Some(0), "{ended}: {standard_error}");
        standard_error
    }
}

// Stores a project session working in `folder`: its directory row, a mount of the folder the
// session holds, and a ready workspace rooted there, which is what a shell's open reads. The mount
// and the workspace take minted ids, as the read of the working folder parses them.
fn seed_session_in(connection: &Connection, session_id: &str, folder: &Path) {
    let mount_id = mint_uuid_v7().to_string();
    connection
        .execute(
            "INSERT INTO sessions (id, shape, state, created_at, updated_at, last_activity_at)
             VALUES (?1, ?2, ?3, ?4, ?4, ?4)",
            params![
                session_id,
                <&'static str>::from(SessionShape::Project),
                <&'static str>::from(SessionState::Active),
                PARENT_ROWS_AT
            ],
        )
        .expect("the session is stored");
    insert_held_managed_mount(connection, &mount_id, folder, session_id);
    connection
        .execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, state,
               created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                mint_uuid_v7().to_string(),
                session_id,
                mount_id,
                <&'static str>::from(ExecutionMode::BoundRoot),
                folder.to_string_lossy(),
                <&'static str>::from(WorkspaceState::Ready),
                PARENT_ROWS_AT
            ],
        )
        .expect("the workspace is stored");
}

// Starts the service on a fresh home holding one project session, waits for it to be ready, opens
// a shell in the session through its socket, takes the shell's control, and has it ignore its stop
// and write its process id, which the shell's process is pinned by.
async fn start_service_with_shell() -> ServiceWithShell {
    let home = short_home();
    let data_folder = data_folder(home.path());
    create_missing_private_folders(&data_folder).expect("the data folder is made");
    let project_folder = home.path().join("project");
    fs::create_dir(&project_folder).expect("the project folder is made");
    let session_id = mint_uuid_v7().to_string();
    let database = open_database(
        &data_folder.join(DAEMON_DATABASE_FILE_NAME),
        &schema_parts().into_schema(),
    )
    .expect("the database opens");
    seed_session_in(&database, &session_id, &project_folder);
    drop(database);

    let (service, standard_error) = start_ready_service(home.path()).await;
    let run_folder = service_run_folder(home.path());
    let connection = DaemonConnection::connect(DaemonEndpoint::new(run_folder.clone()))
        .await
        .expect("the client connects");
    let client = connection.client();
    let session_id = SessionId::new(&session_id).expect("a minted UUID is a session id");
    let terminal_id = client
        .call::<TerminalOpen>(&TerminalOpenRequest {
            session_id,
            client_idempotency_key: ClientUuid::new(mint_uuid_v7().to_string())
                .expect("a minted UUID is a client key"),
        })
        .await
        .expect("the shell opens")
        .terminal_id;
    let (acknowledgment, mut output) = client
        .subscribe::<TerminalOutputSubscribe>(&TerminalOutputSubscribeRequest {
            session_id,
            terminal_id: terminal_id.clone(),
            after_offset: None,
        })
        .await
        .expect("the shell's output is followed");
    // Read as a pane reads it, so the shell's output never waits on the client.
    tokio::spawn(async move { while output.next().await.is_some() {} });
    let output_subscription_id = acknowledgment.subscription_id;
    client
        .call::<TerminalControlTake>(&TerminalControlTakeRequest {
            session_id,
            terminal_id: terminal_id.clone(),
            output_subscription_id,
            force: None,
        })
        .await
        .expect("the shell's control is taken");
    let process_id_file = home.path().join("shell.pid");
    let written_file = home.path().join("shell.pid.written");
    // Renamed into place once whole, so a read never sees half the id.
    let line = format!(
        "trap '' TERM; echo $$ > '{}' && mv '{}' '{}'\r",
        written_file.display(),
        written_file.display(),
        process_id_file.display()
    );
    client
        .call::<TerminalWrite>(&TerminalWriteRequest::Keys {
            session_id,
            terminal_id,
            output_subscription_id,
            data: line,
        })
        .await
        .expect("the line is written to the shell");
    let shell = pin_running_process(read_process_id(&process_id_file).await)
        .expect("the shell's process reads")
        .expect("the shell runs");
    ServiceWithShell {
        _home: home,
        service,
        standard_error,
        run_folder,
        connection,
        shell,
    }
}

// The process id the shell wrote to `file`, once the file is in place.
async fn read_process_id(file: &Path) -> u32 {
    tokio::time::timeout(WAIT_BOUND, async {
        loop {
            match fs::read_to_string(file) {
                Ok(text) => return text.trim().parse().expect("the shell wrote a process id"),
                Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::NotFound, "{error}"),
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    })
    .await
    .expect("the shell writes its process id in time")
}

// Whether `shell` has ended by `deadline`.
async fn has_ended_by(shell: &PinnedProcess, deadline: Instant) -> bool {
    loop {
        if shell.record().expect("the shell's record reads").is_none() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

// A shell that ignores the graceful stop, says so, then waits a minute in its own process.
fn stop_ignoring_shell(folder: &Path) -> SpawnRequest {
    let command = ShellCommand {
        program: default_shell().to_string_lossy().into_owned(),
        arguments: vec![
            "-c".to_owned(),
            format!("trap '' TERM; echo {STOP_IGNORED_MARK}; exec sleep 60"),
        ],
        environment: std::env::vars().collect(),
        folder: folder.to_path_buf(),
        raw_command_tail: None,
    };
    SpawnRequest {
        shell: command.clone(),
        fallback: command,
        working_directory: folder.to_path_buf(),
        rows: 24,
        columns: 80,
        shell_start: CommandLine {
            program: DAEMON_PROGRAM.to_owned(),
            arguments: vec![SHELL_MODE.to_owned(), std::process::id().to_string()],
        },
    }
}

// A shell that ignores its graceful stop is killed by the stop's ask plus the terminals' own drain
// bound and a second's margin, and the service still ends cleanly. Killed by the stop handing the
// terminals' drain all of its remaining time: the shell then lives until about 4 s after the ask.
#[tokio::test]
async fn a_shell_that_ignores_its_stop_is_killed_at_the_terminal_drain_bound() {
    let running = start_service_with_shell().await;

    let asked = Instant::now();
    running
        .connection
        .client()
        .call::<DaemonStop>(&EmptyPayload {})
        .await
        .expect("the stop is accepted");

    let deadline =
        asked + Duration::from_millis(DAEMON_STOP_TERMINAL_DRAIN_MS) + Duration::from_secs(1);
    assert!(
        has_ended_by(&running.shell, deadline).await,
        "the shell outlived the terminals' drain bound"
    );
    running.wait_for_clean_exit().await;
}

// The flag the drain sets is read by every later spawn, so a spawn asked for while the drain runs
// is refused, and the drain then counts the shell it found as forced. Killed by the drain no
// longer setting its flag; removing one of the spawn's two reads of it alone leaves the other
// refusing.
#[test]
fn a_spawn_once_the_drain_began_is_refused() {
    // The `shell` mode starts a shell only for a parent that is its own responsible process, as
    // the daemon is.
    run_test_as_own_root(
        "terminal_drain::a_spawn_once_the_drain_began_is_refused",
        || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("the test's runtime builds");
            runtime.block_on(async {
                let scratch = tempfile::tempdir().expect("a scratch folder");
                let terminals = Terminals::new(
                    spawner(),
                    CommandLine {
                        program: "console-helper".to_owned(),
                        arguments: Vec::new(),
                    },
                );
                let mut held = terminals
                    .spawn(
                        stop_ignoring_shell(scratch.path()),
                        |_answers| NoListener,
                        KeepAllOutput,
                    )
                    .await
                    .expect("the first shell starts");
                // The drain must find the shell already ignoring its stop.
                tokio::time::timeout(WAIT_BOUND, async {
                    let mut text = String::new();
                    while !text.contains(STOP_IGNORED_MARK) {
                        match held.output.next().await {
                            Some(TerminalEvent::Output(chunk)) => {
                                text.push_str(&String::from_utf8_lossy(&chunk));
                            }
                            other => panic!("the output ended before the mark: {other:?} {text:?}"),
                        }
                    }
                })
                .await
                .expect("the shell ignores its stop in time");

                let mut drain = pin!(terminals.drain(Duration::from_secs(2)));
                // One poll runs the drain up to its first wait, which is past setting its flag.
                assert!(
                    futures::poll!(&mut drain).is_pending(),
                    "the drain waits for the shell"
                );
                match terminals
                    .spawn(
                        stop_ignoring_shell(scratch.path()),
                        |_answers| NoListener,
                        KeepAllOutput,
                    )
                    .await
                {
                    Err(TerminalError::Draining) => {}
                    Err(error) => panic!("the spawn failed otherwise: {error:?}"),
                    Ok(started) => panic!("a shell started during the drain: {}", started.handle),
                }
                assert_eq!(
                    drain.await,
                    DrainResult {
                        drained: 0,
                        forced: 1
                    }
                );
            });
        },
    );
}

// A client that closes its connection with no stop, as the app's quit does, leaves its shell
// running; the shell ends only at the service's stop, asked on a fresh connection. Guards against
// a drain begun when the last client leaves: no client's leaving reaches the terminals' drain.
#[tokio::test]
async fn a_client_that_leaves_drains_nothing() {
    let ServiceWithShell {
        _home: home,
        service,
        standard_error,
        run_folder,
        connection,
        shell,
    } = start_service_with_shell().await;

    connection.close().await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(
        shell.record().expect("the shell's record reads").is_some(),
        "the shell ended when its client left"
    );

    let connection = DaemonConnection::connect(DaemonEndpoint::new(run_folder.clone()))
        .await
        .expect("a fresh client connects");
    connection
        .client()
        .call::<DaemonStop>(&EmptyPayload {})
        .await
        .expect("the stop is accepted");
    assert!(
        has_ended_by(&shell, Instant::now() + SERVICE_RUN_BOUND).await,
        "the shell outlived the service's stop"
    );
    ServiceWithShell {
        _home: home,
        service,
        standard_error,
        run_folder,
        connection,
        shell,
    }
    .wait_for_clean_exit()
    .await;
}
