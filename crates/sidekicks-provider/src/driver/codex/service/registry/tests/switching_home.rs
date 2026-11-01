//! The switching service's home on real processes: rejoined by its record after a restart and
//! listed for the backup, holding the conversations a purge deletes there, and apart from the
//! account home whose socket a terminal's plain `codex` joins.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, ProgramStart, read_socket_link,
    short_socket_folder,
};

use super::stand_in::{
    StandInServices, another_daemon, is_running, last_launch_arguments, services_on, this_daemon,
    wait_until_gone,
};
use crate::account::homes::{account_home_conversation_folders, switching_homes};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::CODEX_EPHEMERAL_CREDENTIAL_STORE;
use crate::driver::codex::service::home::{CodexConversationHome, CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{home_socket_path, switching_home};
use crate::driver::codex::service::supervisor::CodexProgramResolver;
use crate::driver::codex::service::supervisor::test_service::{
    CODEX_HOME_NAME, REQUEST_RECORD_NAME, TestCodexProgram,
};
use crate::driver::codex::session::purge::purge_codex_conversations;
use crate::driver::contract::MockProviderDriver;
use crate::driver::contract::error::DriverError;
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::driver::registry::ProviderRegistry;
use crate::driver::session_control::{PurgeSessionParams, PurgedConversation};
use crate::driver::test_registry::{new_session_id, test_driver_services};
use crate::driver::{PROVIDERS, ProviderRegistration};
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::spawned_version::ResolvedProviderExecutable;

/// The conversation the purge deletes from the switching home.
const SWITCHING_THREAD: &str = "switching-thread-1";

/// The test's stand-in run with each home as its `CODEX_HOME`, as the daemon's own resolver runs
/// Codex, recording each home's requests in a file of its own beside the homes.
struct ProgramPerHome {
    program: TestCodexProgram,
    records_folder: PathBuf,
}

impl CodexProgramResolver for ProgramPerHome {
    fn resolve<'call>(
        &'call self,
        home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
        let mut environment: Vec<(String, String)> = self
            .program
            .environment
            .iter()
            .filter(|(name, _)| name != CODEX_HOME_NAME)
            .cloned()
            .collect();
        environment.extend([
            (
                CODEX_HOME_NAME.to_owned(),
                home.codex_home.display().to_string(),
            ),
            (
                REQUEST_RECORD_NAME.to_owned(),
                request_record(&self.records_folder, &home.codex_home)
                    .display()
                    .to_string(),
            ),
        ]);
        let resolved = ResolvedProviderExecutable {
            requested_command: "codex".to_owned(),
            resolved_executable_path: self.program.program.clone(),
            start: ProgramStart {
                program: self.program.program.clone(),
                leading_arguments: Vec::new(),
            },
            environment,
        };
        Box::pin(async move { Ok(resolved) })
    }
}

// The file the requests of the service on `codex_home` are recorded in, under `records_folder`.
fn request_record(records_folder: &Path, codex_home: &Path) -> PathBuf {
    let name = codex_home
        .file_name()
        .expect("a home names a folder")
        .to_string_lossy();
    records_folder.join(format!("{name}-requests"))
}

// The services of one test on an account's home, each home's stand-in on its own home.
fn per_home_services() -> StandInServices {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("account");
    std::fs::create_dir_all(&codex_home).expect("the home is made");
    let home = CodexServiceHome {
        codex_home,
        kind: CodexHomeKind::Account(test_provider_account_id()),
    };
    let records_folder = folder.path().to_owned();
    services_on(home, folder, move |program| {
        Arc::new(ProgramPerHome {
            program,
            records_folder,
        })
    })
}

// Every entry under `folder`, by path, with a file's bytes; a socket, a link or a folder by its
// kind.
fn read_tree(folder: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut tree = BTreeMap::new();
    let mut pending = vec![folder.to_owned()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).expect("the folder lists") {
            let path = entry.expect("the entry reads").path();
            let file_type = std::fs::symlink_metadata(&path)
                .expect("the entry reads")
                .file_type();
            let content = if file_type.is_dir() {
                pending.push(path.clone());
                b"folder".to_vec()
            } else if file_type.is_file() {
                std::fs::read(&path).expect("the file reads")
            } else {
                format!("{file_type:?}").into_bytes()
            };
            tree.insert(path, content);
        }
    }
    tree
}

