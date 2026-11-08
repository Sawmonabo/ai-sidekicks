//! The switching service's home on real processes: rejoined by its record after a restart and
//! listed for the backup, holding the conversations a purge deletes there, and apart from the
//! account home whose socket a terminal's plain `codex` joins.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, read_socket_link};

use super::stand_in::{
    another_daemon, is_running, last_launch_arguments, per_home_services, recorded_methods,
    recorded_requests, this_daemon, wait_until_gone,
};
use crate::account::homes::{account_home_conversation_folders, switching_homes};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::CODEX_EPHEMERAL_CREDENTIAL_STORE;
use crate::driver::codex::service::home::{CodexConversationHome, CodexHomeKind};
use crate::driver::codex::service::registry::{home_socket_path, switching_home};
use crate::driver::codex::service::supervisor::test_service::read_tree;
use crate::driver::codex::service::supervisor::{
    CodexService, CodexServiceDependencies, CodexServiceId,
};
use crate::driver::codex::service::switching::test_sign_in::{
    AccountHomes, compose_access_token, write_sign_in,
};
use crate::driver::codex::session::purge::{CodexServiceRestarts, purge_codex_conversations};
use crate::driver::daemon_stop::{DaemonStopIntent, daemon_stop_deadline};
use crate::driver::registry::ProviderRegistry;
use crate::driver::session_control::{PurgeSessionParams, SessionConversation};
use crate::driver::test_registry::{
    new_session_id, registrations_of_mock_drivers, test_driver_services,
};
use crate::runtime_binding::test_store::test_provider_account_id;

/// The conversation the purge deletes from the switching home.
const SWITCHING_THREAD: &str = "switching-thread-1";

/// The `ChatGPT` workspace the test's account signs in to.
const TEST_WORKSPACE: &str = "workspace-of-the-test-account";

/// A purge's restarts where every delete is answered, so none is restarting or restarted.
struct NoRestarts;

impl CodexServiceRestarts for NoRestarts {
    fn is_restarting(&self, _service_id: CodexServiceId) -> bool {
        false
    }

    fn restart(&self, _service: &Arc<CodexService>) {
        panic!("an answered delete restarts no service");
    }
}

// Signs the test's account in within its own home and has `dependencies`' switching service find
// it there as the current account, so each of its starts hands that account's tokens.
fn sign_in(dependencies: &CodexServiceDependencies, account_home: &Path) {
    write_sign_in(
        account_home,
        TEST_WORKSPACE,
        &compose_access_token(TEST_WORKSPACE),
    );
    AccountHomes {
        homes: HashMap::from([(test_provider_account_id(), account_home.to_owned())]),
        current: test_provider_account_id(),
        api_keys: HashMap::new(),
    }
    .register_on(&dependencies.provider_accounts);
}

// Fails when a restart stops the switching service, when the next daemon launches another instead
// of joining it by its record, when it runs without the ephemeral sign-in store, when the backup's
// homes leave its home out, or when either start answers before the account's tokens were handed,
// so a resume could run there on none, the rejoin's hand among them.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_rejoins_the_switching_service_by_its_record_and_the_backup_lists_its_home() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = per_home_services(CodexHomeKind::Account(test_provider_account_id()));
    let startup_timeout = services.dependencies.startup_timeout;
    let data_folder = services.dependencies.data_folder.clone();

    sign_in(&services.dependencies, &services.home.codex_home);
    let first = this_daemon(&services);
    let kept = first
        .switching_service()
        .await
        .expect("the switching home is made");
    let started = kept.ensure_started(startup_timeout).await;
    let kept_process = kept.process_id().expect("the service runs a process");
    let arguments = last_launch_arguments(&services);
    first
        .shutdown(DaemonStopIntent::Restart, daemon_stop_deadline())
        .await;
    let is_kept_running = is_running(kept_process);

    let next = another_daemon(&services);
    let joined = next
        .switching_service()
        .await
        .expect("the switching home is made");
    sign_in(joined.dependencies(), &services.home.codex_home);
    let rejoined = joined.ensure_started(startup_timeout).await;
    // Read as the start answered: anything sent after, a resume among it, comes later.
    let sent_by_the_rejoin = recorded_methods(&services, &switching_home(&data_folder));
    let joined_process = joined.process_id();
    let joined_home = joined.home().codex_home.clone();
    next.shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;
    let is_stopped = wait_until_gone(kept_process).await;

    let table = registrations_of_mock_drivers();
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
    let handed: Vec<&str> = sent_by_the_rejoin
        .iter()
        .map(String::as_str)
        .filter(|method| *method != "initialize")
        .collect();
    assert_eq!(
        handed,
        [
            "environment/add",
            "account/login/start",
            "environment/add",
            "account/login/start"
        ],
        "each start hands the tokens before it answers"
    );
}

// Fails when the purge sends an unpinned conversation's delete to its account's service, which
// then starts in the account home and writes there, instead of to the switching service.
#[tokio::test(flavor = "multi_thread")]
async fn a_purge_deletes_an_unpinned_conversation_from_the_switching_home_alone() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = per_home_services(CodexHomeKind::Account(test_provider_account_id()));
    let startup_timeout = services.dependencies.startup_timeout;
    let registry = this_daemon(&services);
    let account_home = services.home.codex_home.clone();
    sign_in(&services.dependencies, &account_home);
    let before = read_tree(&account_home);
    let mut runtime_metadata = Map::new();
    CodexConversationHome::Switching.keep_in(&mut runtime_metadata);
    let params = PurgeSessionParams {
        session_id: new_session_id(),
        conversations: vec![SessionConversation {
            resume_handle: SWITCHING_THREAD.to_owned(),
            provider_account_id: test_provider_account_id(),
            runtime_metadata,
        }],
    };

    let purged = purge_codex_conversations(
        &registry,
        &NoRestarts,
        &services.folder.path().join("roles"),
        startup_timeout,
        &params,
    )
    .await;
    let after = read_tree(&account_home);
    registry
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;
    let deleted: Vec<Value> = recorded_requests(
        &services,
        &switching_home(&services.dependencies.data_folder),
    )
    .into_iter()
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
    let services = per_home_services(CodexHomeKind::Account(test_provider_account_id()));
    let startup_timeout = services.dependencies.startup_timeout;
    let registry = this_daemon(&services);
    let account_home = services.home.codex_home.clone();
    sign_in(&services.dependencies, &account_home);

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
    registry
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;

    assert!(account_started.is_ok(), "{account_started:?}");
    assert!(switching_started.is_ok(), "{switching_started:?}");
    assert_ne!(account_process, switching_process);
    let account_process = account_process.expect("the account's service runs a process");
    assert_eq!(
        joined,
        Some(account_home.join(format!("real-{account_process}.sock")))
    );
}
