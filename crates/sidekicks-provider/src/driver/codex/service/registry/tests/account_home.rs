//! An account's home and its lasting service: the home's kind as the account signs in, the store
//! its sign-in is kept in, a restart that keeps the service, and an API-key account's key handed
//! at each start.

use std::collections::HashMap;
use std::sync::Arc;

use rstest::rstest;
use secrecy::SecretString;
use serde_json::json;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, short_socket_folder};
use sidekicks_std::port_registration::PortRegistration;

use super::stand_in::{
    account_home, account_stand_in_services, another_daemon, is_running, last_launch_arguments,
    per_home_services, recorded_requests, services_on, this_daemon,
    wait_for_end_and_record_removal,
};
use crate::driver::ProviderAccountReader;
use crate::driver::codex::account::{
    CODEX_EPHEMERAL_CREDENTIAL_STORE, CODEX_FILE_CREDENTIAL_STORE,
};
use crate::driver::codex::service::home::{CodexHomeKind, CodexHomes};
use crate::driver::codex::service::registry::CodexHomeResolver;
use crate::driver::codex::service::switching::test_sign_in::AccountHomes;
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The account the test signs in with a pasted API key.
const KEY_ACCOUNT: &str = "account-with-a-key";

/// The account the test signs in through `ChatGPT`.
const CHATGPT_ACCOUNT: &str = "account-with-chatgpt";

/// The API key sealed for the test's account, which its service is handed at each start.
const TEST_KEY: &str = "sk-the-key-each-start-hands-the-service";

// The account named `name`.
fn account(name: &str) -> ProviderAccountId {
    ProviderAccountId::new(name.to_owned()).expect("the test's account id is valid")
}

// Fails when an account's home kind is chosen without how the account signs in, which starts a
// pasted key's service on the file store, writing the key into the home, or a `ChatGPT` account's
// on a store that keeps no sign-in.
#[rstest]
#[case::a_pasted_key(KEY_ACCOUNT, CodexHomeKind::ApiKeyAccount)]
#[case::a_chatgpt_sign_in(CHATGPT_ACCOUNT, CodexHomeKind::Account)]
#[tokio::test]
async fn an_account_home_s_kind_follows_how_the_account_signs_in(
    #[case] name: &str,
    #[case] kind_of: fn(ProviderAccountId) -> CodexHomeKind,
) {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let provider_accounts: PortRegistration<Arc<dyn ProviderAccountReader>> =
        PortRegistration::new("provider accounts");
    AccountHomes {
        homes: HashMap::from([
            (account(KEY_ACCOUNT), folder.path().join("key")),
            (account(CHATGPT_ACCOUNT), folder.path().join("chatgpt")),
        ]),
        current: account(CHATGPT_ACCOUNT),
        api_keys: HashMap::from([(
            account(KEY_ACCOUNT),
            SecretString::from("a-key-the-test-pastes"),
        )]),
    }
    .register_on(&provider_accounts);
    let homes = CodexHomes::new(Arc::new(provider_accounts), &[], folder.path());

    let home = homes
        .codex_home_for(&account(name))
        .await
        .expect("the home resolves");

    assert_eq!(home.kind, kind_of(account(name)));
}

// Fails when an account home's lasting service starts with no store switch, where Codex may keep
// the sign-in outside the home, or names it twice; or when the pasted key's home starts on the
// file store, which writes the key it is handed into the home's `auth.json`.
#[rstest]
#[case::a_chatgpt_sign_in(
    CodexHomeKind::Account,
    CODEX_FILE_CREDENTIAL_STORE,
    CODEX_EPHEMERAL_CREDENTIAL_STORE
)]
#[case::a_pasted_key(
    CodexHomeKind::ApiKeyAccount,
    CODEX_EPHEMERAL_CREDENTIAL_STORE,
    CODEX_FILE_CREDENTIAL_STORE
)]
#[tokio::test(flavor = "multi_thread")]
async fn a_lasting_service_keeps_its_sign_in_in_the_store_its_home_names(
    #[case] kind_of: fn(ProviderAccountId) -> CodexHomeKind,
    #[case] store: &str,
    #[case] other_store: &str,
) {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let home = account_home(folder.path(), kind_of(test_provider_account_id()));
    let services = services_on(home, folder, |program| Arc::new(program));
    // A pasted key's start hands the service its key; a `ChatGPT` home's start reads none.
    AccountHomes {
        homes: HashMap::from([(test_provider_account_id(), services.home.codex_home.clone())]),
        current: test_provider_account_id(),
        api_keys: HashMap::from([(test_provider_account_id(), SecretString::from(TEST_KEY))]),
    }
    .register_on(&services.dependencies.provider_accounts);
    let daemon = this_daemon(&services);

    let service = daemon
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = service
        .ensure_started(services.dependencies.startup_timeout)
        .await;
    let arguments = last_launch_arguments(&services);
    daemon.shutdown(DaemonStopIntent::Stop).await;

    assert!(started.is_ok(), "{started:?}");
    let count = |switch: &str| {
        arguments
            .iter()
            .filter(|argument| argument.as_str() == switch)
            .count()
    };
    assert_eq!(count(store), 1, "{arguments:?}");
    assert_eq!(count(other_store), 0, "{arguments:?}");
}

