//! An account's home and its lasting service: the home's kind as the account signs in, the store
//! its sign-in is kept in, a restart that keeps the service, a restart in the middle of a build
//! move that joins the second service, a record that does not read as one, and an API-key
//! account's key handed at each start.

use std::collections::HashMap;
use std::sync::Arc;

use rstest::rstest;
use secrecy::SecretString;
use serde_json::json;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, short_socket_folder};
use sidekicks_std::port_registration::PortRegistration;

use super::stand_in::{
    account_home, account_stand_in_services, another_daemon, cut_short_planned_restart,
    home_record_file, is_running, last_launch_arguments, per_home_services, recorded_requests,
    services_on, this_daemon, wait_for_end_and_record_removal,
};
use crate::driver::ProviderAccountReader;
use crate::driver::codex::account::{
    CODEX_EPHEMERAL_CREDENTIAL_STORE, CODEX_FILE_CREDENTIAL_STORE,
};
use crate::driver::codex::service::home::{CodexHomeKind, CodexHomes};
use crate::driver::codex::service::registry::CodexHomeResolver;
use crate::driver::codex::service::supervisor::test_service::{
    CONVERSATION_WRITERS_NAME, HANG_UP_GRACE_NAME, RESUMED_TURN_NAME, WRITER_LET_GO_NAME,
};
use crate::driver::codex::service::switching::test_sign_in::AccountHomes;
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::daemon_stop::{DaemonStopIntent, daemon_stop_deadline};
use crate::driver::session_control::DriverResumeResult;
use crate::driver::test_registry::new_session_id;
use crate::runtime_binding::test_store::{
    binding_input, compose_test_resume_params, spawn_config_on, spawned_build,
    test_provider_account_id,
};

/// The conversation of a session the build move had not moved when the daemon restarted.
const UNMOVED_THREAD: &str = "thread-unmoved";

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
    daemon
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;

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
    first
        .shutdown(DaemonStopIntent::Restart, daemon_stop_deadline())
        .await;
    let is_kept_running = is_running(kept_process);

    let next = another_daemon(&services);
    let joined = next
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let rejoined = joined.ensure_started(startup_timeout).await;
    let joined_process = joined.process_id();
    next.shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;
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

