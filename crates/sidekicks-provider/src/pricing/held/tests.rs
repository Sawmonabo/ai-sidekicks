//! The held requests' repricing over a test database, the list's stand-in server and doubles of
//! the pricer, the usage record and the accounts reader.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use axum::http::StatusCode;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::armed_instant::InstantJob as _;
use sidekicks_std::scheduler::test_wall_clock::{TEST_CLOCK_START, TestWallClock};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::schema_parts;
use sidekicks_store::database::writer::test_file::test_envelope;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;
use sidekicks_store::events::test_log::{SessionTestLog, run_write_statements};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::{
    HELD_REQUEST_REPRICING_STATEMENT_CAPACITY, HeldRequestRepricing,
    HeldRequestRepricingDependencies,
};
use crate::account::usage_turns::tests::{
    EARLIER_START, Turn, append, instant, rebuild, recorded_with, turn_id,
};
use crate::account::usage_turns::unpriced::{UnpricedRequest, UnpricedUsageKey};
use crate::account::usage_turns::{
    mint_sessionless_turn_id, sessionless_usage_turn_statement, usage_turn_projection_statements,
};
use crate::driver::CurrentProviderAccount;
use crate::driver::contract::account::WindowTurnSpend;
use crate::driver::ports::{HeldRequest, RequestHeldListener as _};
use crate::driver::test_registry::TestProviderAccounts;
use crate::port::usage_sink::{
    MeteredUsage, PricedRequest, ProviderQuotaWindow, RecordedUsage, UsageSink,
};
use crate::pricing::list::PriceTable;
use crate::pricing::rule::{RequestPricer, RequestPricing};
use crate::pricing::store::HeldPriceList;
use crate::pricing::test_fixture::{ListServer, open_held, serve};
use crate::usage_delta_accountant::UsageAxisCounts;

// The tests' copy once it prices `late`, a model the built-in copy lacks.
const LATE_COPY: &[u8] = br#"{"m1": {"input_cost_per_token": 1e-06},
    "seed-only": {"input_cost_per_token": 2e-06}, "late": {"input_cost_per_token": 1e-06}}"#;
// The start the repricing runs as; a row a live append wrote under it is still being metered.
const THIS_START: &str = "2026-10-14T09:00:00.000Z";

type Failure = Box<dyn std::error::Error + Send + Sync>;
type BoxedAnswer<'a, T> = BoxFuture<'a, Result<T, Failure>>;

// A rule that prices a key whose model the table has, each row at its input tokens, and holds
// a request for the account's sign-in kind while none is known where it reads one.
struct TestPricer {
    needs_sign_in_kind: bool,
    priced: Mutex<Vec<(UnpricedUsageKey, UnpricedRequest)>>,
}

impl RequestPricer for TestPricer {
    fn needs_sign_in_kind(&self) -> bool {
        self.needs_sign_in_kind
    }

    fn prices_key(&self, table: &PriceTable, key: &UnpricedUsageKey) -> bool {
        key.model_id
            .as_ref()
            .is_some_and(|model_id| table.row(model_id.as_str()).is_some())
    }

    fn price(
        &self,
        _table: &PriceTable,
        key: &UnpricedUsageKey,
        request: &UnpricedRequest,
        sign_in_kind: Option<ProviderAuthMode>,
    ) -> RequestPricing {
        lock(&self.priced).push((key.clone(), request.clone()));
        if self.needs_sign_in_kind && sign_in_kind.is_none() {
            return RequestPricing::HeldForSignInKind;
        }
        RequestPricing::Priced {
            cost_source: UsageCostSource::DerivedExact,
            shares: request
                .rows
                .iter()
                .map(|row| UsdMicros(row.tokens[0].expect("the test's rows count input")))
                .collect(),
        }
    }
}

// The usage record's cost write: each request recorded, and its rows' figures set through the
// projection of the cost event it appends. No other usage double writes a cost.
struct CostRecord {
    writer: Arc<DatabaseWriter>,
    recorded: Mutex<Vec<PricedRequest>>,
}

