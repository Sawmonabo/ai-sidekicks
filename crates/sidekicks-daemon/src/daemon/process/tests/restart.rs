use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, params};
use serde_json::json;
use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint};
use sidekicks_contracts::daemon::lifecycle::DaemonRestart;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{create_missing_private_folders, short_socket_folder};
use sidekicks_provider::driver::test_registry::{
    CodexServiceStandIn, RESUMED_TURN_NAME, serve_as_codex_service_stand_in, stand_in_codex_service,
};
use sidekicks_provider::runtime_binding::store::{
    RUNTIME_BINDING_STORE_STATEMENT_CAPACITY, RuntimeBindingStore, mint_runtime_binding_id,
};
use sidekicks_provider::runtime_binding::test_store::{bind_resumable, test_provider_account_id};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::connection::writer_open::{
    DAEMON_DATABASE_FILE_NAME, open_database,
};
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{
    insert_test_event, test_run_id, test_session_id,
};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_workspace::git::process::test_git_runner;
use sidekicks_workspace::git::process::test_repository::git_in;
use sidekicks_workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::{STOP_WAIT, TestHome};
use crate::daemon::process::stop::DaemonStopReason;
use crate::daemon::schema::schema_parts;

// The provider turn the seeded run was running when the daemon stopped.
const SEEDED_TURN_ID: &str = "turn-1";

// The Codex service the daemons in these tests launch: this test binary, run through the
// stand-in's script as `codex`, serving as a lasting terminal service. Run only that way.
#[tokio::test]
#[ignore = "the restarted daemons' Codex service, run through its script"]
async fn codex_service_stand_in() {
    serve_as_codex_service_stand_in().await;
}

// The stand-in test's path in this program, which its script runs.
pub(super) fn stand_in_test() -> String {
    format!(
        "{}::codex_service_stand_in",
        module_path!()
            .split_once("::")
            .map(|(_crate, path)| path)
            .expect("the module path names its crate")
    )
}

// A Codex run the last daemon left running, seeded in a home's store before any start: the
// provider's current account, whose home stands in its own folder; a chat session in a git
// repository whose lead runs on Codex; its run, running its seeded turn; and the run's binding,
// holding the conversation a resume brings back.
pub(super) struct SeededCodexRun {
    session_id: SessionId,
    pub(super) run_id: RunId,
    account_home: PathBuf,
    _folders: [TempDir; 2],
}

impl SeededCodexRun {
    // Seeds the run in `home`'s store, made with the daemon's schema.
    pub(super) async fn seed(home: &TestHome) -> Self {
        let data_folder = home.data_folder();
        create_missing_private_folders(&data_folder).expect("the data folder is made");
        let database_path = data_folder.join(DAEMON_DATABASE_FILE_NAME);
        let schema = schema_parts().into_schema();
        let connection = open_database(&database_path, &schema).expect("the store opens");
        // Its own short folder, since the services on it listen on sockets inside it.
        let account_folder = short_socket_folder().expect("the account's folder is made");
        let account_home = account_folder.path().join("account");
        std::fs::create_dir(&account_home).expect("the account's home is made");
        let repository = tempfile::tempdir().expect("the repository's folder is made");
        // Through the runner, which drops a caller's `GIT_DIR`, so the init stays in this folder.
        git_in(&test_git_runner(), repository.path(), &["init", "--quiet"]).await;
        let session_id = test_session_id();
        let run_id = test_run_id();
        seed_rows(
            &connection,
            &account_home,
            &repository
                .path()
                .canonicalize()
                .expect("the repository resolves"),
            session_id,
            run_id,
        );
        drop(connection);
        let writer = Arc::new(
            DatabaseWriter::open(
                move || open_database(&database_path, &schema),
                DatabaseWriterOptions::default(),
            )
            .await
            .expect("the writer opens the store"),
        );
        let bindings = RuntimeBindingStore::new(
            Arc::new(DatabaseReadPool::new(
                data_folder.join(DAEMON_DATABASE_FILE_NAME),
                RUNTIME_BINDING_STORE_STATEMENT_CAPACITY,
            )),
            Arc::clone(&writer),
        );
        bind_resumable(
            &bindings,
            run_id,
            ProviderId::new("codex".to_owned()).expect("a provider id"),
        )
        .await;
        writer.close(None).await.expect("the writer closes");
        Self {
            session_id,
            run_id,
            account_home,
            _folders: [account_folder, repository],
        }
    }

