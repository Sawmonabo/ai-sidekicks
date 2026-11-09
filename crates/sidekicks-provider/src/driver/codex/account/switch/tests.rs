use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tempfile::TempDir;
use tokio::sync::oneshot;

use super::{hand_switching_service_again, move_codex_sessions};
use crate::account::registry::{AccountAdmission, HealthObservation, open_test_registry};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::account::login::CODEX_LOGIN_START_METHOD;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_switching_service,
};
use crate::driver::codex::service::switching::test_moves::{
    RecordedMoves, SessionQueue, switching_person,
};
use crate::driver::codex::service::switching::test_sign_in::{
    AccountHomes, TEST_PLAN, compose_access_token, write_sign_in,
};
use crate::driver::codex::usage_limit_signal::{
    CodexRateLimitObservation, observe_codex_rate_limit_read,
};
use crate::driver::contract::account::{FirstRequestAfterMove, SessionAccountMove, SessionToMove};
use crate::driver::contract::error::DriverError;
use crate::driver::diagnostics::RecordedEvents;
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::{NothingServed, new_session_id};
use crate::runtime_binding::test_store::test_provider_account_id;

/// The conversation the moved session runs on the switching service.
const THREAD: &str = "thread-on-the-switching-service";

/// The `ChatGPT` workspace each test account signs in to, by account.
const WORKSPACE_LEFT: &str = "workspace-of-the-account-left";
const WORKSPACE_TO: &str = "workspace-of-the-account-moved-to";

/// The switching service on a scripted connection, the legs over a registry holding it, one
/// session attached to it with its conversation registered, and two accounts signed in each in a
/// home of its own: the one the service carries, and a registered one to move to.
struct Fixture {
    legs: Arc<CodexAccountLegs>,
    scripted: ScriptedCodexService,
    database: TestDatabase,
    session: SessionToMove,
    queue: SessionQueue,
    moves: Arc<RecordedMoves>,
    drained: tokio::task::JoinHandle<()>,
    left: ProviderAccountId,
    to: ProviderAccountId,
    homes: HashMap<ProviderAccountId, PathBuf>,
    tokens: HashMap<ProviderAccountId, String>,
    _folder: TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let database = TestDatabase::new(schema_parts());
        let (registry, _writer) = open_test_registry(&database, folder.path()).await;
        let minted = registry
            .mint(DESCRIPTOR.provider_id())
            .expect("the account is minted");
        let to = minted.account_id().clone();
        registry
            .admit(
                &minted,
                &AccountAdmission {
                    display_label: None,
                    billing_mode: BillingMode::Subscription,
                    health: Some(HealthObservation {
                        state: ProviderAccountHealthState::Authenticated,
                        observed_at: WireInstant::try_from("2026-10-31T18:00:00.000Z".to_owned())
                            .expect("a wire instant"),
                    }),
                    observed_auth_mode: Some(ProviderAuthMode::OauthSubscription),
                },
            )
            .await
            .expect("the account is admitted");
        let left = test_provider_account_id();
        let mut homes = HashMap::new();
        let mut tokens = HashMap::new();
        for (account, workspace) in [(&left, WORKSPACE_LEFT), (&to, WORKSPACE_TO)] {
            let home = folder.path().join(workspace);
            let token = compose_access_token(workspace);
            write_sign_in(&home, workspace, &token);
            homes.insert(account.clone(), home);
            tokens.insert(account.clone(), token);
        }

        let mut scripted = start_scripted_switching_service();
        AccountHomes {
            homes: homes.clone(),
            current: left.clone(),
            api_keys: HashMap::new(),
        }
        .register_on(&scripted.dependencies.provider_accounts);
        let accounts = Arc::new(PortRegistration::new("provider account registry"));
        assert!(accounts.register(Arc::new(registry)).is_ok());
        let legs = CodexAccountLegs::new(
            CodexServiceRegistry::holding(&scripted),
            Arc::clone(&scripted.dependencies),
            CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
            accounts,
            Arc::new(NothingServed),
            Arc::new(PortRegistration::new("account home lock")),
        );

        // The service carries the account left, as its start handed it.
        let service = Arc::clone(&scripted.service);
        let connection = service.connection().expect("the service is up");
        let switching = Arc::clone(&scripted.dependencies.switching);
        let (handed, _login) = tokio::join!(
            switching.hand_at_start(&service, &connection),
            answer_login(&mut scripted)
        );
        handed.expect("the start's login is answered");