impl UsageSink for CostRecord {
    fn record_metered(&self, _metered: MeteredUsage) -> BoxedAnswer<'_, Option<RecordedUsage>> {
        async { Err("the cost record meters nothing".into()) }.boxed()
    }

    fn record_cost(&self, request: PricedRequest) -> BoxedAnswer<'_, ()> {
        async move {
            let figures = request.rows.iter().map(|priced| {
                let event_id = priced.row.event_id.as_str();
                json!({"eventId": event_id, "costUsdMicros": priced.cost_usd_micros})
            });
            let event: SessionEvent = serde_json::from_value(json!({
                "type": "usage.cost.updated",
                "payload": {
                    "sessionId": request.session_id,
                    "costUsdMicros": request.rows.iter()
                        .map(|priced| i64::from(priced.cost_usd_micros.0)).sum::<i64>(),
                    "costSource": request.cost_source,
                    "pricedEvents": figures.collect::<Vec<_>>(),
                    "modelId": request.model_id.as_str(),
                },
            }))?;
            let envelope = test_envelope(request.session_id, &event);
            self.writer
                .write(usage_turn_projection_statements(
                    &envelope,
                    &instant(THIS_START),
                )?)
                .await?;
            lock(&self.recorded).push(request);
            Ok(())
        }
        .boxed()
    }

    fn record_quota_windows(
        &self,
        _provider: ProviderId,
        _provider_account_id: ProviderAccountId,
        _windows: Vec<ProviderQuotaWindow>,
    ) -> BoxedAnswer<'_, ()> {
        async { Err("the cost record keeps no window".into()) }.boxed()
    }

    fn record_whole_quota_windows(
        &self,
        _provider: ProviderId,
        _provider_account_id: ProviderAccountId,
        _windows: Vec<ProviderQuotaWindow>,
    ) -> BoxedAnswer<'_, ()> {
        async { Err("the cost record keeps no window".into()) }.boxed()
    }

    fn read_prior_emitted(
        &self,
        _session_id: SessionId,
        _thread_id: String,
    ) -> BoxedAnswer<'_, UsageAxisCounts> {
        async { Err("the cost record keeps no sum".into()) }.boxed()
    }
}

// A session log beside the accounts `account-a` of `table-rule` and `account-b` of
// `kind-rule`, the list's stand-in server, and the doubles a repricing is built on.
struct Bench {
    log: SessionTestLog,
    writer: Arc<DatabaseWriter>,
    server: Arc<ListServer>,
    price_list: Arc<HeldPriceList>,
    table_pricer: Arc<TestPricer>,
    kind_pricer: Arc<TestPricer>,
    costs: Arc<CostRecord>,
    accounts: Arc<TestProviderAccounts>,
    _scratch: TempDir,
}