    // The environment the stand-in serves in, the seeded turn listed as `turn_status` on every
    // conversation it resumes, with this program's git after the stand-in's `codex` on the search
    // path, since the session's opening reads its repository through git.
    pub(super) fn provider_environment(
        stand_in: &CodexServiceStandIn,
        turn_status: &str,
    ) -> Vec<(String, String)> {
        let turn = json!({"id": SEEDED_TURN_ID, "items": [], "status": turn_status});
        let search_path = std::env::var_os("PATH").expect("this program has a search path");
        let git_folder = std::env::split_paths(&search_path)
            .find(|folder| folder.join("git").is_file())
            .expect("git is on this program's search path");
        let mut environment = stand_in.provider_environment();
        for (name, value) in &mut environment {
            if name == "PATH" {
                value.push(':');
                value.push_str(git_folder.to_str().expect("the folder's path is text"));
            }
        }
        environment.push((RESUMED_TURN_NAME.to_owned(), turn.to_string()));
        environment
    }
}

// Writes the seeded run's rows on `connection`: the account on `account_home`, the session in
// `repository` with its lead, the run on its turn, each as the daemon stores it.
pub(super) fn seed_rows(
    connection: &Connection,
    account_home: &Path,
    repository: &Path,
    session_id: SessionId,
    run_id: RunId,
) {
    let now = WireInstant::now();
    connection
        .execute(
            "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
               billing_mode, is_default, created_at, updated_at)
             VALUES (?1, 'codex', ?2, 'unknown', 1, ?3, ?3)",
            params![
                test_provider_account_id().as_str(),
                account_home.to_str().expect("the home's path is text"),
                now.as_str(),
            ],
        )
        .expect("the account is stored");
    insert_session_row(connection, session_id.text().as_str(), None, None);
    let mount_id = mint_uuid_v7().to_string();
    for row in project_and_mount_rows(&mount_id, None) {
        connection
            .execute_batch(&row)
            .expect("the project and its mount are stored");
    }
    connection
        .execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, state,
               created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                mint_uuid_v7().to_string(),
                session_id.text().as_str(),
                mount_id,
                <&'static str>::from(ExecutionMode::BoundRoot),
                repository.to_str().expect("the repository's path is text"),
                <&'static str>::from(WorkspaceState::Ready),
                PARENT_ROWS_AT,
            ],
        )
        .expect("the workspace is stored");
    connection
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version) \
             VALUES (?1, ?2, 'running', 1)",
            params![run_id.text().as_str(), session_id.text().as_str()],
        )
        .expect("the run is stored");
    for event in [
        json!({"type": "session.created", "payload": {
            "sessionId": session_id,
            "shape": "chat",
            "mainAgent": {
                "agentId": mint_uuid_v7().to_string(),
                "name": "lead",
                "binding": {
                    "providerName": "codex",
                    "modelId": "gpt-5",
                    "providerAccountId": test_provider_account_id().as_str(),
                    "effort": null,
                },
                "ancestry": [],
                "createdAt": now.as_str(),
            },
        }}),
        json!({"type": "agent.turn.started", "payload": {
            "sessionId": session_id,
            "runId": run_id,
            "runVersion": 1,
            "turnNumber": 1,
            "providerTurnId": SEEDED_TURN_ID,
        }}),
    ] {
        insert_test_event(connection, session_id, event, None, now.as_str());
    }
}

