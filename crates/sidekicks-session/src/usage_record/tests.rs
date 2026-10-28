use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::params;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::orchestration::OrchestrationRunConfig;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, ChildRunProvenance, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::run::subagent::{SubagentId, SubagentLifecyclePayload};
use sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload;
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::registry::test_provider;
use sidekicks_provider::driver::test_registry::new_run_id;
use sidekicks_provider::port::run_state_publisher::RunStatePublisher;
use sidekicks_provider::port::usage_sink::{MeteredUsage, UsageSink};
use sidekicks_provider::usage_delta_accountant::{
    MeteredUsageDelta, UsageAxisCounts, UsageContainment, UsageDiagnosticBand,
};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::open_log;
use tempfile::TempDir;

use super::{USAGE_RECORD_STATEMENT_CAPACITY, UsageRecord, UsageRecordError};
use crate::questions::schema::schema_parts;
use crate::run::engine::test_fixture::{append, insert_running_run, test_choices, test_engine};
use crate::run::engine::{RunEngine, RunEngineError};
use crate::run::epochs::{EpochBinding, ExecutionEpochs};
use crate::run::inbound::{InboundDispatchError, RunInboundDispatch};
use crate::run::limit_interrupter::{HandedCut, LimitInterruptFailure, LimitInterrupter};

const ACCOUNT: &str = "account-1";

// A run-state stream no one reads.
struct UnreadRunStates;

impl RunStatePublisher for UnreadRunStates {
    fn publish(&self, _hold: RunSafetyBufferingUpdatedPayload) {}
}

// An interventions service that takes every limit's interrupt and counts them.
#[derive(Default)]
struct CountedInterrupts {
    calls: AtomicUsize,
}

impl LimitInterrupter for CountedInterrupts {
    fn interrupt_for_limit(
        &self,
        _run_id: RunId,
        _limit: RunLimit,
        _cut: Option<HandedCut>,
    ) -> BoxFuture<'_, Result<(), LimitInterruptFailure>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }
}

// A lead run on a binding of the account, its cursor open, recording through a usage record.
struct Harness {
    database: TestDatabase,
    _home: TempDir,
    session_id: SessionId,
    lead_run_id: RunId,
    binding_id: RuntimeBindingId,
    engine: Arc<RunEngine>,
    interrupts: Arc<CountedInterrupts>,
    record: UsageRecord,
}

