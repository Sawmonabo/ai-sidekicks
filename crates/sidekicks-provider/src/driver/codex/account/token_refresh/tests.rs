use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tempfile::TempDir;

use super::{CodexRenewal, CodexTokenRenewer};
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::{
    AccountAdmission, HealthObservation, ProviderAccountRegistry, open_test_registry,
};
use crate::captured_logs::CapturedLogs;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::account::auth_file::read_codex_auth_tokens;
use crate::driver::codex::account::login::CODEX_LOGIN_START_METHOD;
use crate::driver::codex::auth_status::read_codex_auth_status;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::server_requests::{
    CODEX_TOKEN_REFRESH_METHOD, compose_token_refresh_refusal, compose_unrouted_request_error,
};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome};
use crate::driver::codex::service::supervisor::CodexServiceDependencies;
use crate::driver::codex::service::supervisor::connection_events::DetachedConnectionEvents;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, TestCodexProgram, UnheardEvents, start_scripted_account_service_for,
    start_scripted_switching_service, test_codex_service_dependencies,
};
use crate::driver::codex::service::switching::test_sign_in::{
    AccountHomes, TEST_PLAN, compose_access_token, write_sign_in,
};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::transport::connection::scripted_service::{
    ScriptedService, connect_scripted_service,
};
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::NothingServed;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The `ChatGPT` workspace every test sign-in is for.
const WORKSPACE: &str = "workspace-renewed";

/// How long a test watches for an answer that must not come yet.
const QUIET_WAIT: Duration = Duration::from_millis(200);

/// The largest message a detached test connection takes, far above any a test sends.
const DETACHED_MESSAGE_LIMIT: usize = 1 << 20;

/// What may appear in the log while a refresh is answered: a refusal's line, never a token.
const ALLOWED_LOG_MESSAGES: [&str; 1] = ["a Codex token refresh was refused"];

/// Codex's wait for a refresh's answer.
const CODEX_REFRESH_WAIT: Duration = Duration::from_secs(10);

// Every line logged so far holds an allowed message and none of `tokens`.
fn assert_logs_hold_no_token(logs: &CapturedLogs, tokens: &[&str]) {
    let log = logs.text();
    for token in tokens {
        assert!(!log.contains(token), "{log}");
    }
    for line in log.lines() {
        assert!(
            ALLOWED_LOG_MESSAGES
                .iter()
                .any(|allowed| line.contains(allowed)),
            "{line}"
        );
    }
}

