use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tempfile::TempDir;

use crate::account::registry::{AccountAdmission, HealthObservation, open_test_registry};
use crate::driver::ProviderAccountFolders;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome};
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_account_service_for,
};
use crate::driver::contract::account::{ProviderObservation, ProviderObserveLegs};
use crate::driver::schema::schema_parts;
use crate::port::usage_sink::{MeteredUsage, ProviderQuotaWindow, UsageSink};
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::usage_delta_accountant::UsageAxisCounts;

/// How long the test watches for a request that must not come.
const QUIET_WAIT: Duration = Duration::from_millis(200);

/// Codex's refusal of a limits read.
fn refused_limits_read() -> (&'static str, Value) {
    (
        "account/rateLimits/read",
        json!({"error": {"code": -32603, "message": "the usage read was refused"}}),
    )
}

/// The home's account read finding an account signed in.
fn signed_in_account_read() -> (&'static str, Value) {
    (
        "account/read",
        json!({"result": {"account": {"type": "chatgpt"}}}),
    )
}

/// Each set of quota windows the usage record took, with the account it was filed under.
#[derive(Default)]
struct RecordedWindows(Mutex<Vec<(ProviderAccountId, Vec<ProviderQuotaWindow>)>>);

impl UsageSink for RecordedWindows {
    fn record_metered(
        &self,
        _metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Ok(()) }.boxed()
    }

    fn record_quota_windows(
        &self,
        _provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.0).push((provider_account_id, windows));
        async { Ok(()) }.boxed()
    }

    fn read_prior_emitted(
        &self,
        _session_id: SessionId,
        _thread_id: String,
    ) -> BoxFuture<'_, Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>> {
        async { Ok(UsageAxisCounts::default()) }.boxed()
    }
}

/// A registered Codex account whose home's own service the test scripts, and the legs over a
/// driver registry holding that service, every account resolving to another home, as the one the
/// unpinned sessions run in.
struct Fixture {
    legs: CodexAccountLegs,
    database: TestDatabase,
    recorded: Arc<RecordedWindows>,
    scripted: ScriptedCodexService,
    account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
    _data_folder: TempDir,
}

impl Fixture {
    async fn new(observed_auth_mode: ProviderAuthMode) -> Self {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder is made");
        let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
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
                    health: HealthObservation {
                        state: ProviderAccountHealthState::Authenticated,
                        observed_at: WireInstant::try_from("2026-10-29T18:00:00.000Z".to_owned())
                            .expect("a wire instant"),
                    },
                    observed_auth_mode: Some(observed_auth_mode),
                },
            )
            .await
            .expect("the account is admitted");
        let scripted = start_scripted_account_service_for(account_id.clone());
        let codex_home = scripted.service.home().codex_home.clone();
        let other_home = OneHome(CodexServiceHome {
            codex_home: data_folder.path().join("unpinned"),
            kind: CodexHomeKind::Account(test_provider_account_id()),
        });
        let recorded = Arc::new(RecordedWindows::default());
        let usage = Arc::new(PortRegistration::new("usage"));
        assert!(
            usage
                .register(Arc::clone(&recorded) as Arc<dyn UsageSink>)
                .is_ok()
        );
        let legs = CodexAccountLegs::new(
            CodexServiceRegistry::holding_on(&scripted, Arc::new(other_home)),
            Arc::clone(&scripted.dependencies),
            CodexRateLimitFiling::new(usage),
            Arc::new(registry),
        );
        Self {
            legs,
            database,
            recorded,
            scripted,
            account_id,
            folders: ProviderAccountFolders {
                configuration_folder: codex_home.clone(),
                credential_store_folder: codex_home,
            },
            _data_folder: data_folder,
        }
    }

    // One limits read of the account's home, the home's service answering each request in turn
    // with the frame members `answers` gives beside its method, and, given `renewed_at`, rewriting
    // the home's `auth.json` with that renewal time once the first request arrives.
    async fn observe(
        &mut self,
        answers: &[(&str, Value)],
        renewed_at: Option<(&str, i64)>,
    ) -> ProviderObservation {
        let script = &mut self.scripted.script;
        let codex_home = &self.folders.configuration_folder;
        let answered = async {
            for (index, (method, answer)) in answers.iter().enumerate() {
                let request = script.next_sent().await;
                if index == 0
                    && let Some((last_refresh, expiry)) = renewed_at
                {
                    write_auth_file(codex_home, last_refresh, expiry);
                }
                assert_eq!(request["method"], *method, "{request}");
                if *method == "account/rateLimits/read" {
                    assert_eq!(
                        request["params"]["excludeResetCreditDetails"],
                        json!(true),
                        "{request}"
                    );
                }
                let mut frame = answer.clone();
                frame["jsonrpc"] = json!("2.0");
                frame["id"] = request["id"].clone();
                script.send(&frame);
            }
        };
        let (observed, ()) = tokio::join!(
            self.legs
                .observe(self.account_id.clone(), self.folders.clone()),
            answered
        );
        observed.expect("the read is answered")
    }

    // The account's stored reset credits.
    fn reset_credits(&self) -> Option<i64> {
        rusqlite::Connection::open(self.database.path())
            .expect("the database opens")
            .query_row(
                "SELECT reset_credits_available FROM provider_accounts WHERE account_id = ?",
                [self.account_id.as_str()],
                |row| row.get(0),
            )
            .expect("the account's row reads")
    }
}