        let session_id = new_session_id();
        let moves = Arc::new(RecordedMoves::default());
        let queue = SessionQueue::new(session_id, left.clone(), &moves);
        let drained = queue.attach(&scripted.service);
        scripted
            .service
            .register_thread(THREAD.to_owned(), session_id);
        Self {
            legs,
            scripted,
            database,
            session: SessionToMove {
                session_id,
                binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string())
                    .expect("a binding id"),
            },
            queue,
            moves,
            drained,
            left,
            to,
            homes,
            tokens,
            _folder: folder,
        }
    }

    // What the session's task saw, once the service let it go and its queue drained.
    async fn seen_by_the_session(self) -> Vec<String> {
        self.scripted
            .service
            .detach_session(&self.session.session_id);
        self.drained.await.expect("the session's task ends");
        self.queue.seen()
    }

    // The account's stored credential generation.
    fn credential_generation(&self) -> i64 {
        rusqlite::Connection::open(self.database.path())
            .expect("the database opens")
            .query_row(
                "SELECT credential_generation FROM provider_accounts WHERE account_id = ?",
                [self.to.as_str()],
                |row| row.get(0),
            )
            .expect("the account's row reads")
    }

    // Every request the connection sent that the test has not read.
    fn unread_requests(&mut self) -> Vec<Value> {
        std::iter::from_fn(|| self.scripted.script.sent.try_recv().ok())
            .map(|text| serde_json::from_str(&text).expect("the connection sends JSON"))
            .collect()
    }
}

// The service sends a frame of the session's conversation.
fn send_frame(scripted: &ScriptedCodexService, method: &str) {
    scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": {"threadId": THREAD, "turnId": "turn-1"},
    }));
}

// Reads the next request, which must be a login, and answers it.
async fn answer_login(scripted: &mut ScriptedCodexService) -> Value {
    let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
    scripted
        .script
        .answer(&login, &json!({"type": "chatgptAuthTokens"}));
    login
}

// The login's params a hand of `home`'s sign-in to `workspace` sends.
fn login_params(token: &str, workspace: &str) -> Value {
    json!({
        "type": "chatgptAuthTokens",
        "accessToken": token,
        "chatgptAccountId": workspace,
        "chatgptPlanType": TEST_PLAN,
    })
}

// A limit reached on the account left.
fn reached_on_the_account_left() -> CodexRateLimitObservation {
    observe_codex_rate_limit_read(&json!({"rateLimits": {
        "limitId": "codex",
        "primary": {"usedPercent": 100, "windowDurationMins": 300, "resetsAt": 1_800_000_000},
    }}))
}

// Reads the next request, which must be the switch's check, and answers it with the account
// signed in.
async fn answer_check(scripted: &mut ScriptedCodexService) {
    let check = scripted.next_request("account/read").await;
    scripted.script.answer(
        &check,
        &json!({"account": {"type": "chatgpt"}, "requiresOpenaiAuth": true}),
    );
}

// Settles a move's first request.
async fn first_request(moved: SessionAccountMove) -> FirstRequestAfterMove {
    moved
        .into_first_request()
        .await
        .expect("the first request settles")
}