/// A registered account whose home's own service the test scripts, holding a sign-in on the
/// token `t0`, the scripted switching service, and the legs over both, whose renewer the
/// switching service's refreshes reach.
struct Fixture {
    switching: ScriptedCodexService,
    home: ScriptedCodexService,
    home_lock: Arc<AccountHomeLock>,
    registry: ProviderAccountRegistry,
    account_id: ProviderAccountId,
    codex_home: PathBuf,
    _legs: Arc<CodexAccountLegs>,
    _writer: Arc<DatabaseWriter>,
    _database: TestDatabase,
    _data_folder: TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder is made");
        let (registry, writer) = open_test_registry(&database, data_folder.path()).await;
        let minted = registry
            .mint(DESCRIPTOR.provider_id())
            .expect("the account is minted");
        let account_id = minted.account_id().clone();
        registry
            .admit(
                &minted,
                &AccountAdmission {
                    display_label: None,
                    billing_mode: BillingMode::Subscription,
                    health: Some(HealthObservation {
                        state: ProviderAccountHealthState::Authenticated,
                        observed_at: WireInstant::try_from("2026-10-29T18:00:00.000Z".to_owned())
                            .expect("a wire instant"),
                    }),
                    observed_auth_mode: Some(ProviderAuthMode::OauthSubscription),
                },
            )
            .await
            .expect("the account is admitted");
        let switching = start_scripted_switching_service();
        let home = start_scripted_account_service_for(account_id.clone());
        let codex_home = home.service.home().codex_home.clone();
        write_sign_in(&codex_home, WORKSPACE, &compose_access_token("t0"));
        AccountHomes {
            homes: HashMap::from([(account_id.clone(), codex_home.clone())]),
            current: account_id.clone(),
            api_keys: HashMap::new(),
        }
        .register_on(switching.dependencies.switching.provider_accounts());
        let home_lock = Arc::new(AccountHomeLock::default());
        let legs = CodexAccountLegs::new(
            CodexServiceRegistry::holding_service_on(
                &home.service,
                Arc::clone(&switching.dependencies),
                Arc::new(OneHome(home.service.home().clone())),
            ),
            Arc::clone(&switching.dependencies),
            CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
            Arc::new(PortRegistration::new("provider account registry")),
            Arc::new(NothingServed),
            registered_lock(&home_lock),
        );
        Self {
            switching,
            home,
            home_lock,
            registry,
            account_id,
            codex_home,
            _legs: legs,
            _writer: writer,
            _database: database,
            _data_folder: data_folder,
        }
    }

    // Hands the switching service the account's tokens, as its start does.
    async fn carry(&mut self) {
        let service = Arc::clone(&self.switching.service);
        let connection = service.connection().expect("the switching service is up");
        let switching = Arc::clone(&self.switching.dependencies.switching);
        let (handed, ()) = tokio::join!(
            switching.hand_at_start(&service, &connection),
            answer_login(&mut self.switching)
        );
        handed.expect("the start's login is answered");
    }

    // A second connection on the switching service that belongs to no session, with its script.
    fn open_detached(&self) -> (CodexAppServerConnection, ScriptedService) {
        connect_scripted_service(
            DETACHED_MESSAGE_LIMIT,
            self.switching
                .service
                .detached_connection_handlers(Arc::new(DetachedConnectionEvents)),
        )
    }

    // Answers the home's renewing read, writing `renewed` into its `auth.json` first where the
    // renewal took.
    async fn answer_renewing_read(&mut self, renewed: Option<&str>) {
        let read = self.home.next_request("account/read").await;
        assert_eq!(read["params"]["refreshToken"], json!(true), "{read}");
        if let Some(renewed) = renewed {
            write_sign_in(&self.codex_home, WORKSPACE, renewed);
        }
        self.home.script.answer(
            &read,
            &json!({"account": {"type": "chatgpt"}, "requiresOpenaiAuth": true}),
        );
    }
}

fn registered_lock(
    home_lock: &Arc<AccountHomeLock>,
) -> Arc<PortRegistration<Arc<AccountHomeLock>>> {
    let port = Arc::new(PortRegistration::new("account home lock"));
    assert!(port.register(Arc::clone(home_lock)).is_ok());
    port
}

async fn answer_login(scripted: &mut ScriptedCodexService) {
    let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
    scripted
        .script
        .answer(&login, &json!({"type": "chatgptAuthTokens"}));
}

fn refresh_request(id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": CODEX_TOKEN_REFRESH_METHOD,
        "params": {"reason": "unauthorized", "previousAccountId": WORKSPACE},
    })
}

fn tokens_answer(id: &str, access_token: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "accessToken": access_token,
            "chatgptAccountId": WORKSPACE,
            "chatgptPlanType": TEST_PLAN,
        },
    })
}

fn refusal_answer(id: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": compose_token_refresh_refusal()})
}

// Killed by answering tokens read before the renewal, by a detached connection with no refresher,
// by judging against the token carried at answer time (a second renewing read), and by a log line
// holding a token.
#[tokio::test]
async fn a_refresh_on_any_connection_is_answered_with_the_tokens_the_home_renewed() {
    let (logs, _capture) = CapturedLogs::start();
    let mut fixture = Fixture::new().await;
    fixture.carry().await;
    let (_detached_connection, mut detached) = fixture.open_detached();
    let refused = compose_access_token("t0");
    let renewed = compose_access_token("t1");

    fixture.switching.script.send(&refresh_request("main"));
    detached.send(&refresh_request("detached"));
    fixture.answer_renewing_read(Some(&renewed)).await;

    assert_eq!(
        fixture.switching.script.next_sent().await,
        tokens_answer("main", &renewed)
    );
    assert_eq!(
        detached.next_sent().await,
        tokens_answer("detached", &renewed)
    );
    assert!(
        fixture.home.script.sent.try_recv().is_err(),
        "the home saw one renewing read"
    );
    assert_logs_hold_no_token(&logs, &[refused.as_str(), renewed.as_str()]);
}