// The state the store holds for `run_id` in `home`.
pub(super) fn stored_run_state(home: &TestHome, run_id: RunId) -> String {
    Connection::open(home.data_folder().join(DAEMON_DATABASE_FILE_NAME))
        .expect("the store opens")
        .query_row(
            "SELECT state FROM runs WHERE run_id = ?1",
            [run_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the run's state reads")
}

// A `daemon.restart` keeps the terminal service the first daemon launched on the person's own
// Codex folder, and the next start joins that same process before it binds its socket, so before
// its recovery pass: every connection the second daemon makes to a service on the folder reaches
// the process the first launched, the first of them, the join, while the second daemon's socket
// is not yet there. Killed by the restart ending the service, where the second daemon launches
// one of its own, and by the stored rows applied after the recovery pass, where the join comes
// after the socket is bound.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_keeps_the_terminal_service_and_the_next_start_joins_it_first() {
    let stand_in_test = stand_in_test();
    let home = TestHome::new();
    let Some(stand_in) = stand_in_codex_service(
        &stand_in_test,
        &home.run_folder.socket_path,
        &home.data_folder(),
    ) else {
        return;
    };
    let home = home.with_provider_environment(stand_in.provider_environment());

    let mut first = home
        .start(CancellationToken::new())
        .await
        .expect("the first daemon starts");
    let launched = stand_in.launches();
    let first_daemons_connections = stand_in.connections().len();
    let caller = DaemonConnection::connect(DaemonEndpoint::new(home.run_folder.clone()))
        .await
        .expect("the caller connects");
    caller
        .client()
        .call::<DaemonRestart>(&EmptyPayload {})
        .await
        .expect("the restart is accepted");
    caller.close().await;
    let asked = tokio::time::timeout(STOP_WAIT, first.wait_for_stop())
        .await
        .expect("the restart reaches the process");
    first
        .stop(asked)
        .await
        .expect("the first daemon's stop fails nothing");
    let second = home
        .start(CancellationToken::new())
        .await
        .expect("the second daemon starts");
    let launches = stand_in.launches();
    let connections = stand_in.connections();
    second
        .stop(DaemonStopReason::Stop)
        .await
        .expect("the second daemon's stop fails nothing");

    assert_eq!(asked, DaemonStopReason::Restart);
    assert_eq!(launched.len(), 1, "the first daemon launches its service");
    assert_eq!(launches, launched, "the second daemon launched a service");
    let second_daemons = connections
        .get(first_daemons_connections..)
        .expect("the first daemon's connections stay recorded");
    let join = second_daemons
        .first()
        .expect("the second daemon reaches the service");
    assert!(
        !join.is_daemon_socket_bound,
        "the join came after the socket: {second_daemons:?}"
    );
}

// A `daemon.restart` keeps the Codex service an account's run was resumed on, with the turn it was
// running, and the next start's recovery pass resumes the run on that same process: the account's
// home has one launch across both daemons, and the second daemon's first connection to it is the
// join its resume is asked on. Killed by the restart ending the account's service, where the
// second daemon launches one of its own, and by the kept service not joined again, where the
// second daemon's resume reaches no connection to it.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_keeps_a_resumed_runs_account_service_and_the_next_pass_resumes_on_it() {
    let home = TestHome::new();
    let Some(stand_in) = stand_in_codex_service(
        &stand_in_test(),
        &home.run_folder.socket_path,
        &home.data_folder(),
    ) else {
        return;
    };
    let seeded = SeededCodexRun::seed(&home).await;
    let home = home.with_provider_environment(SeededCodexRun::provider_environment(
        &stand_in,
        "inProgress",
    ));

    let mut first = home
        .start(CancellationToken::new())
        .await
        .expect("the first daemon starts");
    let launched = stand_in.launches_on(&seeded.account_home);
    let account_connections = |stand_in: &CodexServiceStandIn, process_id: u32| {
        stand_in
            .connections()
            .into_iter()
            .filter(|connection| connection.process_id == process_id)
            .collect::<Vec<_>>()
    };
    let [account_process] = launched[..] else {
        panic!("the first daemon's pass launches the account's service: {launched:?}");
    };
    let first_daemons_connections = account_connections(&stand_in, account_process).len();
    let caller = DaemonConnection::connect(DaemonEndpoint::new(home.run_folder.clone()))
        .await
        .expect("the caller connects");
    caller
        .client()
        .call::<DaemonRestart>(&EmptyPayload {})
        .await
        .expect("the restart is accepted");
    caller.close().await;
    let asked = tokio::time::timeout(STOP_WAIT, first.wait_for_stop())
        .await
        .expect("the restart reaches the process");
    first
        .stop(asked)
        .await
        .expect("the first daemon's stop fails nothing");
    let second = home
        .start(CancellationToken::new())
        .await
        .expect("the second daemon starts");
    let launches = stand_in.launches_on(&seeded.account_home);
    let connections = account_connections(&stand_in, account_process);
    let run_state = stored_run_state(&home, seeded.run_id);
    second
        .stop(DaemonStopReason::Stop)
        .await
        .expect("the second daemon's stop fails nothing");

    assert_eq!(asked, DaemonStopReason::Restart);
    assert_eq!(launches, launched, "the second daemon launched a service");
    let second_daemons = connections
        .get(first_daemons_connections..)
        .expect("the first daemon's connections stay recorded");
    let join = second_daemons
        .first()
        .expect("the second daemon reaches the kept service");
    assert_eq!(
        join.methods.first().map(String::as_str),
        Some("initialize"),
        "{second_daemons:?}"
    );
    assert!(
        join.methods.iter().any(|method| method == "thread/resume"),
        "the resume came on no join of the kept service: {second_daemons:?}"
    );
    assert_eq!(run_state, "running", "the resumed run goes on");
}