// Fails when a restart stops the switching service, when the next daemon launches another instead
// of joining it by its record, when it runs without the ephemeral sign-in store, or when the
// backup's homes leave its home out.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_rejoins_the_switching_service_by_its_record_and_the_backup_lists_its_home() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = per_home_services();
    let startup_timeout = services.dependencies.startup_timeout;
    let data_folder = services.dependencies.data_folder.clone();

    let first = this_daemon(&services);
    let kept = first
        .switching_service()
        .await
        .expect("the switching home is made");
    let started = kept.ensure_started(startup_timeout).await;
    let kept_process = kept.process_id().expect("the service runs a process");
    let arguments = last_launch_arguments(&services);
    first.shutdown(DaemonStopIntent::Restart).await;
    let is_kept_running = is_running(kept_process);

    let next = another_daemon(&services);
    let joined = next
        .switching_service()
        .await
        .expect("the switching home is made");
    let rejoined = joined.ensure_started(startup_timeout).await;
    let joined_process = joined.process_id();
    let joined_home = joined.home().codex_home.clone();
    next.shutdown(DaemonStopIntent::Stop).await;
    let is_stopped = wait_until_gone(kept_process).await;

    let table: Vec<ProviderRegistration> = PROVIDERS
        .iter()
        .map(|descriptor| ProviderRegistration {
            descriptor,
            build: |_| Arc::new(MockProviderDriver::new()),
        })
        .collect();
    let providers = ProviderRegistry::register_from(&table, &test_driver_services());
    let listed: Vec<(String, PathBuf)> = switching_homes(&providers, &data_folder)
        .into_iter()
        .map(|listed| (listed.provider, listed.home))
        .collect();
    let backed_up: Vec<PathBuf> =
        account_home_conversation_folders(&providers, DESCRIPTOR.id, &joined_home)
            .into_iter()
            .map(|(_, folder)| folder)
            .collect();

    assert!(started.is_ok(), "{started:?}");
    assert!(
        arguments
            .iter()
            .any(|argument| argument == CODEX_EPHEMERAL_CREDENTIAL_STORE),
        "{arguments:?}"
    );
    assert!(!joined_home.join("auth.json").exists());
    assert!(is_kept_running, "the restart stopped the switching service");
    assert!(rejoined.is_ok(), "{rejoined:?}");
    assert_eq!(joined_process, Some(kept_process));
    assert!(is_stopped, "the stop left the switching service running");
    assert_eq!(joined_home, switching_home(&data_folder));
    assert_eq!(
        listed,
        vec![(DESCRIPTOR.id.to_owned(), joined_home.clone())]
    );
    assert_eq!(backed_up, vec![joined_home.join("sessions")]);
}

// Fails when the purge sends an unpinned conversation's delete to its account's service, which
// then starts in the account home and writes there, instead of to the switching service.
#[tokio::test(flavor = "multi_thread")]
async fn a_purge_deletes_an_unpinned_conversation_from_the_switching_home_alone() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = per_home_services();
    let startup_timeout = services.dependencies.startup_timeout;
    let registry = this_daemon(&services);
    let account_home = services.home.codex_home.clone();
    let before = read_tree(&account_home);
    let mut runtime_metadata = Map::new();
    CodexConversationHome::Switching.keep_in(&mut runtime_metadata);
    let params = PurgeSessionParams {
        session_id: new_session_id(),
        conversations: vec![PurgedConversation {
            resume_handle: SWITCHING_THREAD.to_owned(),
            provider_account_id: test_provider_account_id(),
            runtime_metadata,
        }],
    };

    let purged = purge_codex_conversations(
        &registry,
        &services.folder.path().join("roles"),
        startup_timeout,
        &params,
    )
    .await;
    let after = read_tree(&account_home);
    registry.shutdown(DaemonStopIntent::Stop).await;
    let switching_record = request_record(
        services.folder.path(),
        &switching_home(&services.dependencies.data_folder),
    );
    let deleted: Vec<Value> = std::fs::read_to_string(switching_record)
        .expect("the switching service's requests were recorded")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a request is JSON"))
        .filter(|request| request["method"] == "thread/delete")
        .map(|request| request["params"]["threadId"].clone())
        .collect();

    assert!(purged.is_ok(), "{purged:?}");
    assert_eq!(deleted, vec![Value::from(SWITCHING_THREAD)]);
    assert_eq!(before, after, "the purge touched the account home");
}

// Fails when the switching service takes the account home, so a plain `codex` there would join it
// rather than the account's own service.
#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_in_an_account_home_joins_the_accounts_own_service() {
    if !CAN_BIND_A_SOCKET_LISTENER || !CAN_LINK_A_SOCKET {
        return;
    }
    let services = per_home_services();
    let startup_timeout = services.dependencies.startup_timeout;
    let registry = this_daemon(&services);
    let account_home = services.home.codex_home.clone();

    let account = registry
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let switching = registry
        .switching_service()
        .await
        .expect("the switching home is made");
    let account_started = account.ensure_started(startup_timeout).await;
    let switching_started = switching.ensure_started(startup_timeout).await;
    let account_process = account.process_id();
    let switching_process = switching.process_id();
    let joined = read_socket_link(&home_socket_path(&account_home)).expect("the link reads");
    registry.shutdown(DaemonStopIntent::Stop).await;

    assert!(account_started.is_ok(), "{account_started:?}");
    assert!(switching_started.is_ok(), "{switching_started:?}");
    assert_ne!(account_process, switching_process);
    let account_process = account_process.expect("the account's service runs a process");
    assert_eq!(
        joined,
        Some(account_home.join(format!("real-{account_process}.sock")))
    );
}
