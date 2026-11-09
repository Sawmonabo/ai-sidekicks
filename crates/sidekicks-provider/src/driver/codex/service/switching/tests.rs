use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use secrecy::SecretString;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tempfile::TempDir;
use tokio::sync::oneshot;

use crate::driver::codex::account::login::CODEX_LOGIN_START_METHOD;
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
use crate::driver::codex::run::start::record::CodexTurnRequest;
use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::driver::codex::server_requests::CodexTokenRefresher as _;
use crate::driver::codex::service::home::CodexServiceKind;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, script_codex_service, start_scripted_switching_service,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::service::switching::test_moves::{
    RecordedMoves, SessionQueue, switching_person,
};
use crate::driver::codex::service::switching::test_sign_in::{
    AccountHomes, answer_through_login, compose_access_token, write_sign_in,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::state::CodexTurnMessage;
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, TestCodexTask, turn_completed, turn_reply, turn_started,
};
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::runtime_binding::test_store::test_provider_account_id;

/// The key sealed for the account that signs in with one.
const TEST_KEY: &str = "sk-the-key-the-switching-service-is-handed";

/// The key the person pastes again for the key account.
const NEW_KEY: &str = "sk-the-key-pasted-again-for-the-key-account";

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
        .register_on(&scripted.dependencies.provider_accounts);
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

    // The start's hand with nothing carried and the key account current. Answers the requests'
    // methods in order and the login.
    async fn hand_the_key_at_start(&mut self) -> (Vec<String>, Value) {
        let service = Arc::clone(&self.scripted.service);
        let connection = service.connection().expect("the service is up");
        let switching = Arc::clone(&self.scripted.dependencies.switching);
        let (handed, answered) = tokio::join!(
            switching.hand_at_start(&service, &connection),
            answer_through_login(&mut self.scripted, false)
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
        switching.hand_switch(
            &service,
            to.clone(),
            Vec::new(),
            switching_person(),
            oneshot::channel().0
        ),
        answer_through_login(&mut fixture.scripted, false)
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
    let (switched, answered) = tokio::join!(
        switching.hand_switch(
            &service,
            fixture.key_account.clone(),
            Vec::new(),
            switching_person(),
            oneshot::channel().0
        ),
        answer_through_login(&mut fixture.scripted, true)
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
// key account met before its key was handed, by a key login sent with no sign-out over a service
// carrying none (it may hold tokens Codex refuses a key over), and by an account read under the
// hand (a token Codex refuses asks for a refresh that waits on the hand).
#[tokio::test]
async fn a_start_with_an_api_key_current_account_hands_the_key() {
    let mut fixture = Fixture::new(true);

    let (methods, login) = fixture.hand_the_key_at_start().await;

    assert_eq!(methods, ["account/logout", CODEX_LOGIN_START_METHOD]);
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
    fixture.hand_the_key_at_start().await;
    let service = Arc::clone(&fixture.scripted.service);
    let switching = Arc::clone(&fixture.scripted.dependencies.switching);

    let (switched, answered) = tokio::join!(
        switching.hand_switch(
            &service,
            fixture.key_account.clone(),
            Vec::new(),
            switching_person(),
            oneshot::channel().0
        ),
        answer_through_login(&mut fixture.scripted, false)
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
    fixture.hand_the_key_at_start().await;
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

// Killed by the carried check removed (the service carrying the account left on its tokens is
// signed out and sent the key, which no one answers), and by a sign-out sent before the login over
// the key carried.
#[tokio::test]
async fn a_resupplied_key_reaches_the_switching_service_only_while_it_carries_the_account() {
    let mut on_the_key = Fixture::new(true);
    on_the_key.hand_the_key_at_start().await;
    let switching = Arc::clone(&on_the_key.scripted.dependencies.switching);
    let service = Arc::clone(&on_the_key.scripted.service);
    let key_account = on_the_key.key_account.clone();

    let (handed, answered) = tokio::join!(
        switching.hand_resupplied_key(&service, &key_account, SecretString::from(NEW_KEY)),
        answer_through_login(&mut on_the_key.scripted, false)
    );

    handed.expect("the new key's login is answered");
    assert_eq!(answered.methods, [CODEX_LOGIN_START_METHOD]);
    assert_eq!(
        answered.login["params"],
        json!({"type": "apiKey", "apiKey": NEW_KEY})
    );
    assert_eq!(
        switching.carried_account(),
        Some(on_the_key.key_account.clone())
    );
    assert_eq!(on_the_key.unread_requests(), Vec::<Value>::new());

    let mut on_another = Fixture::new(false);
    on_another.carry_the_account_left().await;
    let switching = Arc::clone(&on_another.scripted.dependencies.switching);

    tokio::time::timeout(
        Duration::from_secs(5),
        switching.hand_resupplied_key(
            &on_another.scripted.service,
            &on_another.key_account,
            SecretString::from(NEW_KEY),
        ),
    )
    .await
    .expect("nothing is sent that waits on an answer")
    .expect("a service carrying another account is handed nothing");

    assert_eq!(switching.carried_account(), Some(on_another.left.clone()));
    assert_eq!(on_another.unread_requests(), Vec::<Value>::new());
}

// A key re-supplied while a turn runs on the service waits for that turn to end before its login,
// which would cut the turn's requests. Killed by the re-supplied key's login sent mid-turn.
#[tokio::test]
async fn a_resupplied_key_during_a_turn_waits_for_its_end() {
    let mut fixture = Fixture::new(true);
    fixture.hand_the_key_at_start().await;
    let service = Arc::clone(&fixture.scripted.service);
    let switching = Arc::clone(&fixture.scripted.dependencies.switching);
    fixture.scripted.script.send(&turn_started("turn-1"));
    wait_until_a_turn_runs(&service).await;

    let key_account = fixture.key_account.clone();
    let scripted = &mut fixture.scripted;
    let (handed, (sent_mid_turn, answered)) =
        tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(
                switching.hand_resupplied_key(&service, &key_account, SecretString::from(NEW_KEY)),
                async {
                    let sent_mid_turn = scripted.script.next_sent_within(NOTHING_SENT_WAIT).await;
                    scripted
                        .script
                        .send(&turn_completed(TEST_THREAD, "turn-1", "completed"));
                    (
                        sent_mid_turn,
                        answer_through_login(&mut *scripted, false).await,
                    )
                }
            )
        })
        .await
        .expect("the key's login goes once the turn ended");

    assert_eq!(
        sent_mid_turn, None,
        "the key's login went while the turn ran"
    );
    handed.expect("the new key's login is answered");
    assert_eq!(
        answered.login["params"],
        json!({"type": "apiKey", "apiKey": NEW_KEY})
    );
}

/// The `ChatGPT` workspaces of the two accounts the turn tests switch to, in order.
const WORKSPACES_TO: [&str; 2] = ["workspace-of-the-first-account", "workspace-of-the-second"];

/// How long a turn test waits to see that nothing is sent.
const NOTHING_SENT_WAIT: Duration = Duration::from_millis(300);

/// A session on the switching service, which carries the account left, and two more accounts
/// signed in each in a home of its own, the ones the session is switched to.
struct TurnFixture {
    session: TestCodexSession,
    to: [ProviderAccountId; 2],
    _folder: TempDir,
}

impl TurnFixture {
    async fn new() -> Self {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let left = test_provider_account_id();
        let to = ["account-2", "account-3"]
            .map(|id| ProviderAccountId::new(id.to_owned()).expect("a valid id"));
        let mut homes = HashMap::new();
        for (account, workspace) in [
            (&left, WORKSPACE_LEFT),
            (&to[0], WORKSPACES_TO[0]),
            (&to[1], WORKSPACES_TO[1]),
        ] {
            let home = folder.path().join(workspace);
            write_sign_in(&home, workspace, &compose_access_token(workspace));
            homes.insert(account.clone(), home);
        }
        let mut scripted = start_scripted_switching_service();
        AccountHomes {
            homes,
            current: left,
            api_keys: HashMap::new(),
        }
        .register_on(&scripted.dependencies.provider_accounts);
        let service = Arc::clone(&scripted.service);
        let connection = service.connection().expect("the service is up");
        let switching = Arc::clone(&scripted.dependencies.switching);
        let (handed, ()) = tokio::join!(switching.hand_at_start(&service, &connection), async {
            let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
            scripted
                .script
                .answer(&login, &json!({"type": "chatgptAuthTokens"}));
        });
        handed.expect("the start's login is answered");
        Self {
            session: TestCodexSession::start_on(scripted).await,
            to,
            _folder: folder,
        }
    }

    // A start of a run's turn on the session, on a binding of its own, which goes once the
    // session's task takes it.
    async fn start_a_turn(&self) -> BoxFuture<'static, Result<(), CodexError>> {
        let binding_id = self.session.record_binding().await;
        let run_id = new_run_id();
        self.session.task.run_routes.bind_run_delivery(
            run_id,
            CodexRunBinding {
                session_id: self.session.task.record.session_id,
                binding_id: binding_id.clone(),
                agent_id: self.session.daemon_turn_bindings.agent_id,
                step_bound: None,
            },
        );
        let run_start = Arc::clone(&self.session.run_start);
        let inbound = self.session.task.record.inbound.clone();
        let turn = CodexTurnRequest {
            messages: vec![CodexTurnMessage {
                text: "Go on.".to_owned(),
                skills: Vec::new(),
                attachments: Vec::new(),
            }],
            client_message_ids: vec!["message-1".to_owned()],
            model: None,
            output_speed: None,
            output_speed_for_turn: None,
            output_schema: None,
            level: None,
        };
        async move {
            let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
            run_start
                .start_turn(&inbound, run_id, binding_id, turn, None, &deadline)
                .await
        }
        .boxed()
    }

    // Runs a turn `turn_id` that Codex accepts and starts, until the session holds it running.
    async fn run_a_turn(&mut self, turn_id: &str) {
        let start = self.start_a_turn().await;
        let script = &mut self.session.scripted.script;
        let flow = async {
            tokio::join!(start, async {
                let sent = script.next_sent().await;
                assert_eq!(sent["method"], "turn/start", "{sent}");
                script.answer(&sent, &turn_reply(turn_id));
                script.send(&turn_started(turn_id));
            })
        };
        let (started, ()) = drive(&mut self.session.task, flow).await;
        started.expect("the turn starts");
        while self.session.task.record.active_turn_run(turn_id).is_none() {
            self.session.task.handle_next().await;
        }
    }
}

// Runs `flow` while the session's task takes each item of its queue, within a bound past which
// a hold counts as a deadlock.
async fn drive<Output>(task: &mut TestCodexTask, flow: impl Future<Output = Output>) -> Output {
    tokio::time::timeout(Duration::from_secs(10), task.drive(flow))
        .await
        .expect("the switch and the session's turns settle")
}

// Reads what the service is sent until it has seen a request of each of `methods`, answering
// each as it comes: a login as handed, an account read as signed in, a turn start as accepted.
async fn answer_until(script: &mut ScriptedService, methods: &[&str]) -> Vec<Value> {
    let mut sent: Vec<Value> = Vec::new();
    while !methods
        .iter()
        .all(|method| sent.iter().any(|request| request["method"] == *method))
    {
        let request = script.next_sent().await;
        let answer = match request["method"].as_str() {
            Some(CODEX_LOGIN_START_METHOD) => json!({"type": "chatgptAuthTokens"}),
            Some("account/read") => {
                json!({"account": {"type": "chatgpt"}, "requiresOpenaiAuth": true})
            }
            Some("turn/start") => turn_reply("turn-2"),
            Some(_) | None => panic!("the service is sent no such request: {request}"),
        };
        script.answer(&request, &answer);
        sent.push(request);
    }
    sent
}

// Waits until a turn runs on `service`, within a bound past which the turn never started.
async fn wait_until_a_turn_runs(service: &CodexService) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !service.is_turn_running() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the turn runs on the service");
}

// Where `method`'s request is among `sent`.
fn position_of(sent: &[Value], method: &str) -> Option<usize> {
    sent.iter().position(|request| request["method"] == method)
}

// Killed by the switch's login sent while the turn runs (its wait for the session's turns
// removed), which revokes that turn's requests, by a turn start let through while the switch is
// held (the turn-start gate removed), which the login would cut or run on the account left, and
// by the turn starts let go before the login is answered.
#[tokio::test]
async fn a_switch_asked_mid_turn_lands_at_the_turns_end_before_the_next_turn() {
    let mut fixture = TurnFixture::new().await;
    fixture.run_a_turn("turn-1").await;
    let next_turn = fixture.start_a_turn().await;
    let switching = Arc::clone(&fixture.session.scripted.dependencies.switching);
    let service = Arc::clone(&fixture.session.scripted.service);
    let to = fixture.to[0].clone();
    let switch = switching.hand_switch(
        &service,
        to.clone(),
        Vec::new(),
        switching_person(),
        oneshot::channel().0,
    );
    let mut switch = std::pin::pin!(switch);
    assert!(futures::poll!(switch.as_mut()).is_pending());

    let script = &mut fixture.session.scripted.script;
    let flow = async {
        tokio::join!(switch, next_turn, async {
            let sent_mid_turn = script.next_sent_within(NOTHING_SENT_WAIT).await;
            script.send(&turn_completed(TEST_THREAD, "turn-1", "completed"));
            let sent = answer_until(
                script,
                &[CODEX_LOGIN_START_METHOD, "account/read", "turn/start"],
            )
            .await;
            (sent_mid_turn, sent)
        })
    };
    let (switched, next_started, (sent_mid_turn, sent)) =
        drive(&mut fixture.session.task, flow).await;

    assert_eq!(sent_mid_turn, None, "a request went while the turn ran");
    switched.expect("the switch lands");
    next_started.expect("the next turn starts");
    let login_at = position_of(&sent, CODEX_LOGIN_START_METHOD).expect("a login was sent");
    assert!(
        Some(login_at) < position_of(&sent, "turn/start"),
        "the next turn started before the switch's login was answered: {sent:?}"
    );
    assert_eq!(
        sent[login_at]["params"]["accessToken"],
        compose_access_token(WORKSPACES_TO[0])
    );
    assert_eq!(service.provider_account_id(), Some(to.clone()));
    assert_eq!(fixture.session.task.record.provider_account_id, to);
}

// Killed by a second switch held beside the first rather than in its place (two logins, the
// first onto the account the person moved off again), and by the held switch keeping the first
// account asked.
#[tokio::test]
async fn two_switches_asked_mid_turn_land_as_one_login_onto_the_newest() {
    let mut fixture = TurnFixture::new().await;
    fixture.run_a_turn("turn-1").await;
    let switching = Arc::clone(&fixture.session.scripted.dependencies.switching);
    let service = Arc::clone(&fixture.session.scripted.service);
    let [first, second] = fixture.to.clone();
    let first_switch = switching.hand_switch(
        &service,
        first,
        Vec::new(),
        switching_person(),
        oneshot::channel().0,
    );
    let mut first_switch = std::pin::pin!(first_switch);
    assert!(futures::poll!(first_switch.as_mut()).is_pending());
    let second_switch = switching.hand_switch(
        &service,
        second.clone(),
        Vec::new(),
        switching_person(),
        oneshot::channel().0,
    );
    let mut second_switch = std::pin::pin!(second_switch);
    assert!(futures::poll!(second_switch.as_mut()).is_pending());

    let script = &mut fixture.session.scripted.script;
    let flow = async {
        tokio::join!(first_switch, second_switch, async {
            script.send(&turn_completed(TEST_THREAD, "turn-1", "completed"));
            let sent = answer_until(script, &[CODEX_LOGIN_START_METHOD, "account/read"]).await;
            (sent, script.next_sent_within(NOTHING_SENT_WAIT).await)
        })
    };
    let (switched_first, switched_second, (sent, sent_after)) =
        drive(&mut fixture.session.task, flow).await;

    switched_first.expect("the first switch lands with the one that took its place");
    switched_second.expect("the newest switch lands");
    let login_at = position_of(&sent, CODEX_LOGIN_START_METHOD).expect("a login was sent");
    assert_eq!(
        sent[login_at]["params"]["accessToken"],
        compose_access_token(WORKSPACES_TO[1])
    );
    assert_eq!(sent_after, None, "a second login followed");
    assert_eq!(service.provider_account_id(), Some(second));
}

// Killed by a switch on an idle session waiting for a turn to end anyway, which holds the person's
// switch until the session's next turn.
#[tokio::test]
async fn a_switch_on_an_idle_session_lands_at_once() {
    let mut fixture = TurnFixture::new().await;
    let switching = Arc::clone(&fixture.session.scripted.dependencies.switching);
    let service = Arc::clone(&fixture.session.scripted.service);
    let to = fixture.to[0].clone();
    let switch = switching.hand_switch(
        &service,
        to.clone(),
        Vec::new(),
        switching_person(),
        oneshot::channel().0,
    );

    let script = &mut fixture.session.scripted.script;
    let flow = async {
        tokio::join!(
            switch,
            answer_until(script, &[CODEX_LOGIN_START_METHOD, "account/read"])
        )
    };
    let (switched, sent) = drive(&mut fixture.session.task, flow).await;

    switched.expect("the switch lands");
    let login_at = position_of(&sent, CODEX_LOGIN_START_METHOD).expect("a login was sent");
    assert_eq!(
        sent[login_at]["params"]["accessToken"],
        compose_access_token(WORKSPACES_TO[0])
    );
    assert_eq!(service.provider_account_id(), Some(to));
}

// A turn running on the service that no session's record holds, as a side question's copy runs
// one, holds a switch's login until it ends, since the login cuts its requests too. Killed by the
// hold waiting only for the sessions' own turns, which lets the login go while the copy runs.
#[tokio::test]
async fn a_copy_turn_running_alone_holds_the_switch_until_it_ends() {
    let mut fixture = TurnFixture::new().await;
    let switching = Arc::clone(&fixture.session.scripted.dependencies.switching);
    let service = Arc::clone(&fixture.session.scripted.service);
    fixture
        .session
        .scripted
        .script
        .send(&copy_turn_frame("turn/started"));
    wait_until_a_turn_runs(&service).await;
    let to = fixture.to[0].clone();
    let switch = switching.hand_switch(
        &service,
        to.clone(),
        Vec::new(),
        switching_person(),
        oneshot::channel().0,
    );

    let script = &mut fixture.session.scripted.script;
    let flow = async {
        tokio::join!(switch, async {
            let sent_mid_turn = script.next_sent_within(NOTHING_SENT_WAIT).await;
            script.send(&copy_turn_frame("turn/completed"));
            let sent = answer_until(script, &[CODEX_LOGIN_START_METHOD, "account/read"]).await;
            (sent_mid_turn, sent)
        })
    };
    let (switched, (sent_mid_turn, sent)) = drive(&mut fixture.session.task, flow).await;

    assert_eq!(
        sent_mid_turn, None,
        "the login went while the copy's turn ran"
    );
    switched.expect("the switch lands");
    let login_at = position_of(&sent, CODEX_LOGIN_START_METHOD).expect("a login was sent");
    assert_eq!(
        sent[login_at]["params"]["accessToken"],
        compose_access_token(WORKSPACES_TO[0])
    );
    assert_eq!(service.provider_account_id(), Some(to));
}

// A copy's turn leased before its start is sent holds a switch's login until the lease goes, with
// no frame of the copy's on the connection yet. Killed by the lease counting nothing, which lets
// the login go before the copy's turn starts.
#[tokio::test]
async fn a_copy_turn_leased_holds_the_switch_until_the_lease_goes() {
    let mut fixture = TurnFixture::new().await;
    let switching = Arc::clone(&fixture.session.scripted.dependencies.switching);
    let service = Arc::clone(&fixture.session.scripted.service);
    let lease = switching.lease_copy_turn(&service).await;
    let to = fixture.to[0].clone();
    let switch = switching.hand_switch(
        &service,
        to.clone(),
        Vec::new(),
        switching_person(),
        oneshot::channel().0,
    );

    let script = &mut fixture.session.scripted.script;
    let flow = async {
        tokio::join!(switch, async {
            let sent_while_leased = script.next_sent_within(NOTHING_SENT_WAIT).await;
            drop(lease);
            let sent = answer_until(script, &[CODEX_LOGIN_START_METHOD, "account/read"]).await;
            (sent_while_leased, sent)
        })
    };
    let (switched, (sent_while_leased, sent)) = drive(&mut fixture.session.task, flow).await;

    assert_eq!(
        sent_while_leased, None,
        "the login went while the copy's lease stood"
    );
    switched.expect("the switch lands");
    assert!(
        position_of(&sent, CODEX_LOGIN_START_METHOD).is_some(),
        "{sent:?}"
    );
    assert_eq!(service.provider_account_id(), Some(to));
}

// A switching service signed in beside the one a switch is held on, as a planned restart starts
// one, takes the held switch's login, so it never runs on the account the switch left. Killed by
// the landing kept on the service the switch was held on.
#[tokio::test]
async fn a_held_switch_lands_on_the_service_signed_in_beside_since() {
    let mut fixture = TurnFixture::new().await;
    fixture.run_a_turn("turn-1").await;
    let switching = Arc::clone(&fixture.session.scripted.dependencies.switching);
    let service = Arc::clone(&fixture.session.scripted.service);
    let to = fixture.to[0].clone();
    let switch = switching.hand_switch(
        &service,
        to,
        Vec::new(),
        switching_person(),
        oneshot::channel().0,
    );
    let mut switch = std::pin::pin!(switch);
    assert!(futures::poll!(switch.as_mut()).is_pending());
    let beside_socket = service.socket_path().with_file_name("beside.sock");
    let (beside, mut beside_script) = script_codex_service(
        service.home().clone(),
        CodexServiceSocket {
            path: beside_socket.clone(),
            home_socket: beside_socket,
        },
        CodexServiceKind::Account,
        Arc::clone(&fixture.session.scripted.dependencies),
    );
    let beside_connection = beside.connection().expect("the service beside is up");
    let (signed_in, _) = tokio::join!(
        switching.hand_at_start(&beside, &beside_connection),
        answer_until(&mut beside_script, &[CODEX_LOGIN_START_METHOD])
    );
    signed_in.expect("the service beside signs in");

    let script = &mut fixture.session.scripted.script;
    let flow = async {
        tokio::join!(switch, async {
            script.send(&turn_completed(TEST_THREAD, "turn-1", "completed"));
            let sent_beside = answer_until(
                &mut beside_script,
                &[CODEX_LOGIN_START_METHOD, "account/read"],
            )
            .await;
            (
                sent_beside,
                script.next_sent_within(NOTHING_SENT_WAIT).await,
            )
        })
    };
    let (switched, (sent_beside, sent_held_on)) = drive(&mut fixture.session.task, flow).await;

    switched.expect("the switch lands");
    let login_at =
        position_of(&sent_beside, CODEX_LOGIN_START_METHOD).expect("a login went beside");
    assert_eq!(
        sent_beside[login_at]["params"]["accessToken"],
        compose_access_token(WORKSPACES_TO[0])
    );
    assert_eq!(
        sent_held_on, None,
        "the login went to the service being left"
    );
}

// A copy's turn frame of `method`, on a thread no session holds.
fn copy_turn_frame(method: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": {
            "threadId": "copy-of-the-session",
            "turn": {"id": "copy-turn", "items": [], "status": "inProgress"},
        },
    })
}