// Fails when a switch sends anything but one login carrying the new account's tokens and one
// account read checking it, when a check answered with an account settles the move's first request
// as anything but run, when the move reaches the session at another place among its frames than the
// login's answer, when the service keeps carrying the account left or its limit readings, when
// those readings are lost to a frame of the account left that the session reads after the switch,
// when the credential generation moves, when a token reaches a log line, a reply or an error, when
// a login follows on a timer, or when the named session's move is reported, which the daemon
// records itself at the move's acknowledgment.
#[tokio::test]
async fn a_switch_is_one_login_whose_answer_moves_each_session_in_its_place() {
    let mut fixture = Fixture::new().await;
    fixture
        .scripted
        .service
        .store_rate_limit_read(reached_on_the_account_left());
    let generation_before = fixture.credential_generation();
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();

    let to = fixture.to.clone();
    let sessions = vec![fixture.session.clone()];
    let scripted = &mut fixture.scripted;
    let script = async {
        let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
        send_frame(scripted, "thread/tokenUsage/updated");
        scripted
            .script
            .answer(&login, &json!({"type": "chatgptAuthTokens"}));
        send_frame(scripted, "item/completed");
        login
    };
    let (moved, login) = tokio::join!(
        move_codex_sessions(
            &fixture.legs,
            to,
            sessions,
            switching_person(),
            oneshot::channel().0
        ),
        script
    );
    let replies = format!(
        "{:?}",
        moved
            .iter()
            .map(|moved| moved.as_ref().err())
            .collect::<Vec<_>>()
    );
    answer_check(&mut fixture.scripted).await;
    let mut settled = Vec::new();
    for moved in moved {
        let moved = moved.expect("the move lands");
        assert_eq!(moved.session_id, fixture.session.session_id);
        settled.push(first_request(moved).await);
    }

    // No login comes on a timer, however long the service runs on.
    tokio::time::pause();
    tokio::time::sleep(Duration::from_hours(1)).await;
    tokio::time::resume();
    fixture.queue.wait_until_seen(3).await;
    let after = fixture.unread_requests();
    let carried = fixture.scripted.service.provider_account_id();
    let readings = fixture.scripted.service.rate_limit_reading().observation;
    let readings_left = fixture
        .scripted
        .service
        .rate_limit_observation_of(&fixture.left);
    let generation_after = fixture.credential_generation();
    let to = fixture.to.clone();
    let token = fixture.tokens[&to].clone();
    let left_token = fixture.tokens[&fixture.left].clone();
    let moves = Arc::clone(&fixture.moves);
    let seen = fixture.seen_by_the_session().await;

    assert_eq!(moves.reported(), []);
    assert_eq!(login["params"], login_params(&token, WORKSPACE_TO));
    assert_eq!(
        after,
        Vec::<Value>::new(),
        "the switch sent more than its login and its check"
    );
    assert_eq!(settled, [FirstRequestAfterMove::Ran]);
    assert_eq!(
        seen,
        [
            "thread/tokenUsage/updated".to_owned(),
            format!("moved to {}", to.as_str()),
            "item/completed".to_owned(),
        ]
    );
    assert_eq!(carried, Some(to));
    assert_eq!(readings, CodexRateLimitObservation::default());
    assert_eq!(
        readings_left,
        reached_on_the_account_left(),
        "a frame queued before the switch still reads the limit of the account it ran on"
    );
    assert_eq!(generation_before, generation_after);
    for written in recorded.texts().iter().chain([&replies]) {
        for secret in [&token, &left_token] {
            assert!(
                !written.contains(secret.as_str()),
                "a token reached {written}"
            );
        }
    }
}

// Fails when a refused login moves a session, leaves the service carrying the account it was
// refused, resets the readings of the account still carried, answers a move as landed, loses the
// refusal's code, or lets the token into the error.
#[tokio::test]
async fn a_refused_login_moves_nothing_and_fails_every_move_with_the_refusal() {
    let mut fixture = Fixture::new().await;
    fixture
        .scripted
        .service
        .store_rate_limit_read(reached_on_the_account_left());
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();

    let to = fixture.to.clone();
    let sessions = vec![fixture.session.clone()];
    let scripted = &mut fixture.scripted;
    let script = async {
        let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
        scripted.script.send(&json!({
            "jsonrpc": "2.0",
            "id": login["id"],
            "error": {"code": -32600, "message": "the workspace is not allowed"},
        }));
    };
    let (moved, ()) = tokio::join!(
        move_codex_sessions(
            &fixture.legs,
            to,
            sessions,
            switching_person(),
            oneshot::channel().0
        ),
        script
    );

    let carried = fixture.scripted.service.provider_account_id();
    let readings = fixture.scripted.service.rate_limit_reading().observation;
    let left = fixture.left.clone();
    let token = fixture.tokens[&fixture.to].clone();
    let session_id = fixture.session.session_id;
    let seen = fixture.seen_by_the_session().await;

    assert_eq!(moved.len(), 1);
    let Some(Err((failed, error))) = moved.into_iter().next() else {
        panic!("the move landed though the login was refused");
    };
    assert_eq!(failed, session_id);
    let written = format!("{error} {error:?}");
    assert!(
        !written.contains(token.as_str()),
        "the token reached the error"
    );
    for message in recorded.texts() {
        assert!(
            !message.contains(token.as_str()),
            "the token reached {message}"
        );
    }
    assert_eq!(seen, Vec::<String>::new());
    assert_eq!(carried, Some(left));
    assert_eq!(readings, reached_on_the_account_left());
}

