use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::{
    ProviderAccountHealthState, ProviderAuthMode,
};
use sidekicks_contracts::provider::account::sign_in::{
    ProviderSignInArm, ProviderSignInCancelStatus,
};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::writer::test_file::TestDatabase;

use crate::account::credential_home::CredentialHome;
use crate::account::registry::open_test_registry;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, bind_test_listener, next_socket_request, send_on_socket,
    start_scripted_codex_service,
};
use crate::driver::codex::session::side_questions::test_copies::{CopySocket, accept_copy};
use crate::driver::contract::account::{ProviderSignInEnd, ProviderSignInLegs};
use crate::driver::contract::error::DriverError;
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::NothingServed;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The device-code login the stand-in starts.
const DEVICE_LOGIN: &str = "login-device";

/// What Codex answers a device-code start on a server that has not turned it on.
const DEVICE_CODE_OFF: &str = "device code login is not enabled for this Codex server. Use the \
                               browser login or verify the server URL.";

/// Why Codex ended a login unsuccessfully.
const FAILURE_REASON: &str = "device auth failed with status 500";

/// How long a test waits on the daemon.
const WAIT: Duration = Duration::from_secs(10);

// The legs over the scripted service, which serves the account's home, so every act runs on it,
// with the registry's database and folder they keep.
async fn legs_holding(
    scripted: &ScriptedCodexService,
) -> (Arc<CodexAccountLegs>, (TestDatabase, tempfile::TempDir)) {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let database = TestDatabase::new(schema_parts());
    let (registry, _writer) = open_test_registry(&database, folder.path()).await;
    let accounts = Arc::new(PortRegistration::new("provider account registry"));
    assert!(accounts.register(Arc::new(registry)).is_ok());
    let legs = CodexAccountLegs::new(
        CodexServiceRegistry::holding(scripted),
        Arc::clone(&scripted.dependencies),
        CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
        accounts,
        Arc::new(NothingServed),
        Arc::new(PortRegistration::new("account home lock")),
    );
    (legs, (database, folder))
}

fn home(scripted: &ScriptedCodexService) -> CredentialHome {
    CredentialHome::at(scripted.service.home().codex_home.clone())
}

// Answers the login's start with `reply` as Codex does, answering the start's params.
async fn answer_start(socket: &mut CopySocket, reply: Value) -> Value {
    let start = next_socket_request(socket).await;
    assert_eq!(start["method"], "account/login/start");
    send_on_socket(socket, json!({"id": start["id"], "result": reply})).await;
    start["params"].clone()
}

fn device_reply() -> Value {
    json!({"type": "chatgptDeviceCode", "loginId": DEVICE_LOGIN,
        "verificationUrl": "https://auth.openai.com/codex/device", "userCode": "ABCD-1234"})
}

fn completed(login_id: Option<&str>, success: bool) -> Value {
    json!({"jsonrpc": "2.0", "method": "account/login/completed",
        "params": {"loginId": login_id, "success": success, "error": null}})
}

// Killed by the arm read from anything but the argument (Codex is sent `chatgpt`), by a completion
// with no id or another id taken as this login's, and by a device code or bound dropped from the
// handle.
#[tokio::test(flavor = "multi_thread")]
async fn a_device_code_sign_in_runs_the_arm_it_is_given_and_ends_only_on_its_own_completion() {
    let scripted = start_scripted_codex_service();
    let Some(listener) = bind_test_listener(scripted.service.socket_path()) else {
        return;
    };
    let (legs, _registry) = legs_holding(&scripted).await;
    let (release, released) = tokio::sync::oneshot::channel::<()>();
    let served = tokio::spawn(async move {
        let mut socket = accept_copy(&listener).await;
        let params = answer_start(&mut socket, device_reply()).await;
        send_on_socket(&mut socket, completed(None, true)).await;
        send_on_socket(&mut socket, completed(Some("login-other"), true)).await;
        released.await.expect("the test releases the login");
        send_on_socket(&mut socket, completed(Some(DEVICE_LOGIN), true)).await;
        params
    });

    let handle = legs
        .start_sign_in(
            test_provider_account_id(),
            home(&scripted),
            ProviderSignInArm::DeviceCode,
        )
        .await
        .expect("the sign-in starts");
    assert_eq!(
        handle.verification_uri.as_str(),
        "https://auth.openai.com/codex/device"
    );
    assert_eq!(
        handle.user_code.as_ref().map(FreeFormText::as_str),
        Some("ABCD-1234")
    );
    assert!(
        handle.expires_at.is_some(),
        "the device wait bounds the attempt"
    );
    assert!(!handle.is_browser_opened_by_provider);
    let mut completion = handle.completion;
    assert!(
        tokio::time::timeout(Duration::from_millis(300), &mut completion)
            .await
            .is_err(),
        "a completion with no id or another id leaves the attempt pending"
    );
    release.send(()).expect("the stand-in waits");

    let end = tokio::time::timeout(WAIT, completion)
        .await
        .expect("the login ends");
    assert_eq!(end, ProviderSignInEnd::Finished);
    let params = tokio::time::timeout(WAIT, served)
        .await
        .expect("the stand-in served the login")
        .expect("the stand-in ran");
    assert_eq!(params, json!({"type": "chatgptDeviceCode"}));
}