// Fails when a restart stops the account home's service, which ends every turn it runs, when the
// next daemon launches another beside it instead of joining it, or when that daemon's stop leaves
// it running or its record kept.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_keeps_an_account_homes_service_and_the_next_stop_ends_it() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = account_stand_in_services();
    let startup_timeout = services.dependencies.startup_timeout;

    let first = this_daemon(&services);
    let kept = first
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = kept.ensure_started(startup_timeout).await;
    let kept_process = kept.process_id().expect("the service runs a process");
    first.shutdown(DaemonStopIntent::Restart).await;
    let is_kept_running = is_running(kept_process);

    let next = another_daemon(&services);
    let joined = next
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let rejoined = joined.ensure_started(startup_timeout).await;
    let joined_process = joined.process_id();
    next.shutdown(DaemonStopIntent::Stop).await;
    let is_stopped =
        wait_for_end_and_record_removal(kept_process, &services, startup_timeout).await;

    assert!(started.is_ok(), "{started:?}");
    assert!(is_kept_running, "the restart stopped the account's service");
    assert!(rejoined.is_ok(), "{rejoined:?}");
    assert_eq!(joined_process, Some(kept_process));
    assert!(
        is_stopped,
        "the stop left the account's service or its record"
    );
}

// Fails when an API-key account's service is never handed its key, so it runs signed out; when
// only its first start hands it, so the next daemon's rejoin runs on whatever the service held; or
// when the key goes before the relay's environment, as no other start's hand does.
#[tokio::test(flavor = "multi_thread")]
async fn an_api_key_accounts_service_is_handed_its_key_at_each_start() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = per_home_services(CodexHomeKind::ApiKeyAccount(test_provider_account_id()));
    let startup_timeout = services.dependencies.startup_timeout;
    let codex_home = services.home.codex_home.clone();
    let seal_key = |provider_accounts: &PortRegistration<Arc<dyn ProviderAccountReader>>| {
        AccountHomes {
            homes: HashMap::from([(test_provider_account_id(), codex_home.clone())]),
            current: test_provider_account_id(),
            api_keys: HashMap::from([(test_provider_account_id(), SecretString::from(TEST_KEY))]),
        }
        .register_on(provider_accounts);
    };
    seal_key(&services.dependencies.provider_accounts);

    let first = this_daemon(&services);
    let kept = first
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = kept.ensure_started(startup_timeout).await;
    first.shutdown(DaemonStopIntent::Restart).await;

    let next = another_daemon(&services);
    let joined = next
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    seal_key(&joined.dependencies().provider_accounts);
    let rejoined = joined.ensure_started(startup_timeout).await;
    // Read as the start answered: anything sent after, a resume among it, comes later.
    let sent = recorded_requests(&services, &codex_home);
    next.shutdown(DaemonStopIntent::Stop).await;

    assert!(started.is_ok(), "{started:?}");
    assert!(rejoined.is_ok(), "{rejoined:?}");
    let handed: Vec<_> = sent
        .iter()
        .filter(|request| request["method"] != "initialize")
        .collect();
    let methods: Vec<&str> = handed
        .iter()
        .map(|request| request["method"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        methods,
        [
            "environment/add",
            "account/login/start",
            "environment/add",
            "account/login/start"
        ],
        "each start hands the key after the relay's environment"
    );
    let login = json!({"type": "apiKey", "apiKey": TEST_KEY});
    assert_eq!(handed[1]["params"], login);
    assert_eq!(handed[3]["params"], login);
    assert!(!codex_home.join("auth.json").exists());
}