impl Harness {
    // The lead run admitted with `token_limit`, its account registered at generation 1, and its
    // binding's cursor open unless `is_cursor_open` is false.
    async fn new(token_limit: Option<u64>, is_cursor_open: bool) -> Self {
        let database = TestDatabase::new(schema_parts());
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let log = open_log(&database, None).await;
        let engine = test_engine(&database, Arc::clone(&log.service), home.path());
        let interrupts = Arc::new(CountedInterrupts::default());
        let handed: Weak<CountedInterrupts> = Arc::downgrade(&interrupts);
        assert!(engine.set_limit_interrupter(handed).is_ok());
        let session_id = test_session_id();
        let lead_run_id = new_run_id();
        insert_running_run(&database, session_id, lead_run_id);
        append(
            &engine,
            session_id,
            &queued(session_id, lead_run_id, None, token_limit),
        )
        .await;
        let binding_id =
            RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a UUID is a binding id");
        let connection = database.reader();
        connection
            .execute(
                "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
                   billing_mode, created_at, updated_at)
                 VALUES (?1, ?2, '/accounts/1', 'unknown', '2026-10-01T00:00:00Z',
                   '2026-10-01T00:00:00Z')",
                params![ACCOUNT, test_provider().as_str()],
            )
            .expect("the test registers the account");
        connection
            .execute(
                "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
                   cli_version_raw, spawn_config, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '1.0.0', '1.0.0', ?4, '', '')",
                params![
                    binding_id.as_str(),
                    lead_run_id.text().as_str(),
                    test_provider().as_str(),
                    format!(r#"{{"providerAccountId":"{ACCOUNT}"}}"#),
                ],
            )
            .expect("the test binds the lead run");
        let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(2).expect("the cap is not zero"),
        )));
        if is_cursor_open {
            epochs
                .lock()
                .expect("no test thread panics holding the cursors")
                .open_binding(
                    EpochBinding {
                        id: binding_id.clone(),
                        run_id: lead_run_id,
                        provider_name: test_provider(),
                        provider_account_id: account(),
                    },
                    RUN_START_POSITION,
                )
                .expect("the binding has no cursor yet");
        }
        let dispatch = Arc::new(RunInboundDispatch::new(
            Arc::clone(&engine),
            epochs,
            Arc::new(UnreadRunStates),
            log.service,
            test_choices(&database, &engine),
        ));
        let record = UsageRecord::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                USAGE_RECORD_STATEMENT_CAPACITY,
            )),
            database.path(),
            dispatch,
            Arc::clone(&engine),
        );
        Self {
            database,
            _home: home,
            session_id,
            lead_run_id,
            binding_id,
            engine,
            interrupts,
            record,
        }
    }

    // A helper's run beneath the lead, queued and then started as a driver writes them.
    async fn start_helper(&self, subagent_id: &SubagentId) -> RunId {
        let helper_run_id = new_run_id();
        self.database
            .reader()
            .execute(
                "INSERT INTO runs (run_id, session_id, parent_run_id, reached_by, state,
                   run_version)
                 VALUES (?1, ?2, ?3, ?4, 'running', 1)",
                params![
                    helper_run_id.text().as_str(),
                    self.session_id.text().as_str(),
                    self.lead_run_id.text().as_str(),
                    <&'static str>::from(ChildRunProvenance::ProviderSubagent),
                ],
            )
            .expect("the test writes the helper's run");
        append(
            &self.engine,
            self.session_id,
            &queued(self.session_id, helper_run_id, Some(self.lead_run_id), None),
        )
        .await;
        append(
            &self.engine,
            self.session_id,
            &SessionEvent::AgentSubagentStarted(SubagentLifecyclePayload {
                session_id: self.session_id,
                run_id: self.lead_run_id,
                provider: test_provider(),
                subagent_id: subagent_id.clone(),
                parent_tool_call_id: None,
                source_epoch: None,
                source_position: None,
            }),
        )
        .await;
        helper_run_id
    }

    // Records a reading of `input`, `output` and `cache_read` tokens on the lead's binding,
    // attributed to `subagent_id`'s helper where one is named.
    async fn record(
        &self,
        subagent_id: Option<&SubagentId>,
        input: u64,
        output: u64,
        cache_read: u64,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.record
            .record_metered(MeteredUsage {
                session_id: self.session_id,
                binding_id: self.binding_id.clone(),
                subagent_id: subagent_id.cloned(),
                delta: MeteredUsageDelta {
                    provider: test_provider(),
                    thread_id: "thread-1".to_owned(),
                    attributed_turn_id: None,
                    axis_deltas: UsageAxisCounts {
                        input: Some(input + cache_read),
                        cached_input: Some(cache_read),
                        output: Some(output),
                        ..UsageAxisCounts::default()
                    },
                    normalized_input_tokens: input,
                    normalized_output_tokens: output,
                    containment: UsageContainment::ConfirmedSubtracted,
                    diagnostic_band: UsageDiagnosticBand {
                        cache_read_tokens_delta: cache_read,
                        cache_write_tokens_delta: 0,
                    },
                },
            })
            .await
    }

    // Each stored event of `event_type`, its run and its payload member `member` as text.
    fn stored(&self, event_type: &str, member: &str) -> Vec<(Option<String>, Option<String>)> {
        self.database
            .reader()
            .prepare(
                "SELECT run_id, CAST(json_extract(payload, '$.' || ?2) AS TEXT) FROM session_events
                 WHERE session_id = ?1 AND type = ?3 ORDER BY sequence",
            )
            .expect("the test reads the session's events")
            .query_map(
                params![self.session_id.text().as_str(), member, event_type],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the events read")
            .collect::<Result<_, _>>()
            .expect("each event reads")
    }
}

fn account() -> ProviderAccountId {
    ProviderAccountId::new(ACCOUNT.to_owned()).expect("the test's account id is one")
}

// `run_id`'s `agent.run.queued`, beneath `parent_run_id` as a provider subagent where one is
// named, admitted with `token_limit`.
fn queued(
    session_id: SessionId,
    run_id: RunId,
    parent_run_id: Option<RunId>,
    token_limit: Option<u64>,
) -> SessionEvent {
    SessionEvent::AgentRunQueued(AgentRunQueuedPayload::SessionAgent(
        RunQueuedSessionAgentPayload {
            session_id,
            run_id,
            run_version: SafeInt::ZERO,
            new_state: AgentRunQueuedNewState::Value,
            agent_id: AgentId::try_from(mint_uuid_v7()).expect("a minted UUID is an agent id"),
            resolved_agent: None,
            parent_run_id,
            reached_by: parent_run_id.map(|_| ChildRunProvenance::ProviderSubagent),
            is_apart: None,
            effective_run_config: token_limit.map(|limit| OrchestrationRunConfig {
                token_limit: Some(TokensPerRun(
                    SafeInt::new(limit).expect("the test's limit is a safe integer"),
                )),
            }),
            admitted_model_family: None,
            admitted_provider_account_id: account(),
        },
    ))
}