// Killed by Codex's refusal for its held callback port answered as an untyped failure, which the
// person reads as the sign-in breaking rather than another sign-in holding the port.
#[tokio::test(flavor = "multi_thread")]
async fn a_browser_start_meeting_a_held_callback_port_is_refused_as_in_use() {
    let scripted = start_scripted_codex_service();
    let Some(listener) = bind_test_listener(scripted.service.socket_path()) else {
        return;
    };
    let (legs, _registry) = legs_holding(&scripted).await;
    let served = tokio::spawn(async move {
        let mut socket = accept_copy(&listener).await;
        let start = next_socket_request(&mut socket).await;
        send_on_socket(
            &mut socket,
            json!({"id": start["id"], "error": {"code": -32603, "message":
                "failed to start login server: Port 127.0.0.1:1457 is already in use"}}),
        )
        .await;
    });

    let started = legs
        .start_sign_in(
            test_provider_account_id(),
            home(&scripted),
            ProviderSignInArm::Browser,
        )
        .await;

    let Err(DriverError::Refused(refusal)) = started else {
        panic!("a held port is a refusal");
    };
    assert_eq!(refusal.code, RefusalCode::ProviderAccountSignInInFlight);
    tokio::time::timeout(WAIT, served)
        .await
        .expect("the stand-in served the start")
        .expect("the stand-in ran");
}

// A start Codex refuses, as it refuses device code a server has not turned on, answers a refusal
// carrying Codex's own words, which the person reads under `Sign-in did not finish.`. Killed by
// the refusal's words dropped, an internal fault included, which tells the client nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_refused_device_code_start_answers_in_codex_s_own_words() {
    let scripted = start_scripted_codex_service();
    let Some(listener) = bind_test_listener(scripted.service.socket_path()) else {
        return;
    };
    let (legs, _registry) = legs_holding(&scripted).await;
    let served = tokio::spawn(async move {
        let mut socket = accept_copy(&listener).await;
        let start = next_socket_request(&mut socket).await;
        send_on_socket(
            &mut socket,
            json!({"id": start["id"], "error": {"code": -32600, "message": DEVICE_CODE_OFF}}),
        )
        .await;
    });

    let started = legs
        .start_sign_in(
            test_provider_account_id(),
            home(&scripted),
            ProviderSignInArm::DeviceCode,
        )
        .await;

    let Err(DriverError::Refused(refusal)) = started else {
        panic!("a refused start is a refusal");
    };
    assert_eq!(refusal.code, RefusalCode::ProviderUnavailable);
    let detail = refusal.detail.expect("the refusal carries details");
    let words = detail["providerFailureDetail"]
        .as_str()
        .expect("the refusal carries Codex's words");
    assert!(words.contains(DEVICE_CODE_OFF), "{words}");
    tokio::time::timeout(WAIT, served)
        .await
        .expect("the stand-in served the start")
        .expect("the stand-in ran");
}

// A login Codex ends unsuccessfully before its wait runs out fails with Codex's own reason, which
// the person reads under `Sign-in did not finish.`. Killed by the completion's error dropped.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_completion_carries_codex_s_reason() {
    let scripted = start_scripted_codex_service();
    let Some(listener) = bind_test_listener(scripted.service.socket_path()) else {
        return;
    };
    let (legs, _registry) = legs_holding(&scripted).await;
    let served = tokio::spawn(async move {
        let mut socket = accept_copy(&listener).await;
        answer_start(&mut socket, device_reply()).await;
        send_on_socket(
            &mut socket,
            json!({"jsonrpc": "2.0", "method": "account/login/completed", "params":
                {"loginId": DEVICE_LOGIN, "success": false, "error": FAILURE_REASON}}),
        )
        .await;
    });

    let handle = legs
        .start_sign_in(
            test_provider_account_id(),
            home(&scripted),
            ProviderSignInArm::DeviceCode,
        )
        .await
        .expect("the sign-in starts");
    let end = tokio::time::timeout(WAIT, handle.completion)
        .await
        .expect("the login ends");

    assert_eq!(
        end,
        ProviderSignInEnd::Failed {
            reason: Some(FreeFormText::new(FAILURE_REASON.to_owned()).expect("a reason")),
        }
    );
    tokio::time::timeout(WAIT, served)
        .await
        .expect("the stand-in served the login")
        .expect("the stand-in ran");
}