// Fails when an account with no sign-in in its home is sent a login, or its refusal is not
// `provider.account.notAuthenticated`.
#[tokio::test]
async fn a_switch_to_an_account_signed_out_of_its_home_refuses_before_any_login() {
    let mut fixture = Fixture::new().await;
    std::fs::remove_file(fixture.homes[&fixture.to].join("auth.json")).expect("auth.json goes");

    let to = fixture.to.clone();
    let sessions = vec![fixture.session.clone()];
    let moved = move_codex_sessions(
        &fixture.legs,
        to,
        sessions,
        switching_person(),
        oneshot::channel().0,
    )
    .await;
    let sent = fixture.unread_requests();
    fixture.seen_by_the_session().await;

    let Some(Err((_, DriverError::Refused(refusal)))) = moved.into_iter().next() else {
        panic!("the move was not refused");
    };
    assert_eq!(refusal.code, RefusalCode::ProviderAccountNotAuthenticated);
    assert_eq!(sent, Vec::<Value>::new());
}

// Fails when a renewal of the carried account's token while a command runs is handed as anything
// but one login with the new token, when the daemon stops or resumes the command's turn for it,
// when an unchanged token is handed again, or when a renewal in the home of an account the service
// does not carry is handed to it.
#[tokio::test]
async fn a_renewed_token_is_handed_once_and_the_running_command_is_left_running() {
    let mut fixture = Fixture::new().await;
    send_frame(&fixture.scripted, "item/started");
    let left = fixture.left.clone();
    let left_home = fixture.homes[&left].clone();
    let to = fixture.to.clone();
    let to_home = fixture.homes[&to].clone();

    let unchanged = hand_switching_service_again(&fixture.legs, &left, &left_home).await;
    let unchanged_sent = fixture.unread_requests();
    let renewed = compose_access_token("renewed");
    write_sign_in(&left_home, WORKSPACE_LEFT, &renewed);
    write_sign_in(
        &to_home,
        WORKSPACE_TO,
        &compose_access_token("renewed elsewhere"),
    );
    let not_carried = hand_switching_service_again(&fixture.legs, &to, &to_home).await;
    let not_carried_sent = fixture.unread_requests();
    let (handed, login) = tokio::join!(
        hand_switching_service_again(&fixture.legs, &left, &left_home),
        answer_login(&mut fixture.scripted)
    );
    let handed_again = hand_switching_service_again(&fixture.legs, &left, &left_home).await;
    send_frame(&fixture.scripted, "item/completed");
    fixture.queue.wait_until_seen(2).await;
    let after = fixture.unread_requests();
    let seen = fixture.seen_by_the_session().await;

    assert!(unchanged.is_ok() && not_carried.is_ok() && handed.is_ok() && handed_again.is_ok());
    assert_eq!(unchanged_sent, Vec::<Value>::new());
    assert_eq!(not_carried_sent, Vec::<Value>::new());
    assert_eq!(login["params"], login_params(&renewed, WORKSPACE_LEFT));
    assert_eq!(
        after,
        Vec::<Value>::new(),
        "the renewal sent more than its login"
    );
    assert_eq!(seen, ["item/started", "item/completed"]);
}

// Fails when a session following the current account starts on the switching service while it
// still carries the account a switch with no live session left, so its usage would land on the
// wrong account, or when a service already carrying the session's account is handed it again.
#[tokio::test]
async fn a_session_start_moves_the_switching_service_onto_its_account_once() {
    let mut fixture = Fixture::new().await;
    let to = fixture.to.clone();
    let service = Arc::clone(&fixture.scripted.service);
    let switching = Arc::clone(&fixture.scripted.dependencies.switching);

    let (carried, login) = tokio::join!(
        switching.carry_for_session(&service, &to),
        answer_login(&mut fixture.scripted)
    );
    answer_check(&mut fixture.scripted).await;
    let again = switching.carry_for_session(&service, &to).await;
    let after = fixture.unread_requests();
    let token = fixture.tokens[&to].clone();

    assert!(carried.is_ok() && again.is_ok());
    assert_eq!(login["params"], login_params(&token, WORKSPACE_TO));
    assert_eq!(service.provider_account_id(), Some(to));
    assert_eq!(
        after,
        Vec::<Value>::new(),
        "a carried account was handed again"
    );
}

