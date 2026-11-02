use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use secrecy::SecretString;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tempfile::TempDir;

use crate::driver::codex::account::login::CODEX_LOGIN_START_METHOD;
use crate::driver::codex::server_requests::CodexTokenRefresher as _;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_switching_service,
};
use crate::driver::codex::service::switching::test_moves::{
    RecordedMoves, SessionQueue, switching_person,
};
use crate::driver::codex::service::switching::test_sign_in::{
    AccountHomes, answer_through_login, compose_access_token, write_sign_in,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::test_registry::new_session_id;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The key sealed for the account that signs in with one.
const TEST_KEY: &str = "sk-the-key-the-switching-service-is-handed";

/// The `ChatGPT` workspace the account left signs in to.
const WORKSPACE_LEFT: &str = "workspace-of-the-account-left";

/// The `ChatGPT` workspace a sign-in left in the key account's home names.
const WORKSPACE_IN_THE_KEY_HOME: &str = "workspace-of-a-sign-in-the-key-home-still-holds";

/// What Codex answers the account read with while the key's login is signed in.
fn signed_in_on_a_key() -> Value {
    json!({"account": {"type": "apiKey"}, "requiresOpenaiAuth": true})
}

/// The switching service, handed nothing yet, over two accounts: the account left, signed in to
/// `ChatGPT` in its home, and the key account, whose key is sealed and whose home holds no sign-in
/// until a test writes one.
struct Fixture {
    scripted: ScriptedCodexService,
    left: ProviderAccountId,
    key_account: ProviderAccountId,
    key_home: PathBuf,
    _folder: TempDir,
}

impl Fixture {
    // The service and its two accounts, the key account the current one where `is_key_current`.
    fn new(is_key_current: bool) -> Self {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let left = test_provider_account_id();
        let key_account = ProviderAccountId::new("account-2".to_owned()).expect("a valid id");
        let left_home = folder.path().join(WORKSPACE_LEFT);
        write_sign_in(
            &left_home,
            WORKSPACE_LEFT,
            &compose_access_token(WORKSPACE_LEFT),
        );
        let key_home = folder.path().join("home-of-the-key-account");
        let scripted = start_scripted_switching_service();
        AccountHomes {
            homes: HashMap::from([
                (left.clone(), left_home),
                (key_account.clone(), key_home.clone()),
            ]),
            current: if is_key_current {
                key_account.clone()
            } else {
                left.clone()
            },
            api_keys: HashMap::from([(key_account.clone(), SecretString::from(TEST_KEY))]),
        }
        .register_on(scripted.dependencies.switching.provider_accounts());
        Self {
            scripted,
            left,
            key_account,
            key_home,
            _folder: folder,
        }
    }

    // Leaves a `ChatGPT` sign-in in the key account's home, as one written there before its key.
    fn sign_in_the_key_home(&self) {
        write_sign_in(
            &self.key_home,
            WORKSPACE_IN_THE_KEY_HOME,
            &compose_access_token(WORKSPACE_IN_THE_KEY_HOME),
        );
    }

    // The start's hand with nothing carried and the account left current: one tokens login.
    async fn carry_the_account_left(&mut self) {
        let service = Arc::clone(&self.scripted.service);
        let connection = service.connection().expect("the service is up");
        let switching = Arc::clone(&self.scripted.dependencies.switching);
        let scripted = &mut self.scripted;
        let (handed, ()) = tokio::join!(switching.hand_at_start(&service, &connection), async {
            let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
            scripted
                .script
                .answer(&login, &json!({"type": "chatgptAuthTokens"}));
        });
        handed.expect("the start's login is answered");
    }

    // The start's hand with nothing carried and the key account current, the read answering
    // `reading`. Answers the requests' methods in order and the login.
    async fn hand_the_key_at_start(&mut self, reading: &Value) -> (Vec<String>, Value) {
        let service = Arc::clone(&self.scripted.service);
        let connection = service.connection().expect("the service is up");
        let switching = Arc::clone(&self.scripted.dependencies.switching);
        let (handed, answered) = tokio::join!(
            switching.hand_at_start(&service, &connection),
            answer_through_login(&mut self.scripted, reading, false)
        );
        handed.expect("the key's login is answered");
        (answered.methods, answered.login)
    }

    // Every request the connection sent that the test has not read.
    fn unread_requests(&mut self) -> Vec<Value> {
        std::iter::from_fn(|| self.scripted.script.sent.try_recv().ok())
            .map(|text| serde_json::from_str(&text).expect("the connection sends JSON"))
            .collect()
    }
}

// Killed by a key login sent with no sign-out over the tokens carried (Codex would refuse it), by
// an account read under the hand (its refused token asks for a refresh that waits on the hand),
// by the switch's hook put on the sign-out (the service would carry the key account before its
// login was sent), and by the key read from the home (a tokens login, or the home's workspace,
// instead of the sealed key).
#[tokio::test]
async fn a_switch_onto_an_api_key_account_hands_the_key() {
    let mut fixture = Fixture::new(false);
    fixture.sign_in_the_key_home();
    fixture.carry_the_account_left().await;
    let moves = Arc::new(RecordedMoves::default());
    let queue = SessionQueue::new(new_session_id(), fixture.left.clone(), &moves);
    // The task ends with the test's runtime.
    let _drained = queue.attach(&fixture.scripted.service);

    let service = Arc::clone(&fixture.scripted.service);
    let switching = Arc::clone(&fixture.scripted.dependencies.switching);
    let to = fixture.key_account.clone();
    let (switched, answered) = tokio::join!(
        switching.hand_switch(&service, to.clone(), Vec::new(), switching_person()),
        answer_through_login(&mut fixture.scripted, &signed_in_on_a_key(), false)
    );
    switched.expect("the key's login is answered");
    // A switch off another account checks the new login once its hand is let go.
    let check = fixture.scripted.next_request("account/read").await;
    fixture
        .scripted
        .script
        .answer(&check, &signed_in_on_a_key());
    queue.wait_until_seen(1).await;

    assert_eq!(
        answered.methods,
        ["account/logout", CODEX_LOGIN_START_METHOD]
    );
    assert_eq!(
        answered.login["params"],
        json!({"type": "apiKey", "apiKey": TEST_KEY})
    );
    assert_eq!(
        answered.carried_at_login,
        Some(fixture.left.clone()),
        "the service moved before the key's login was answered"
    );
    assert_eq!(service.provider_account_id(), Some(to.clone()));
    assert_eq!(queue.seen(), [format!("moved to {}", to.as_str())]);
    assert_eq!(fixture.unread_requests(), Vec::<Value>::new());
}

// Killed by the refusal leaving the previous account carried, which the service, signed out of
// it, no longer holds, and by the refused login moving the session or answering as handed.
#[tokio::test]
async fn a_key_refused_after_the_sign_out_leaves_the_service_carrying_none() {
    let mut fixture = Fixture::new(false);
    fixture.carry_the_account_left().await;
    let moves = Arc::new(RecordedMoves::default());
    let queue = SessionQueue::new(new_session_id(), fixture.left.clone(), &moves);
    // The task ends with the test's runtime.
    let _drained = queue.attach(&fixture.scripted.service);

    let service = Arc::clone(&fixture.scripted.service);
    let switching = Arc::clone(&fixture.scripted.dependencies.switching);
    let on_chatgpt = json!({"account": {"type": "chatgpt"}, "requiresOpenaiAuth": true});
    let (switched, answered) = tokio::join!(
        switching.hand_switch(
            &service,
            fixture.key_account.clone(),
            Vec::new(),
            switching_person()
        ),
        answer_through_login(&mut fixture.scripted, &on_chatgpt, true)
    );

    assert!(
        matches!(switched, Err(CodexError::ProviderRequest { .. })),
        "the key's refusal is not the caller's answer"
    );
    assert_eq!(
        answered.methods,
        ["account/logout", CODEX_LOGIN_START_METHOD]
    );
    assert_eq!(answered.carried_at_login, Some(fixture.left.clone()));
    assert_eq!(switching.carried_account(), None);
    assert_eq!(service.provider_account_id(), None);
    assert_eq!(queue.seen(), Vec::<String>::new());
    assert_eq!(fixture.unread_requests(), Vec::<Value>::new());
}

// Killed by the refusal of an account whose home holds no `ChatGPT` sign-in, which a start on a
// key account met before its key was handed, by a key login sent with no sign-out over a `ChatGPT`
// or unreadable reading (Codex would refuse it), and by a sign-out sent over a key or no sign-in.
#[rstest]
#[case::on_chatgpt(
    json!({"account": {"type": "chatgpt"}, "requiresOpenaiAuth": true}),
    vec!["account/read", "account/logout", CODEX_LOGIN_START_METHOD]
)]
#[case::on_a_key(signed_in_on_a_key(), vec!["account/read", CODEX_LOGIN_START_METHOD])]
#[case::signed_out(
    json!({"account": null, "requiresOpenaiAuth": true}),
    vec!["account/read", CODEX_LOGIN_START_METHOD]
)]
#[case::unreadable(
    json!({}),
    vec!["account/read", "account/logout", CODEX_LOGIN_START_METHOD]
)]
#[tokio::test]
async fn a_start_with_an_api_key_current_account_hands_the_key(
    #[case] reading: Value,
    #[case] expected: Vec<&str>,
) {
    let mut fixture = Fixture::new(true);

    let (methods, login) = fixture.hand_the_key_at_start(&reading).await;

    assert_eq!(methods, expected);
    assert_eq!(
        login["params"],
        json!({"type": "apiKey", "apiKey": TEST_KEY})
    );
    assert_eq!(
        fixture.scripted.dependencies.switching.carried_account(),
        Some(fixture.key_account.clone())
    );
    assert_eq!(fixture.unread_requests(), Vec::<Value>::new());
}