// Killed by the windows filed under another account than the home's, by the read sent on the
// service the account resolves to rather than its home's own (that home's start fails, so no
// figures come), and by the reset credits left unwritten or kept when the next read carried none.
#[tokio::test]
async fn a_snapshot_becomes_windows_under_the_home_s_account_and_its_credits_land_in_the_row() {
    let mut fixture = Fixture::new(ProviderAuthMode::OauthSubscription).await;
    let snapshot = json!({
        "limitId": "codex",
        "primary": {"usedPercent": 25, "windowDurationMins": 300, "resetsAt": 1_800_000_000},
        "secondary": {"usedPercent": 40, "windowDurationMins": 10_080},
    });

    let with_credits = fixture
        .observe(
            &[(
                "account/rateLimits/read",
                json!({"result": {
                    "rateLimits": snapshot,
                    "rateLimitResetCredits": {"availableCount": 3, "credits": null},
                }}),
            )],
            None,
        )
        .await;
    let credits_after_first = fixture.reset_credits();
    let without_credits = fixture
        .observe(
            &[(
                "account/rateLimits/read",
                json!({"result": {"rateLimits": snapshot}}),
            )],
            None,
        )
        .await;

    assert_eq!(with_credits, ProviderObservation::Figures);
    assert_eq!(without_credits, ProviderObservation::Figures);
    let recorded = lock(&fixture.recorded.0).clone();
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    let (filed_under, windows) = &recorded[0];
    assert_eq!(filed_under, &fixture.account_id);
    assert_eq!(
        windows
            .iter()
            .map(|window| (window.limit_id.as_str(), window.window_mins))
            .collect::<Vec<_>>(),
        [("codex", 300), ("codex", 10_080)]
    );
    assert_eq!(credits_after_first, Some(3));
    assert_eq!(fixture.reset_credits(), None);
}

// Killed by dropping the mode check: the read would reach the home's service.
#[tokio::test]
async fn an_api_key_account_is_not_read() {
    let mut fixture = Fixture::new(ProviderAuthMode::ApiKey).await;

    let observed = fixture.observe(&[], None).await;

    assert_eq!(observed, ProviderObservation::OutOfScope);
    assert!(
        tokio::time::timeout(QUIET_WAIT, fixture.scripted.script.next_sent())
            .await
            .is_err(),
        "an API-key account's home was sent a request"
    );
    assert_eq!(fixture.reset_credits(), None);
}

// `auth.json` written into `codex_home` as Codex's `file` store writes it, its access token a
// made-up JWT whose payload claims only `exp`.
fn write_auth_file(codex_home: &std::path::Path, last_refresh: &str, access_token_expiry: i64) {
    let payload = URL_SAFE_NO_PAD.encode(json!({"exp": access_token_expiry}).to_string());
    let auth_file = json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": "e30.e30.c2ln",
            "access_token": format!("e30.{payload}.c2ln"),
            "refresh_token": "made-up",
            "account_id": "made-up",
        },
        "last_refresh": last_refresh,
    });
    std::fs::create_dir_all(codex_home).expect("the home is made");
    std::fs::write(codex_home.join("auth.json"), auth_file.to_string())
        .expect("the auth file is written");
}

// Killed by a refused read read as figures, by a lost sign-in read as a throttle or the reverse,
// by an unreadable account read taken as a verdict on the sign-in, and by a home with no
// `auth.json` counting a dead renewal (the second refusal would read as a lost sign-in).
#[rstest]
#[case::no_sign_in(json!({"result": {"account": null}}), ProviderObservation::SignInGone)]
#[case::a_throttle(
    json!({"result": {"account": {"type": "chatgpt"}}}),
    ProviderObservation::RefusedInBand
)]
#[case::an_unreadable_account(json!({"result": {}}), ProviderObservation::Unanswered)]
#[tokio::test]
async fn a_refused_read_is_judged_by_the_home_s_sign_in(
    #[case] account_read: Value,
    #[case] observation: ProviderObservation,
) {
    let mut fixture = Fixture::new(ProviderAuthMode::OauthSubscription).await;
    let answers = [refused_limits_read(), ("account/read", account_read)];

    let first = fixture.observe(&answers, None).await;
    let second = fixture.observe(&answers, None).await;

    assert_eq!((first, second), (observation, observation));
    assert!(lock(&fixture.recorded.0).is_empty());
}

/// An access token expiry long past.
const EXPIRED: i64 = 1_700_000_000;
/// An access token expiry long ahead.
const UNEXPIRED: i64 = 4_000_000_000;

// Killed by the count never reaching two, by an unexpired token counting, by the before-and-after
// comparison skipped, and by a file rewritten during the read not clearing the count.
#[rstest]
#[case::a_dead_renewal_twice(EXPIRED, None, ProviderObservation::SignInGone)]
#[case::a_renewal_written(
    EXPIRED,
    Some(("2026-10-29T19:00:00.5Z", EXPIRED)),
    ProviderObservation::RefusedInBand
)]
#[case::no_renewal_needed(UNEXPIRED, None, ProviderObservation::RefusedInBand)]
#[tokio::test]
async fn a_renewal_that_leaves_auth_json_unchanged_twice_reads_as_a_lost_sign_in(
    #[case] access_token_expiry: i64,
    #[case] second_read_renews: Option<(&str, i64)>,
    #[case] second: ProviderObservation,
) {
    let mut fixture = Fixture::new(ProviderAuthMode::OauthSubscription).await;
    write_auth_file(
        &fixture.folders.configuration_folder,
        "2026-10-29T18:00:00.123456Z",
        access_token_expiry,
    );
    let answers = [refused_limits_read(), signed_in_account_read()];

    let first = fixture.observe(&answers, None).await;
    let observed_second = fixture.observe(&answers, second_read_renews).await;

    assert_eq!(
        (first, observed_second),
        (ProviderObservation::RefusedInBand, second)
    );
}