// Killed by renewing on every refresh: a limits read holding the home renewed it first.
#[tokio::test]
async fn a_refresh_after_the_home_was_renewed_answers_without_a_renewal() {
    let mut fixture = Fixture::new().await;
    fixture.carry().await;
    let renewed = compose_access_token("t1");

    let limits_read = fixture.home_lock.hold(fixture.account_id.clone()).await;
    fixture.switching.script.send(&refresh_request("main"));
    tokio::time::sleep(QUIET_WAIT).await;
    assert!(
        fixture.switching.script.sent.try_recv().is_err(),
        "the refresh waits for the home"
    );
    write_sign_in(&fixture.codex_home, WORKSPACE, &renewed);
    drop(limits_read);

    assert_eq!(
        fixture.switching.script.next_sent().await,
        tokens_answer("main", &renewed)
    );
    assert!(
        fixture.home.script.sent.try_recv().is_err(),
        "no renewing read ran"
    );
}

// Killed by no memory of a dead renewal (a second read for the retry), by a refresher on every
// service (the pinned one answering anything but `-32601`), by a refusal naming a token, and by a
// refresh moving the account's generation or health.
#[tokio::test]
async fn a_dead_renewal_is_refused_and_its_retry_refused_with_no_second_read() {
    let (logs, _capture) = CapturedLogs::start();
    let mut fixture = Fixture::new().await;
    fixture.carry().await;
    let refused = compose_access_token("t0");
    let before = fixture
        .registry
        .read(fixture.account_id.clone())
        .await
        .expect("the account reads");

    fixture.switching.script.send(&refresh_request("first"));
    fixture.answer_renewing_read(None).await;
    let first = fixture.switching.script.next_sent().await;
    fixture.switching.script.send(&refresh_request("retry"));
    let retry = fixture.switching.script.next_sent().await;
    fixture.home.script.send(&refresh_request("pinned"));
    let pinned = fixture.home.script.next_sent().await;

    assert_eq!(first, refusal_answer("first"));
    assert_eq!(retry, refusal_answer("retry"));
    assert!(!first.to_string().contains(&refused), "{first}");
    assert!(
        fixture.home.script.sent.try_recv().is_err(),
        "the retry ran no second read"
    );
    assert_eq!(
        pinned,
        json!({"jsonrpc": "2.0", "id": "pinned", "error": compose_unrouted_request_error()})
    );
    let after = fixture
        .registry
        .read(fixture.account_id.clone())
        .await
        .expect("the account reads");
    assert_eq!(after.credential_generation, before.credential_generation);
    assert_eq!(after.health, before.health);
    assert_logs_hold_no_token(&logs, &[refused.as_str()]);
}

// Killed by refusing a refresh that finds no account carried at its arrival.
#[tokio::test]
async fn a_refresh_during_a_rejoins_hand_is_answered_with_the_tokens_it_handed() {
    let mut fixture = Fixture::new().await;
    let handed = compose_access_token("t0");
    let service = Arc::clone(&fixture.switching.service);
    let connection = service.connection().expect("the switching service is up");
    let switching = Arc::clone(&fixture.switching.dependencies.switching);
    let scripted = &mut fixture.switching;

    let (hand, ()) = tokio::join!(switching.hand_at_start(&service, &connection), async {
        let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
        scripted.script.send(&refresh_request("during"));
        tokio::time::sleep(QUIET_WAIT).await;
        assert!(
            scripted.script.sent.try_recv().is_err(),
            "the refresh waits for the hand"
        );
        scripted
            .script
            .answer(&login, &json!({"type": "chatgptAuthTokens"}));
    });
    hand.expect("the rejoin's login is answered");

    assert_eq!(
        fixture.switching.script.next_sent().await,
        tokens_answer("during", &handed)
    );
    assert!(
        fixture.home.script.sent.try_recv().is_err(),
        "no renewing read ran"
    );
}

// The dependencies a probe's services run on: the downloaded Codex program
// `SIDEKICKS_TEST_CODEX_PROGRAM` names, with this machine's `HOME` and `PATH`.
fn probe_dependencies(folder: &TempDir) -> Arc<CodexServiceDependencies> {
    let program = std::env::var_os("SIDEKICKS_TEST_CODEX_PROGRAM")
        .expect("SIDEKICKS_TEST_CODEX_PROGRAM names the downloaded Codex program");
    let environment = ["HOME", "PATH"]
        .into_iter()
        .filter_map(|name| Some((name.to_owned(), std::env::var(name).ok()?)))
        .collect();
    test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program: PathBuf::from(program),
            environment,
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    )
}