// Fails when an account's start after a daemon restarted in the middle of a build move reads only
// the home socket's record: it joins the first service, which the move replaced, and leaves the
// second running unjoined with the conversations moved to it, or launches a third beside both;
// and when the first is left running rather than drained to its end with its record removed.
// The resume of a session not yet moved, its conversation still written by the draining first,
// fails when Codex's refusal is answered at once, with no let-go there and no second try, and
// when it waits on the first's drain: a first that lets the conversation go has it resumed on the
// second while it still runs, once the first's unload came, and one that keeps writing it has the
// resume failed naming it, the first still running. The first lists the conversation loaded and
// unloads it a delay after the let-go, so a retry that does not wait for its `thread/closed` is
// refused again.
#[rstest]
#[case::the_first_lets_the_conversation_go(true)]
#[case::the_first_keeps_writing_it(false)]
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_during_a_build_move_joins_the_second_account_service_and_drains_the_first(
    #[case] is_writer_let_go: bool,
) {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let home = account_home(
        folder.path(),
        CodexHomeKind::Account(test_provider_account_id()),
    );
    let writers = folder.path().join("writers");
    let mut program_environment = vec![
        // The drained first answers on a while, as one finishing its replies does.
        (HANG_UP_GRACE_NAME.to_owned(), "2000".to_owned()),
        (
            CONVERSATION_WRITERS_NAME.to_owned(),
            writers.display().to_string(),
        ),
        (
            RESUMED_TURN_NAME.to_owned(),
            json!({"id": "turn-0", "items": [], "status": "completed"}).to_string(),
        ),
    ];
    if is_writer_let_go {
        program_environment.push((WRITER_LET_GO_NAME.to_owned(), "1".to_owned()));
    }
    let services = services_on(home, folder, |mut program| {
        program.environment.extend(program_environment);
        Arc::new(program)
    });
    let startup_timeout = services.dependencies.startup_timeout;
    let session = TestCodexSession::start().await;
    let mut unmoved = binding_input(
        spawn_config_on(test_provider_account_id()),
        spawned_build("0.130.0", "/opt/codex/bin"),
    );
    unmoved.resume_handle = Some(UNMOVED_THREAD.to_owned());
    let unmoved = session
        .bindings
        .create(unmoved)
        .await
        .expect("the binding is recorded");
    let (first_process, second_process, _first_socket) = cut_short_planned_restart(&services).await;
    // The unmoved session's conversation is still loaded on the first.
    std::fs::create_dir_all(&writers).expect("the writers' folder is made");
    std::fs::write(writers.join(UNMOVED_THREAD), first_process.to_string())
        .expect("the writer is recorded");

    let daemon = Arc::new(this_daemon(&services));
    let joined = daemon
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = joined.ensure_started(startup_timeout).await;
    let is_first_writing = is_running(first_process);
    let work = tempfile::tempdir().expect("a scratch folder is made");
    let resumed = session
        .establishment_on(work.path(), Arc::clone(&daemon))
        .resume_by_handle(&compose_test_resume_params(
            new_session_id(),
            &unmoved,
            Vec::new(),
        ))
        .await;
    let is_first_running_at_resume = is_running(first_process);
    let writer = std::fs::read_to_string(writers.join(UNMOVED_THREAD));
    let joined_process = joined.process_id();
    let launches = services.launch_count();
    let is_first_drained =
        wait_for_end_and_record_removal(first_process, &services, startup_timeout).await;
    let is_second_running = is_running(second_process);
    daemon
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;

    assert!(started.is_ok(), "{started:?}");
    assert_eq!(joined_process, Some(second_process));
    assert_eq!(launches, 2, "the start launched a third service");
    assert!(
        is_first_drained,
        "the replaced service did not end by itself"
    );
    assert!(is_second_running);
    assert!(is_first_writing, "the first ended before the resume");
    assert!(
        is_first_running_at_resume,
        "the resume waited on the first's drain"
    );
    if is_writer_let_go {
        assert!(
            matches!(resumed.result, DriverResumeResult::Resumed { .. }),
            "{:?}",
            resumed.result
        );
        assert_eq!(
            writer.ok(),
            Some(second_process.to_string()),
            "the second did not resume the conversation, the retry not waiting for the unload"
        );
    } else {
        let DriverResumeResult::Failed {
            provider_failure_detail,
            ..
        } = &resumed.result
        else {
            panic!(
                "the resume went through while the first wrote: {:?}",
                resumed.result
            );
        };
        assert!(
            provider_failure_detail
                .as_str()
                .contains(&first_process.to_string()),
            "the failure does not name the first: {provider_failure_detail:?}"
        );
        assert_eq!(writer.ok(), Some(first_process.to_string()));
    }
}

// Fails when a record in the home that does not read as one, such as a shape the daemon no longer
// writes, stops the home's start, or is left for every later start to meet.
#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_record_in_the_home_is_removed_and_the_service_launched_afresh() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = account_stand_in_services();
    let record_file = home_record_file(&services);
    // The lock makes the records' folder.
    drop(record_file.lock().expect("the records lock"));
    std::fs::write(record_file.path(), br#"{"process":"#).expect("the record is written");

    let daemon = this_daemon(&services);
    let service = daemon
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = service
        .ensure_started(services.dependencies.startup_timeout)
        .await;
    let launched = service.process_id();
    let kept = record_file
        .lock()
        .and_then(|locked| locked.read())
        .expect("the home's record reads")
        .map(|record| record.process.id());
    let launches = services.launch_count();
    daemon
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;

    assert!(started.is_ok(), "{started:?}");
    assert_eq!(launches, 1);
    assert_eq!(kept, launched, "the home keeps no record of the launch");
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
    first
        .shutdown(DaemonStopIntent::Restart, daemon_stop_deadline())
        .await;

    let next = another_daemon(&services);
    let joined = next
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    seal_key(&joined.dependencies().provider_accounts);
    let rejoined = joined.ensure_started(startup_timeout).await;
    // Read as the start answered: anything sent after, a resume among it, comes later.
    let sent = recorded_requests(&services, &codex_home);
    next.shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;

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