// Killed by Codex declaring no machine slot, which lets two browser sign-ins collide on Codex's one
// callback port, and by one declared for the device-code arm, which refuses a device-code start for
// no reason.
#[tokio::test(flavor = "multi_thread")]
async fn only_a_browser_sign_in_holds_the_machine_s_one_callback_port() {
    let scripted = start_scripted_codex_service();
    let (legs, _registry) = legs_holding(&scripted).await;

    assert!(legs.is_one_per_machine(ProviderSignInArm::Browser));
    assert!(!legs.is_one_per_machine(ProviderSignInArm::DeviceCode));
}

// Killed by a cancel that sends nothing to Codex, which would hold its sign-in until it timed out,
// and by a cancel of a login Codex had already ended read or answered as canceled (its completion
// is the end, and the cancel answers `notFound`).
#[rstest]
#[case::running(
    "canceled",
    ProviderSignInCancelStatus::Canceled,
    ProviderSignInEnd::Canceled
)]
#[case::already_ended(
    "notFound",
    ProviderSignInCancelStatus::NotFound,
    ProviderSignInEnd::Finished
)]
#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_sends_codex_s_own_cancel_for_this_login(
    #[case] status: &'static str,
    #[case] answered: ProviderSignInCancelStatus,
    #[case] expected: ProviderSignInEnd,
) {
    let scripted = start_scripted_codex_service();
    let Some(listener) = bind_test_listener(scripted.service.socket_path()) else {
        return;
    };
    let (legs, _registry) = legs_holding(&scripted).await;
    let served = tokio::spawn(async move {
        let mut socket = accept_copy(&listener).await;
        answer_start(&mut socket, device_reply()).await;
        let cancel = next_socket_request(&mut socket).await;
        send_on_socket(
            &mut socket,
            json!({"id": cancel["id"], "result": {"status": status}}),
        )
        .await;
        if status == "notFound" {
            send_on_socket(&mut socket, completed(Some(DEVICE_LOGIN), true)).await;
        }
        cancel
    });

    let handle = legs
        .start_sign_in(
            test_provider_account_id(),
            home(&scripted),
            ProviderSignInArm::DeviceCode,
        )
        .await
        .expect("the sign-in starts");
    let canceled = handle.input.cancel().await.expect("the cancel is sent");
    let end = tokio::time::timeout(WAIT, handle.completion)
        .await
        .expect("the login ends");

    assert_eq!(canceled, answered);
    assert_eq!(end, expected);
    let cancel = tokio::time::timeout(WAIT, served)
        .await
        .expect("the stand-in served the cancel")
        .expect("the stand-in ran");
    assert_eq!(cancel["method"], "account/login/cancel");
    assert_eq!(cancel["params"], json!({"loginId": DEVICE_LOGIN}));
}

// Killed by an account named with neither its email nor its plan, by a null email not falling back
// to the plan, and by a sign-in kind read as another.
#[rstest]
#[case::chatgpt_with_email(
    json!({"type": "chatgpt", "email": "person@example.test", "planType": "plus"}),
    Some(ProviderAuthMode::OauthSubscription),
    true
)]
#[case::chatgpt_named_by_its_plan(
    json!({"type": "chatgpt", "email": null, "planType": "plus"}),
    Some(ProviderAuthMode::OauthSubscription),
    true
)]
#[case::chatgpt_unnamed(
    json!({"type": "chatgpt", "email": null, "planType": null}),
    Some(ProviderAuthMode::OauthSubscription),
    false
)]
#[case::api_key(json!({"type": "apiKey"}), Some(ProviderAuthMode::ApiKey), false)]
#[case::signed_out(Value::Null, None, false)]
#[tokio::test(flavor = "multi_thread")]
async fn the_status_read_names_the_sign_in_codex_reports(
    #[case] account: Value,
    #[case] mode: Option<ProviderAuthMode>,
    #[case] is_named: bool,
) {
    let mut scripted = start_scripted_codex_service();
    let (legs, _registry) = legs_holding(&scripted).await;
    let home = home(&scripted);

    let answered = async {
        let request = scripted.next_request("account/read").await;
        scripted.script.answer(
            &request,
            &json!({"account": account, "requiresOpenaiAuth": true}),
        );
    };
    let (observed, ()) = tokio::join!(
        legs.observe_sign_in(test_provider_account_id(), home),
        answered
    );
    let observed = observed.expect("the status read answers");

    assert_eq!(
        observed.observed_auth_mode,
        Some(mode.unwrap_or(ProviderAuthMode::None))
    );
    assert_eq!(observed.is_account_named, is_named);
    assert_eq!(
        observed.health.state,
        if mode.is_some() {
            ProviderAccountHealthState::Authenticated
        } else {
            ProviderAccountHealthState::ReauthRequired
        }
    );
}