// Fails when a renewal of the account a switch is leaving is handed while the switch's login
// waits for its answer, which would put the service back on the account left once the switch
// lands.
#[tokio::test]
async fn a_renewal_waiting_on_a_switch_hands_nothing_once_the_switch_lands() {
    let mut fixture = Fixture::new().await;
    let left = fixture.left.clone();
    let left_home = fixture.homes[&left].clone();
    write_sign_in(&left_home, WORKSPACE_LEFT, &compose_access_token("renewed"));
    let to = fixture.to.clone();
    let sessions = vec![fixture.session.clone()];
    let (login_sent, renewal_starts) = oneshot::channel();
    let legs = &fixture.legs;
    let scripted = &mut fixture.scripted;
    let renewal = async {
        renewal_starts.await.expect("the switch's login is sent");
        hand_switching_service_again(legs, &left, &left_home).await
    };
    let script = async {
        let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
        login_sent.send(()).expect("the renewal waits");
        let renewal_login =
            tokio::time::timeout(Duration::from_millis(200), scripted.script.next_sent()).await;
        scripted
            .script
            .answer(&login, &json!({"type": "chatgptAuthTokens"}));
        renewal_login.ok()
    };
    let (moved, renewed, renewal_login) = tokio::join!(
        move_codex_sessions(
            legs,
            to.clone(),
            sessions,
            switching_person(),
            oneshot::channel().0
        ),
        renewal,
        script
    );
    answer_check(&mut fixture.scripted).await;
    let after = fixture.unread_requests();

    assert!(moved.iter().all(Result::is_ok));
    assert!(renewed.is_ok());
    assert_eq!(
        renewal_login, None,
        "the renewal was handed under the switch"
    );
    assert_eq!(
        after,
        Vec::<Value>::new(),
        "the renewal was handed over the switch"
    );
    assert_eq!(fixture.scripted.service.provider_account_id(), Some(to));
}

// Fails when a switch's login that was written and never answered leaves the service carrying the
// account left, which the next start or session start would then never hand again.
#[tokio::test]
async fn a_switch_login_never_answered_leaves_the_carried_account_unknown() {
    let mut fixture = Fixture::new().await;
    let to = fixture.to.clone();
    let sessions = vec![fixture.session.clone()];
    tokio::time::pause();
    let scripted = &mut fixture.scripted;
    let (moved, _login) = tokio::join!(
        move_codex_sessions(
            &fixture.legs,
            to,
            sessions,
            switching_person(),
            oneshot::channel().0
        ),
        scripted.next_request(CODEX_LOGIN_START_METHOD)
    );
    tokio::time::resume();

    assert!(moved.iter().all(Result::is_err));
    assert_eq!(fixture.scripted.service.provider_account_id(), None);
}

// Fails when a renewed token the switching service refused is answered as handed, which hides
// the failure from the read that found it, or when the next read does not hand it again.
#[tokio::test]
async fn a_refused_renewal_fails_and_the_next_read_hands_it_again() {
    let mut fixture = Fixture::new().await;
    let left = fixture.left.clone();
    let left_home = fixture.homes[&left].clone();
    let renewed = compose_access_token("renewed");
    write_sign_in(&left_home, WORKSPACE_LEFT, &renewed);
    let legs = &fixture.legs;
    let scripted = &mut fixture.scripted;
    let refuse = async {
        let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
        scripted.script.send(&json!({
            "jsonrpc": "2.0",
            "id": login["id"],
            "error": {"code": -32603, "message": "the login failed"},
        }));
    };
    let (refused, ()) = tokio::join!(
        hand_switching_service_again(legs, &left, &left_home),
        refuse
    );
    let (handed, login) = tokio::join!(
        hand_switching_service_again(legs, &left, &left_home),
        answer_login(scripted)
    );

    assert!(refused.is_err(), "a refused hand was answered as handed");
    assert!(handed.is_ok());
    assert_eq!(login["params"], login_params(&renewed, WORKSPACE_LEFT));
}