impl Bench {
    async fn new() -> Self {
        let log = SessionTestLog::new(schema_parts());
        for (account, provider) in [("account-a", "table-rule"), ("account-b", "kind-rule")] {
            log.writer
                .execute(
                    "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
                       billing_mode, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'subscription', ?4, ?4)",
                    params![
                        account,
                        provider,
                        format!("/homes/{account}"),
                        EARLIER_START
                    ],
                )
                .expect("the test registers its account");
        }
        let writer = Arc::new(
            DatabaseWriter::open(log.database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let scratch = tempfile::tempdir().expect("a scratch folder is made");
        let server = Arc::new(ListServer::default());
        let clock = Arc::new(TestWallClock::default());
        let price_list = open_held(
            &scratch.path().join("price-list"),
            serve(&server).await,
            &clock,
        )
        .await;
        let pricer = |needs_sign_in_kind| {
            Arc::new(TestPricer {
                needs_sign_in_kind,
                priced: Mutex::default(),
            })
        };
        Self {
            costs: Arc::new(CostRecord {
                writer: Arc::clone(&writer),
                recorded: Mutex::default(),
            }),
            log,
            writer,
            server,
            price_list,
            table_pricer: pricer(false),
            kind_pricer: pricer(true),
            accounts: Arc::new(TestProviderAccounts::new(
                CurrentProviderAccount::NoneRegistered,
            )),
            _scratch: scratch,
        }
    }

    // A repricing over the bench, as the daemon started at `THIS_START` builds one.
    fn repricing(&self) -> Arc<HeldRequestRepricing> {
        let pricers: HashMap<ProviderId, Arc<dyn RequestPricer>> = HashMap::from([
            (provider("table-rule"), Arc::clone(&self.table_pricer) as _),
            (provider("kind-rule"), Arc::clone(&self.kind_pricer) as _),
        ]);
        HeldRequestRepricing::new(HeldRequestRepricingDependencies {
            reads: Arc::new(DatabaseReadPool::new(
                self.log.database.path(),
                HELD_REQUEST_REPRICING_STATEMENT_CAPACITY,
            )),
            writer: Arc::clone(&self.writer),
            price_list: Arc::clone(&self.price_list),
            provider_accounts: Arc::clone(&self.accounts) as _,
            usage: Arc::clone(&self.costs) as _,
            pricers,
            daemon_started_at: instant(THIS_START),
        })
    }

    // Writes one token row on `account` and `model` with `members` besides, appended under the
    // daemon started at `daemon_started_at`.
    fn token_row(
        &self,
        account: &str,
        model: &str,
        daemon_started_at: &str,
        members: &serde_json::Value,
    ) -> UnsequencedEventEnvelope {
        let envelope = recorded_with(
            &self.log,
            &Turn {
                account,
                generation: 1,
                model,
                subagent: None,
                counts: [10, 2, 0, 0, 0],
            },
            members,
        );
        append(
            &self.log,
            daemon_started_at,
            std::slice::from_ref(&envelope),
        );
        envelope
    }

    // Writes a window-start turn of `model` on `account-a` under this start, held, and answers its
    // row's id.
    fn sessionless_row(&self, model: &str) -> FreeFormText<EVENT_FIELD_MAX_LEN> {
        let turn_id = mint_sessionless_turn_id();
        let spend = WindowTurnSpend {
            model_id: Some(FreeFormText::new(model.to_owned()).expect("a model id")),
            input_tokens: SafeInt::new(7),
            output_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            reasoning_tokens: None,
        };
        run_write_statements(
            &self.log.writer,
            &[sessionless_usage_turn_statement(
                &turn_id,
                &account("account-a"),
                &instant(THIS_START),
                &instant(THIS_START),
                &spend,
            )],
        );
        turn_id
    }

    // Each row's turn id and figure, by turn id.
    fn figures(&self) -> HashMap<String, Option<i64>> {
        let reader = self.log.reader();
        let mut statement = reader
            .prepare("SELECT turn_id, cost_usd_micros FROM provider_account_usage_turns")
            .expect("the read prepares");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("the rows read")
            .collect::<rusqlite::Result<_>>()
            .expect("each row reads")
    }

    // The event ids of each request recorded so far, in order, each request's sorted.
    fn recorded(&self) -> Vec<Vec<String>> {
        lock(&self.costs.recorded)
            .iter()
            .map(|request| {
                sorted(
                    request
                        .rows
                        .iter()
                        .map(|priced| priced.row.event_id.as_str().to_owned()),
                )
            })
            .collect()
    }

    // Starts the list's fetch task with `copy` scripted and waits for the copy it takes. On the
    // test's one thread the task arms its next fetch before it yields, so the arm is read after.
    async fn take_copy(&self, copy: &'static [u8], stop: &CancellationToken) {
        let mut table_watch = self.price_list.subscribe();
        self.server
            .script(StatusCode::OK, Some(r#"W/"late""#), copy);
        drop(self.price_list.start(stop.clone()));
        table_watch
            .changed()
            .await
            .expect("the list sends the copy it took");
    }
}

fn provider(id: &str) -> ProviderId {
    ProviderId::new(id.to_owned()).expect("a provider id")
}

fn account(id: &str) -> ProviderAccountId {
    ProviderAccountId::new(id.to_owned()).expect("an account id")
}

fn late_key() -> UnpricedUsageKey {
    UnpricedUsageKey {
        provider: provider("table-rule"),
        account_id: account("account-a"),
        model_id: Some(FreeFormText::new("late".to_owned()).expect("a model id")),
        speed: None,
        processing_region: None,
    }
}

fn sorted(texts: impl Iterator<Item = String>) -> Vec<String> {
    let mut texts: Vec<String> = texts.collect();
    texts.sort();
    texts
}

// Fails when a copy that adds a held key's model prices nothing or a later copy prices it
// again (repricing per fetch); when the start reads the rows of a key the held copy lacks;
// when a request held for its account's sign-in kind counts as waiting on a price, so the list
// fetches hourly, or reports a miss, so it fetches again (a miss on a kind); and when the
// account's change to a known kind prices nothing, or a second change prices it again (no
// reprice on the kind).
#[tokio::test]
async fn held_requests_are_priced_once_by_the_copy_or_the_kind_they_wait_on() {
    let bench = Bench::new().await;
    let late = [
        bench.token_row(
            "account-a",
            "late",
            EARLIER_START,
            &json!({"requestKey": "msg-1"}),
        ),
        bench.token_row(
            "account-a",
            "late",
            EARLIER_START,
            &json!({"requestKey": "msg-1"}),
        ),
    ];
    bench.sessionless_row("late");
    let kind_held = bench.token_row("account-b", "m1", EARLIER_START, &json!({}));
    let repricing = bench.repricing();
    let stop = CancellationToken::new();

    repricing.start_pass().await;
    assert_eq!(bench.recorded(), Vec::<Vec<String>>::new());
    assert!(
        lock(&bench.table_pricer.priced).is_empty(),
        "no late row is read"
    );
    bench.take_copy(LATE_COPY, &stop).await;
    repricing.run_queued(true).await;

    assert_eq!(bench.recorded(), [sorted(late.iter().map(turn_id))]);
    let figures = bench.figures();
    assert_eq!(
        figures.values().filter(|figure| figure.is_none()).count(),
        1
    );
    assert_eq!(figures[&turn_id(&kind_held)], None);
    assert_eq!(
        bench.price_list.armed_instant().instant(),
        Some(SystemTime::UNIX_EPOCH + TEST_CLOCK_START + Duration::from_hours(24))
    );
    repricing.run_queued(true).await;
    assert_eq!(bench.recorded().len(), 1);

    bench
        .accounts
        .set_sign_in_kind(Some(ProviderAuthMode::ApiKey));
    repricing.account_changed(&account("account-b"));
    repricing.run_queued(false).await;
    assert_eq!(bench.recorded()[1], [turn_id(&kind_held)]);
    repricing.account_changed(&account("account-b"));
    repricing.run_queued(false).await;
    assert_eq!(bench.recorded().len(), 2);
    assert!(bench.figures().values().all(Option::is_some));
    assert_eq!(bench.server.if_none_match().len(), 1);
    stop.cancel();
}

// Fails when a pass reads a row this start's live append wrote that nobody handed over, so a
// request the live path is still metering is priced; when it skips a row another start wrote or
// a rebuild wrote with no start; when a hand-off never prices its request; or when a window-start
// row written after the start waits for the next start although its key prices.
#[tokio::test]
async fn a_request_still_being_metered_is_priced_only_once_handed_over() {
    let bench = Bench::new().await;
    // Cleared and written again by a rebuild, which writes no start.
    let rebuilt = bench.token_row("account-a", "late", THIS_START, &json!({}));
    rebuild(&bench.log, std::slice::from_ref(&rebuilt));
    let other_start = bench.token_row("account-a", "late", EARLIER_START, &json!({}));
    let handed_over = bench.token_row("account-a", "late", THIS_START, &json!({}));
    let metering = bench.token_row("account-a", "late", THIS_START, &json!({}));
    let repricing = bench.repricing();
    let stop = CancellationToken::new();
    let hand_over = |envelope: &UnsequencedEventEnvelope| HeldRequest {
        key: late_key(),
        row_ids: vec![envelope.id.clone()],
    };

    repricing.start_pass().await;
    repricing
        .request_held(hand_over(&handed_over))
        .await
        .expect("the hand-off marks its rows");
    repricing.run_queued(false).await;
    assert_eq!(bench.recorded(), Vec::<Vec<String>>::new());
    bench.take_copy(LATE_COPY, &stop).await;
    repricing.run_queued(true).await;

    assert_eq!(
        sorted(bench.recorded().concat().into_iter()),
        sorted(
            [&rebuilt, &other_start, &handed_over]
                .into_iter()
                .map(turn_id)
        )
    );
    repricing
        .request_held(hand_over(&metering))
        .await
        .expect("the hand-off marks its rows");
    repricing.run_queued(false).await;
    repricing.run_queued(true).await;
    assert_eq!(bench.recorded().concat().len(), 4);
    assert_eq!(bench.recorded()[3], [turn_id(&metering)]);

    let window_start = bench.sessionless_row("m1");
    repricing
        .request_held(HeldRequest {
            key: UnpricedUsageKey {
                model_id: Some(FreeFormText::new("m1".to_owned()).expect("a model id")),
                ..late_key()
            },
            // As the observer hands it over: written held, so nothing to mark.
            row_ids: Vec::new(),
        })
        .await
        .expect("the hand-off queues its key");
    repricing.run_queued(false).await;
    assert_eq!(bench.figures()[window_start.as_str()], Some(7));
    stop.cancel();
}

// Fails when a removed account's key keeps waiting, in the map of keys held for a price, which
// keeps the list fetching hourly, or in the map of accounts held for their sign-in kind. The
// copy taken does not price the key held for a price, so only the removal lets it go.
#[tokio::test]
async fn a_removed_accounts_keys_leave_both_waits_and_the_fetch_returns_to_daily() {
    let bench = Bench::new().await;
    bench.token_row("account-b", "unlisted", EARLIER_START, &json!({}));
    bench.token_row("account-b", "m1", EARLIER_START, &json!({}));
    let repricing = bench.repricing();
    let stop = CancellationToken::new();

    repricing.start_pass().await;
    {
        let held_keys = lock(&repricing.held_keys);
        assert_eq!(
            (held_keys.price_held.len(), held_keys.kind_held.len()),
            (1, 1)
        );
    }
    bench.accounts.remove_accounts();
    repricing.account_changed(&account("account-b"));
    bench.take_copy(LATE_COPY, &stop).await;
    repricing.run_queued(true).await;

    let held_keys = lock(&repricing.held_keys);
    assert!(held_keys.price_held.is_empty());
    assert!(held_keys.kind_held.is_empty());
    drop(held_keys);
    assert_eq!(
        bench.price_list.armed_instant().instant(),
        Some(SystemTime::UNIX_EPOCH + TEST_CLOCK_START + Duration::from_hours(24))
    );
    assert_eq!(bench.recorded(), Vec::<Vec<String>>::new());
    stop.cancel();
}

// Fails when the running task does not price a key held for a price on a copy taken while it
// runs.
#[tokio::test]
async fn the_running_task_prices_a_held_key_on_a_copy_taken_beside_a_wake() {
    let bench = Bench::new().await;
    let late = bench.token_row("account-a", "late", EARLIER_START, &json!({}));
    let repricing = bench.repricing();
    let stop = CancellationToken::new();
    let task = repricing.start(stop.clone());

    repricing.account_changed(&account("account-a"));
    bench.take_copy(LATE_COPY, &stop).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while bench.recorded().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the copy prices the held key");

    assert_eq!(bench.recorded(), [[turn_id(&late)]]);
    stop.cancel();
    task.await.expect("the task ends at the stop");
}