// Killed by a sign-out or an account read sent where the service already carries an account on
// its key: a key login over a key needs neither.
#[tokio::test]
async fn a_key_handed_over_a_key_carried_sends_only_the_login() {
    let mut fixture = Fixture::new(true);
    fixture.hand_the_key_at_start(&signed_in_on_a_key()).await;
    let service = Arc::clone(&fixture.scripted.service);
    let switching = Arc::clone(&fixture.scripted.dependencies.switching);

    let (switched, answered) = tokio::join!(
        switching.hand_switch(
            &service,
            fixture.key_account.clone(),
            Vec::new(),
            switching_person()
        ),
        answer_through_login(&mut fixture.scripted, &signed_in_on_a_key(), false)
    );

    switched.expect("the key's login is answered");
    assert_eq!(answered.methods, [CODEX_LOGIN_START_METHOD]);
    assert_eq!(fixture.unread_requests(), Vec::<Value>::new());
}

// Killed by a refresh answered from the key home's `auth.json` (its tokens, not a refusal), and by
// the home's tokens handed over the key once they read as unlike any token last handed (a login
// sent, or the call answering that it handed them).
#[tokio::test]
async fn a_key_account_carried_never_takes_its_homes_tokens() {
    let mut fixture = Fixture::new(true);
    fixture
        .hand_the_key_at_start(&json!({"account": null, "requiresOpenaiAuth": true}))
        .await;
    fixture.sign_in_the_key_home();
    let switching = Arc::clone(&fixture.scripted.dependencies.switching);
    let connection = fixture
        .scripted
        .service
        .connection()
        .expect("the service is up");

    let refreshed = switching.refresh_tokens().await;
    let handed = tokio::time::timeout(
        Duration::from_secs(5),
        switching.hand_again_if_renewed(&connection, &fixture.key_account, &fixture.key_home),
    )
    .await
    .expect("no login waits on an answer")
    .expect("the hand answers");

    assert!(
        refreshed.is_none(),
        "a refresh was answered with the home's tokens"
    );
    assert!(!handed, "the home's tokens were handed over the key");
    assert_eq!(fixture.unread_requests(), Vec::<Value>::new());
}