// A run the start's recovery pass resumes, whose turn its account's service lists as over, is
// ended by the pass's finalize, and its binding's cursors are marked to drop then: the session's
// next binding drops them, so the cursor of the binding the resume opened is closed. Killed by the
// binding cursors' follow attached after the recovery pass, where the end goes unheard and the
// resumed binding's cursor stays open.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_the_recovery_pass_ends_has_its_binding_cursors_dropped_at_the_next_binding() {
    let home = TestHome::new();
    let Some(stand_in) = stand_in_codex_service(
        &stand_in_test(),
        &home.run_folder.socket_path,
        &home.data_folder(),
    ) else {
        return;
    };
    let seeded = SeededCodexRun::seed(&home).await;
    let home = home
        .with_provider_environment(SeededCodexRun::provider_environment(&stand_in, "completed"));

    let daemon = home
        .start(CancellationToken::new())
        .await
        .expect("the daemon starts");
    let run_state = stored_run_state(&home, seeded.run_id);
    let binding_cursors = Arc::clone(
        &daemon
            .session
            .as_ref()
            .expect("a started daemon holds its session services")
            .binding_cursors,
    );
    let resumed_binding = binding_cursors.current_binding(&seeded.session_id);
    let next_binding = binding_cursors
        .open_binding(
            seeded.session_id,
            mint_runtime_binding_id(),
            seeded.run_id,
            ProviderId::new("codex".to_owned()).expect("a provider id"),
            test_provider_account_id(),
        )
        .await;
    let is_resumed_cursor_open = resumed_binding
        .as_ref()
        .is_some_and(|binding_id| binding_cursors.is_binding_open(binding_id));
    daemon
        .stop(DaemonStopReason::Stop)
        .await
        .expect("the daemon's stop fails nothing");

    assert_eq!(run_state, "completed", "the pass's finalize ends the run");
    assert!(
        resumed_binding.is_some(),
        "the resume's binding holds the session"
    );
    next_binding.expect("the session's next binding opens");
    assert!(
        !is_resumed_cursor_open,
        "the resumed binding's cursor outlived its run's end"
    );
}