const RECORDED: &str = "usage.tokenCount.recorded";
const REACHED: &str = "agent.run.tokenLimit.reached";

// Killed by a generation read once and kept: the second row would carry the first generation.
#[tokio::test]
async fn each_row_carries_the_generation_the_account_holds_at_its_write() {
    let harness = Harness::new(None, true).await;
    harness
        .record(None, 10, 5, 0)
        .await
        .expect("the first reading is recorded");
    harness
        .database
        .reader()
        .execute(
            "UPDATE provider_accounts SET credential_generation = 2 WHERE account_id = ?1",
            [ACCOUNT],
        )
        .expect("the test signs the account in again");
    harness
        .record(None, 10, 5, 0)
        .await
        .expect("the second reading is recorded");

    let lead = Some(harness.lead_run_id.text().as_str().to_owned());
    assert_eq!(
        harness.stored(RECORDED, "credentialGeneration"),
        vec![
            (lead.clone(), Some("1".to_owned())),
            (lead, Some("2".to_owned()))
        ]
    );
}

// Killed by a dispatch failure logged and dropped: the reading would answer recorded.
#[tokio::test]
async fn a_row_the_dispatch_does_not_write_fails_the_record() {
    let harness = Harness::new(None, false).await;

    let failure = harness
        .record(None, 10, 5, 0)
        .await
        .expect_err("a binding with no cursor open writes no row");

    assert!(matches!(
        failure.downcast_ref::<UsageRecordError>(),
        Some(UsageRecordError::Dispatch(InboundDispatchError::Cursor(_)))
    ));
    assert!(harness.stored(RECORDED, "inputTokens").is_empty());
}

// Killed by counting cache reads (the lead's first reading would pass its limit), by recording or
// counting a helper's rows on its lead (the rows' runs, and the lead stopping at the helper's
// reading), by a second reached event on a run past its limit, and by interrupting a helper (an
// interrupt would be handed for it).
#[tokio::test]
async fn a_run_stops_once_past_its_own_count_and_a_helper_stops_alone() {
    let harness = Harness::new(Some(100), true).await;
    let subagent_id = SubagentId::new("helper-1".to_owned()).expect("a helper id");
    let helper_run_id = harness.start_helper(&subagent_id).await;
    let lead = Some(harness.lead_run_id.text().as_str().to_owned());
    let helper = Some(helper_run_id.text().as_str().to_owned());

    // 60 input and output against the lead's 100; the cache read never counts.
    harness
        .record(None, 40, 20, 5_000)
        .await
        .expect("the lead's reading is recorded");
    // The helper's 90 is its own run's, under the 100 it shares with its lead's admission.
    harness
        .record(Some(&subagent_id), 60, 30, 0)
        .await
        .expect("the helper's first reading is recorded");
    assert_eq!(
        harness.stored(RECORDED, "subagentId"),
        vec![
            (lead.clone(), None),
            (helper.clone(), Some(subagent_id.as_str().to_owned()))
        ]
    );
    assert!(harness.stored(REACHED, "runId").is_empty());
    assert_eq!(harness.interrupts.calls.load(Ordering::SeqCst), 0);

    // The helper's 120 passes its limit: its reached event, no interrupt, and its driver asked,
    // which the test's registry does not hold.
    let failure = harness
        .record(Some(&subagent_id), 20, 10, 0)
        .await
        .expect_err("the test's registry holds no driver to stop the helper");
    assert!(matches!(
        failure.downcast_ref::<UsageRecordError>(),
        Some(UsageRecordError::Stop(RunEngineError::Provider(_)))
    ));
    assert_eq!(
        harness.stored(REACHED, "runId"),
        vec![(helper.clone(), helper.clone())]
    );
    assert_eq!(harness.interrupts.calls.load(Ordering::SeqCst), 0);

    // The lead's 130 passes its own limit, twice: one reached event, its interrupt handed.
    for _ in 0..2 {
        harness
            .record(None, 50, 20, 0)
            .await
            .expect("the lead's reading is recorded and its run stopped");
    }
    assert_eq!(
        harness.stored(REACHED, "runId"),
        vec![(helper.clone(), helper), (lead.clone(), lead)]
    );
    assert!(harness.interrupts.calls.load(Ordering::SeqCst) >= 1);
}