// The legs a probe renews through, over a registry holding no service, so a renewal starts a
// short-lived one on the account's home.
fn probe_legs(
    folder: &TempDir,
    dependencies: &Arc<CodexServiceDependencies>,
) -> Arc<CodexAccountLegs> {
    CodexAccountLegs::new(
        Arc::new(CodexServiceRegistry::new(
            Arc::new(OneHome(CodexServiceHome {
                codex_home: folder.path().join("unpinned"),
                kind: CodexHomeKind::Account(test_provider_account_id()),
            })),
            Arc::clone(dependencies),
        )),
        Arc::clone(dependencies),
        CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
        Arc::new(PortRegistration::new("provider account registry")),
        Arc::new(NothingServed),
        registered_lock(&Arc::new(AccountHomeLock::default())),
    )
}

// Measures the renewal a refresh waits on, a short-lived service's start and its renewing read in
// the copy of a signed-in home `SIDEKICKS_TEST_CODEX_HOME` names, against Codex's 10 s wait. It
// renews that copy's sign-in, which spends its refresh token.
#[tokio::test]
#[ignore = "needs a downloaded Codex release and a copy of a signed-in Codex home"]
async fn a_renewal_on_a_short_lived_service_answers_inside_codexs_wait() {
    let codex_home = PathBuf::from(
        std::env::var_os("SIDEKICKS_TEST_CODEX_HOME")
            .expect("SIDEKICKS_TEST_CODEX_HOME names a copy of a signed-in Codex home"),
    );
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let dependencies = probe_dependencies(&folder);
    let legs = probe_legs(&folder, &dependencies);
    let refused = read_codex_auth_tokens(&codex_home)
        .await
        .expect("the home's auth.json reads")
        .expect("the home holds a ChatGPT sign-in")
        .access_token;

    let started = Instant::now();
    let renewal = CodexTokenRenewer::new(Arc::downgrade(&legs))
        .renew(test_provider_account_id(), codex_home, refused)
        .await;
    let elapsed = started.elapsed();

    assert!(
        matches!(renewal, Ok(CodexRenewal::Renewed(_) | CodexRenewal::Dead)),
        "the renewal was judged"
    );
    assert!(elapsed < CODEX_REFRESH_WAIT, "{elapsed:?}");
}

// Checks that an `account/read` on a service handed a login that no longer renews asks the daemon
// for fresh tokens: the switching service starts on the sign-in in the home
// `SIDEKICKS_TEST_CODEX_DEAD_HOME` names, and the read's refresh reaches the renewer, which finds
// the sign-in dead.
#[tokio::test]
#[ignore = "needs a downloaded Codex release and a Codex home whose sign-in no longer renews"]
async fn an_account_read_on_a_dead_handed_login_asks_for_fresh_tokens() {
    let (logs, _capture) = CapturedLogs::start();
    let dead_home = PathBuf::from(
        std::env::var_os("SIDEKICKS_TEST_CODEX_DEAD_HOME")
            .expect("SIDEKICKS_TEST_CODEX_DEAD_HOME names a Codex home whose sign-in is dead"),
    );
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let dependencies = probe_dependencies(&folder);
    AccountHomes {
        homes: HashMap::from([(test_provider_account_id(), dead_home)]),
        current: test_provider_account_id(),
        api_keys: HashMap::new(),
    }
    .register_on(dependencies.switching.provider_accounts());
    let legs = probe_legs(&folder, &dependencies);
    let service = legs
        .registry
        .switching_service()
        .await
        .expect("the switching service is made");
    service
        .ensure_started(dependencies.startup_timeout)
        .await
        .expect("the switching service starts on the handed login");
    let connection = service.connection().expect("the switching service is up");

    let _read = read_codex_auth_status(&connection, Duration::from_secs(20)).await;
    service.stop().await;

    let log = logs.text();
    assert!(log.contains("its sign-in renews no more"), "{log}");
}