// Fails when a session start hands the switching service the account a refused switch was moving
// it to without moving the sessions the refusal left on it, which then run on the new account's
// sign-in while their bindings and usage stay on the account left, or without reporting the move
// for the daemon to record, since no switch waits on it.
#[tokio::test]
async fn a_session_start_after_a_refused_switch_moves_the_sessions_left_behind() {
    let mut fixture = Fixture::new().await;
    let to = fixture.to.clone();
    let service = Arc::clone(&fixture.scripted.service);
    let switching = Arc::clone(&fixture.scripted.dependencies.switching);
    let sessions = vec![fixture.session.clone()];
    let scripted = &mut fixture.scripted;
    let refuse = async {
        let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
        scripted.script.send(&json!({
            "jsonrpc": "2.0",
            "id": login["id"],
            "error": {"code": -32600, "message": "the workspace is not allowed"},
        }));
    };
    let (refused, ()) = tokio::join!(
        move_codex_sessions(
            &fixture.legs,
            to.clone(),
            sessions,
            switching_person(),
            oneshot::channel().0
        ),
        refuse
    );
    let (carried, _login) = tokio::join!(
        switching.carry_for_session(&service, &to),
        answer_login(&mut fixture.scripted)
    );
    fixture.queue.wait_until_seen(1).await;
    let moves = Arc::clone(&fixture.moves);
    let session_id = fixture.session.session_id;
    let seen = fixture.seen_by_the_session().await;

    assert!(refused.iter().all(Result::is_err));
    assert!(carried.is_ok());
    assert_eq!(service.provider_account_id(), Some(to.clone()));
    assert_eq!(seen, [format!("moved to {}", to.as_str())]);
    assert_eq!(moves.reported(), [(session_id, to, None)]);
}

// Fails when a switch moves a session attached to the service that it did not name, as one with no
// lead yet, onto the new account without moving its record's binding or reporting the move for
// the daemon to record by the person whose switch it is, or when it reports the session it named.
#[tokio::test]
async fn a_switch_reports_each_session_it_moved_without_naming_it() {
    let mut fixture = Fixture::new().await;
    let person = switching_person();
    let unnamed = SessionQueue::new(new_session_id(), fixture.left.clone(), &fixture.moves);
    let unnamed_drained = unnamed.attach(&fixture.scripted.service);
    let to = fixture.to.clone();
    let sessions = vec![fixture.session.clone()];
    let (moved, _login) = tokio::join!(
        move_codex_sessions(
            &fixture.legs,
            to.clone(),
            sessions,
            person.clone(),
            oneshot::channel().0
        ),
        answer_login(&mut fixture.scripted)
    );
    fixture.queue.wait_until_seen(1).await;
    unnamed.wait_until_seen(1).await;
    fixture.scripted.service.detach_session(&unnamed.session_id);
    unnamed_drained
        .await
        .expect("the unnamed session's task ends");
    let moves = Arc::clone(&fixture.moves);
    let seen = fixture.seen_by_the_session().await;

    assert!(moved.iter().all(Result::is_ok));
    assert_eq!(seen, [format!("moved to {}", to.as_str())]);
    assert_eq!(unnamed.seen(), [format!("moved to {}", to.as_str())]);
    assert_eq!(
        moves.reported(),
        [(unnamed.session_id, to.clone(), Some(person))]
    );
    assert!(lock(&moves.bindings).contains(&(unnamed.record_binding.clone(), to)));
}

// Fails when a rejoined service carrying no account, after a login never answered, moves a session
// whose record ran on another account onto the current one without reporting the move for the
// daemon to record, since no switch waits on it.
#[tokio::test]
async fn a_rejoin_carrying_no_account_reports_each_session_it_moved() {
    let mut fixture = Fixture::new().await;
    *lock(&fixture.queue.record_account) = fixture.to.clone();
    let to = fixture.to.clone();
    let sessions = vec![fixture.session.clone()];
    tokio::time::pause();
    let scripted = &mut fixture.scripted;
    let (unanswered, _login) = tokio::join!(
        move_codex_sessions(
            &fixture.legs,
            to,
            sessions,
            switching_person(),
            oneshot::channel().0
        ),
        scripted.next_request(CODEX_LOGIN_START_METHOD)
    );
    tokio::time::resume();
    let service = Arc::clone(&fixture.scripted.service);
    let connection = service.connection().expect("the service is up");
    let switching = Arc::clone(&fixture.scripted.dependencies.switching);
    let (handed, _login) = tokio::join!(
        switching.hand_at_start(&service, &connection),
        answer_login(&mut fixture.scripted)
    );
    fixture.queue.wait_until_seen(1).await;
    let moves = Arc::clone(&fixture.moves);
    let session_id = fixture.session.session_id;
    let left = fixture.left.clone();
    let seen = fixture.seen_by_the_session().await;

    assert!(unanswered.iter().all(Result::is_err));
    assert!(handed.is_ok());
    assert_eq!(service.provider_account_id(), Some(left.clone()));
    assert_eq!(seen, [format!("moved to {}", left.as_str())]);
    assert_eq!(moves.reported(), [(session_id, left, None)]);
}
