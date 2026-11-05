//! The runs a session's resume named, settled as the provider answered for each before the resumed
//! binding is recorded. For each lead run the answer names that is still live, the session's
//! waiting messages are first looked up by their ids in the provider's own record of the run's
//! conversation, since after a restart nothing remembers which were handed: one it holds is
//! admitted into the run, so no hand sends it again, one it lacks waits for the queue's own hand
//! under the same id, and an unreadable record has the run finalized as gone with the messages
//! still waiting for it ended not delivered in the same write, or in one of their own where the
//! finalize leaves the run as it is. Each named run still live is finalized from the state it was
//! stored in before the restart, and one its provider runs on has each of its pending interrupts
//! handed again, a person's or a limit's, so a stop asked before the restart still reaches its
//! turn; a live run the answer leaves out is left to the restart settle. A run the resume's
//! continue carries on from a wait whose asks are all answered is moved to running before its runs
//! are taken.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemState};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::run_control::{FindTakenMessagesParams, TakenMessages};
use sidekicks_provider::driver::session_control::ProviderTurnAnswer;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_queue::delivery::{DeliveryError, QueueDelivery};
use sidekicks_queue::provider_session::resumed_runs::{ResumedRuns, ResumedRunsIngress};
use sidekicks_session::driver_resolution::{LiveRunDriverError, read_run_driver};
use sidekicks_session::interventions::service::InterventionService;
use sidekicks_session::queue_store::{QueueItemReader, QueueItemRecord};
use sidekicks_session::run::engine::RunEngine;
use sidekicks_session::run::engine::errors::RunEngineError;
use sidekicks_session::run::read::RunStateReader;
use sidekicks_session::run::refusals::RunRefusal;
use sidekicks_session::run::restart::ResumedRunMove;
use sidekicks_session::run::state_change::{RunStateChange, RunWriteCompanions};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

/// The statements the finalize's own reads run: the one-session listing of its live runs, the
/// session's waiting messages and a run's provider binding.
pub const RESUMED_RUNS_STATEMENT_CAPACITY: usize = 3;

/// What the resumed runs' finalize reads, writes and calls through.
pub struct ResumedRunsFinalizeDeps {
    /// The reads of the session's live runs, its waiting messages and each run's provider.
    pub reads: Arc<DatabaseReadPool>,
    /// The finalize of each run.
    pub run_engine: Arc<RunEngine>,
    /// The queue's delivery, which admits a message a run's provider took and reads the ends of
    /// those whose record could not be read.
    pub delivery: QueueDelivery,
    /// The drivers, found by the provider each run is bound to.
    pub providers: Arc<ProviderRegistry>,
    /// The interventions service, which hands a pending interrupt again, a person's or a limit's,
    /// to a run its provider runs on.
    pub interventions: Arc<InterventionService>,
}

// The turn a lead run is finalized from and, where its record was unreadable, the messages still
// waiting for it with the companions that end them not delivered.
type SentSettle = (
    ProviderTurnAnswer,
    Option<(Vec<QueueItemRecord>, RunWriteCompanions)>,
);

/// Finalizes each run a session's resume named as the provider answered for it.
pub struct ResumedRunsFinalize {
    deps: ResumedRunsFinalizeDeps,
}

/// Why the runs a resume named were not all settled; what was settled before is kept.
#[derive(Debug, thiserror::Error)]
pub enum ResumedRunsFinalizeError {
    /// SQLite refused a read of the session's live runs, its waiting messages or a run's
    /// provider.
    #[error("the session's runs or waiting messages could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run a read of the session's live runs, its waiting messages or a
    /// run's provider.
    #[error("the session's runs or waiting messages could not be read")]
    Pool(#[from] DatabaseReadError),
    /// A lead run's driver was not found, so its provider's record could not be asked.
    #[error("the driver of a run the resume named could not be found")]
    Driver(#[from] LiveRunDriverError),
    /// A waiting message's admission or end was not recorded.
    #[error("a waiting message's outcome after the resume was not recorded")]
    Delivery(#[from] DeliveryError),
    /// A run could not be finalized.
    #[error("a run the resume named could not be finalized")]
    Run(#[from] RunEngineError),
}

impl ResumedRunsFinalize {
    /// A finalize over `deps`.
    pub fn new(deps: ResumedRunsFinalizeDeps) -> Self {
        Self { deps }
    }

    /// Settles each run of `resumed` the session still holds live, in the answer's order: a lead
    /// run that has started has the session's waiting messages settled against its provider's
    /// record first, whatever the answer, then every named run is finalized from the state it is
    /// stored in, which nothing moves before the resumed binding is recorded, and the provider's
    /// answer for it, or as gone where its record could not be read, the messages still waiting for
    /// it then ended not delivered in the finalize's write, or in one of their own where the
    /// finalize's write did not land, and one the finalize leaves running has its pending
    /// interrupts, a person's or a limit's, handed again on a task of their own; a named run that
    /// has ended is skipped. Writes take the session's append hold themselves, since the caller
    /// holds only its transition lock. Fails at the first read, driver lookup, record or finalize
    /// that fails.
    pub async fn finalize(&self, resumed: ResumedRuns) -> Result<(), ResumedRunsFinalizeError> {
        let session_id = resumed.session_id;
        let live_runs = self
            .deps
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ResumedRunsFinalizeError>(
                    RunStateReader::new(reader).list_live_runs(Some(&session_id))?,
                )
            })
            .await?;
        for answer in resumed.runs {
            let Some(live_run) = live_runs.iter().find(|live| live.run_id == answer.run_id) else {
                continue;
            };
            // A run still queued never ran a conversation, so no message went into it.
            let (turn, unread) = if live_run.is_lead() && live_run.run.state != RunState::Queued {
                self.settle_sent(session_id, live_run.run_id, answer.turn)
                    .await?
            } else {
                (answer.turn, None)
            };
            let (unread_items, companions) = unread.unwrap_or_default();
            let finalized = self
                .deps
                .run_engine
                .finalize_resumed_run(live_run, live_run.run.state, turn, companions, None)
                .await?;
            if !unread_items.is_empty() {
                if finalized.is_written {
                    // The finalize's write carried their ends.
                    self.deps.delivery.settle_ended(&unread_items);
                } else {
                    self.deps
                        .delivery
                        .fail_unread_after_restart(&unread_items)
                        .await?;
                }
            }
            if finalized.resumed_move == ResumedRunMove::Running {
                self.deps
                    .interventions
                    .hand_pending_interrupts_again(live_run.run_id);
            }
        }
        Ok(())
    }

    // Looks the session's waiting messages up by their ids in the record of lead run `run_id`'s
    // conversation, admitting each it holds into the run; answers the turn the run is finalized
    // from: `answered`, or gone where the record is unreadable, since what the provider holds is
    // unknown, beside the messages still waiting for the run and the companions that end them not
    // delivered in its write. A read with no answer back leaves both.
    async fn settle_sent(
        &self,
        session_id: SessionId,
        run_id: RunId,
        answered: ProviderTurnAnswer,
    ) -> Result<SentSettle, ResumedRunsFinalizeError> {
        let message_ids = self.read_waiting_messages(session_id).await?;
        if message_ids.is_empty() {
            return Ok((answered, None));
        }
        let driver = read_run_driver::<ResumedRunsFinalizeError>(
            &self.deps.reads,
            &self.deps.providers,
            run_id,
        )
        .await?;
        let found = driver
            .find_taken_messages(FindTakenMessagesParams {
                session_id,
                run_id,
                message_ids: message_ids.clone(),
            })
            .await;
        match found {
            Ok(TakenMessages { taken }) => {
                self.deps
                    .delivery
                    .admit_taken_after_restart(run_id, &taken)
                    .await?;
                Ok((answered, None))
            }
            Err(unanswered @ DriverError::Unanswered(_)) => {
                tracing::warn!(
                    session_id = %session_id,
                    run_id = %run_id,
                    error = &unanswered as &(dyn Error + 'static),
                    "the provider's record of a resumed run gave no answer; its waiting messages \
                     go again under their own ids"
                );
                Ok((answered, None))
            }
            Err(unreadable) => {
                tracing::warn!(
                    session_id = %session_id,
                    run_id = %run_id,
                    error = &unreadable as &(dyn Error + 'static),
                    "the provider's record of a resumed run could not be read; its waiting \
                     messages end not delivered and the run ends"
                );
                let unread = self.deps.delivery.read_unread_ends(run_id).await?;
                Ok((ProviderTurnAnswer::Gone, Some(unread)))
            }
        }
    }

    // The ids of the session's lead messages still waiting, in the queue's order.
    async fn read_waiting_messages(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<QueueItemId>, ResumedRunsFinalizeError> {
        self.deps
            .reads
            .read(ReadLength::Short, move |reader| {
                let waiting = QueueItemReader::new(reader).list(
                    &session_id,
                    None,
                    Some(QueueItemState::Queued),
                )?;
                Ok::<_, ResumedRunsFinalizeError>(waiting_message_ids(waiting))
            })
            .await
    }
}

/// The ids of the messages among `waiting`, in its order: the only items a provider's record of a
/// conversation can hold, since a review is never handed.
pub(crate) fn waiting_message_ids(waiting: Vec<QueueItemRecord>) -> Vec<QueueItemId> {
    waiting
        .into_iter()
        .filter(|item| item.body.as_message().is_some())
        .map(|item| item.id)
        .collect()
}

impl ResumedRunsIngress for ResumedRunsFinalize {
    fn take_resumed_runs(
        &self,
        resumed: ResumedRuns,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move { self.finalize(resumed).await.map_err(Into::into) }.boxed()
    }

    fn continue_answered_runs(
        &self,
        runs: Vec<(RunId, RunState)>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            for (run_id, waiting) in runs {
                let moved = self
                    .deps
                    .run_engine
                    .transition(
                        RunStateChange {
                            expected_state: Some(waiting),
                            ..RunStateChange::new(
                                run_id,
                                RunStateEntry::Running {
                                    execution_posture: None,
                                },
                            )
                        },
                        RunWriteCompanions::default(),
                    )
                    .await;
                match moved {
                    // A run that moved since is left as it now is.
                    Ok(_) | Err(RunEngineError::Refused(RunRefusal::InvalidTransition { .. })) => {}
                    Err(failure) => return Err(failure.into()),
                }
            }
            Ok(())
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use futures::FutureExt as _;
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::approval::ApprovalRequestId;
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::contract::error::DriverError;
    use sidekicks_provider::driver::error_causes::session_process_unavailable;
    use sidekicks_provider::driver::message_handing::{HandMoment, MessageHanding};
    use sidekicks_provider::driver::run_control::{
        ApplyInterventionParams, ApplyInterventionResponse, InterventionResultStatus, TakenMessages,
    };
    use sidekicks_provider::driver::session_control::{ProviderTurnAnswer, ResumedRunAnswer};
    use sidekicks_provider::driver::test_registry::{
        bind_run_to_first_provider, registry_of_first_provider,
    };
    use sidekicks_queue::delivery::QueueDelivery;
    use sidekicks_queue::delivery::test_fixture::{hand_waiting_messages, test_delivery};
    use sidekicks_queue::provider_session::ProviderSessions;
    use sidekicks_queue::provider_session::resumed_runs::ResumedRuns;
    use sidekicks_queue::provider_session::test_opening::{
        OrphanedAnswersStandIn, test_provider_sessions,
    };
    use sidekicks_session::interventions::service::INTERVENTION_SERVICE_STATEMENT_CAPACITY;
    use sidekicks_session::interventions::service::test_fixture::test_intervention_service;
    use sidekicks_session::questions::schema::schema_parts;
    use sidekicks_session::queue_store::{QueueItemReader, RecordedQueueItemState};
    use sidekicks_session::run::engine::test_fixture::{
        append, insert_run, stored_run_state, test_engine,
    };
    use sidekicks_std::port_registration::PortRegistration;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_run_id, test_session_id,
    };
    use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};

    use super::{RESUMED_RUNS_STATEMENT_CAPACITY, ResumedRunsFinalize, ResumedRunsFinalizeDeps};
    use crate::test_pass::queue_message;

    /// The statements the delivery's read pool prepares: its reads, its recorder's and its provider
    /// sessions'.
    const DELIVERY_STATEMENT_CAPACITY: usize = 8;

    /// A provider that takes a message at once.
    const HANDS_AT_ONCE: MessageHanding = MessageHanding {
        hands_at: HandMoment::AtOnce,
        can_withdraw: true,
        kept_by_process: false,
        reads_priority_message: false,
    };

    /// What the provider's record of the run's conversation answers a lookup of the session's
    /// waiting messages.
    #[derive(Clone, Copy, Debug)]
    enum Record {
        /// It holds every message asked about.
        Holds,
        /// It holds none of them.
        Lacks,
        /// It could not be read.
        Unreadable,
    }

    /// A test session over its own database and log, the resumed runs' finalize and the queue's
    /// delivery built over it, each run's driver `driver` on the table's first provider.
    struct Fixture {
        database: TestDatabase,
        log: TestLog,
        session_id: SessionId,
        finalize: ResumedRunsFinalize,
        delivery: QueueDelivery,
        // Held so the delivery opens a paused run's session through them.
        _provider_sessions: Arc<ProviderSessions>,
        _home: tempfile::TempDir,
    }

    async fn fixture(driver: MockProviderDriver) -> Fixture {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let engine = test_engine(&database, Arc::clone(&log.service), home.path());
        let session_id = test_session_id();
        insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
        let delivery_reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            DELIVERY_STATEMENT_CAPACITY,
        ));
        // The tests hand each resume's runs to the finalize themselves.
        let provider_sessions = test_provider_sessions(
            Arc::clone(&delivery_reads),
            Arc::clone(&log.service),
            Arc::clone(&log.writer),
            Arc::clone(&providers),
            Arc::new(PortRegistration::new("resumed runs")),
            Arc::new(OrphanedAnswersStandIn::<ApprovalRequestId>::default()),
        );
        let delivery = test_delivery(
            delivery_reads,
            Arc::clone(&log.service),
            Arc::clone(&log.writer),
            Arc::clone(&providers),
            &provider_sessions,
        );
        let interventions = test_intervention_service(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                INTERVENTION_SERVICE_STATEMENT_CAPACITY,
            )),
            Arc::clone(&log.service),
            &engine,
            Arc::clone(&providers),
        );
        let finalize = ResumedRunsFinalize::new(ResumedRunsFinalizeDeps {
            reads: Arc::new(DatabaseReadPool::new(
                database.path(),
                RESUMED_RUNS_STATEMENT_CAPACITY,
            )),
            run_engine: engine,
            delivery: delivery.clone(),
            providers,
            interventions,
        });
        Fixture {
            database,
            log,
            session_id,
            finalize,
            delivery,
            _provider_sessions: provider_sessions,
            _home: home,
        }
    }

    impl Fixture {
        /// Stores `run_id` running in the session with its first turn open.
        async fn insert_running_turn(&self, run_id: RunId) {
            insert_run(&self.database, self.session_id, run_id, "running");
            let started: SessionEvent = serde_json::from_value(json!({
                "type": "agent.turn.started",
                "payload": {
                    "sessionId": self.session_id,
                    "runId": run_id,
                    "runVersion": 1,
                    "turnNumber": 1,
                },
            }))
            .expect("the test's turn start reads as an event");
            append(
                self.finalize.deps.run_engine.as_ref(),
                self.session_id,
                &started,
            )
            .await;
        }

        fn item_state(&self, item_id: QueueItemId) -> RecordedQueueItemState {
            QueueItemReader::new(&self.database.reader())
                .get(&item_id)
                .expect("the test reads its message")
                .expect("the test's message is stored")
                .state
        }

        /// The trigger of `run_id`'s interrupted end.
        fn interrupted_trigger(&self, run_id: RunId) -> String {
            self.database
                .reader()
                .query_row(
                    "SELECT json_extract(payload, '$.trigger') FROM session_events
                      WHERE run_id = ?1 AND type = 'agent.run.interrupted'",
                    [run_id.text().as_str()],
                    |row| row.get(0),
                )
                .expect("the run's interrupted end reads")
        }
    }

    // The events of `run_id` in the log, by type, in log order.
    fn event_types(database: &TestDatabase, run_id: RunId) -> Vec<String> {
        database
            .reader()
            .prepare("SELECT type FROM session_events WHERE run_id = ?1 ORDER BY sequence")
            .expect("the test reads the log")
            .query_map([run_id.text().as_str()], |row| row.get(0))
            .expect("the log reads")
            .collect::<Result<_, _>>()
            .expect("each event reads")
    }

    // Each run the answer names is finalized from its own answer: a running run whose turn is gone
    // ends `interrupted` by `daemonRestart`, one whose turn still runs stays `running`, a named run
    // the session no longer holds live is skipped, and a live run the answer leaves out is
    // untouched. Killed by the finalize handed a fixed `Gone` (the still-running run ends), by a
    // named run that has ended failing the whole ingress, and by an unnamed run finalized.
    #[tokio::test]
    async fn each_named_run_is_finalized_from_its_own_answer() {
        let fixture = fixture(MockProviderDriver::new()).await;
        let (gone, still_running, unnamed, ended) =
            (test_run_id(), test_run_id(), test_run_id(), test_run_id());
        for run_id in [gone, still_running, unnamed] {
            fixture.insert_running_turn(run_id).await;
        }
        let answer = |run_id, turn| ResumedRunAnswer { run_id, turn };

        fixture
            .finalize
            .finalize(ResumedRuns {
                session_id: fixture.session_id,
                runs: vec![
                    answer(ended, ProviderTurnAnswer::Gone),
                    answer(gone, ProviderTurnAnswer::Gone),
                    answer(still_running, ProviderTurnAnswer::StillRunning),
                ],
            })
            .await
            .expect("the named runs are finalized");

        assert_eq!(stored_run_state(&fixture.database, &gone).0, "interrupted");
        assert_eq!(fixture.interrupted_trigger(gone), "daemonRestart");
        for left in [still_running, unnamed] {
            assert_eq!(
                stored_run_state(&fixture.database, &left),
                ("running".to_owned(), 1)
            );
            assert_eq!(event_types(&fixture.database, left), ["agent.turn.started"]);
        }
    }

    // A message handed before the restart is settled by the resumed run's own record, whatever
    // the provider answered for the turn: one the record holds is admitted into the run and the
    // queue's next hand sends it no second time, even where the turn is gone; one it lacks still
    // waits and goes once more under its own id; an unreadable record ends it not delivered and
    // the run `interrupted` by `daemonRestart` though the provider answered the turn running.
    // Killed by the lookup skipped (a held message waits and is sent again), by the lookup skipped
    // for a gone turn, by a missing message marked taken (no second send), and by an unreadable
    // record ignored (the message waits, the run runs).
    #[rstest]
    #[case::held(
        ProviderTurnAnswer::StillRunning,
        Record::Holds,
        RecordedQueueItemState::Admitted,
        "running",
        false
    )]
    #[case::lacked(
        ProviderTurnAnswer::StillRunning,
        Record::Lacks,
        RecordedQueueItemState::Queued,
        "running",
        true
    )]
    #[case::unreadable(
        ProviderTurnAnswer::StillRunning,
        Record::Unreadable,
        RecordedQueueItemState::NotDelivered {
            reason: QueueItemNotDeliveredReason::Failed {},
        },
        "interrupted",
        false
    )]
    #[case::held_with_the_turn_gone(
        ProviderTurnAnswer::Gone,
        Record::Holds,
        RecordedQueueItemState::Admitted,
        "interrupted",
        false
    )]
    #[tokio::test]
    async fn a_waiting_message_is_settled_by_the_resumed_runs_record(
        #[case] turn: ProviderTurnAnswer,
        #[case] record: Record,
        #[case] settled_as: RecordedQueueItemState,
        #[case] run_state: &str,
        #[case] is_sent_again: bool,
    ) {
        let mut driver = MockProviderDriver::new();
        driver.expect_message_handing().return_const(HANDS_AT_ONCE);
        driver
            .expect_find_taken_messages()
            .times(1)
            .returning(move |params| {
                let found = match record {
                    Record::Holds => Ok(TakenMessages {
                        taken: params.message_ids,
                    }),
                    Record::Lacks => Ok(TakenMessages { taken: Vec::new() }),
                    Record::Unreadable => Err(DriverError::from(session_process_unavailable(
                        params.session_id,
                    ))),
                };
                async move { found }.boxed()
            });
        let steered = Arc::new(Mutex::new(Vec::new()));
        {
            let steered = Arc::clone(&steered);
            driver.expect_apply_intervention().returning(move |params| {
                if let ApplyInterventionParams::Steer {
                    client_idempotency_key,
                    ..
                } = params
                {
                    steered
                        .lock()
                        .expect("the steers are writable")
                        .push(client_idempotency_key);
                }
                async {
                    Ok(ApplyInterventionResponse {
                        status: InterventionResultStatus::Applied,
                        fallback_action: None,
                        delivered_run_id: None,
                        canceled: Vec::new(),
                    })
                }
                .boxed()
            });
        }
        let fixture = fixture(driver).await;
        let run_id = test_run_id();
        fixture.insert_running_turn(run_id).await;
        bind_run_to_first_provider(&fixture.database, run_id);
        let item_id = queue_message(&fixture.log.writer, fixture.session_id, run_id).await;

        fixture
            .finalize
            .finalize(ResumedRuns {
                session_id: fixture.session_id,
                runs: vec![ResumedRunAnswer { run_id, turn }],
            })
            .await
            .expect("the resumed run is settled");
        hand_waiting_messages(&fixture.delivery, fixture.session_id, run_id)
            .await
            .expect("the waiting messages are handed");

        assert_eq!(fixture.item_state(item_id), settled_as);
        assert_eq!(stored_run_state(&fixture.database, &run_id).0, run_state);
        if run_state == "interrupted" {
            assert_eq!(fixture.interrupted_trigger(run_id), "daemonRestart");
        }
        let sent_again: &[QueueItemId] = if is_sent_again { &[item_id] } else { &[] };
        assert_eq!(
            *steered.lock().expect("the steers are readable"),
            sent_again
        );
    }

    // An unreadable record ends the messages waiting for the run not delivered once, in the run's
    // own write where the finalize writes one: a running lead's gone turn ends it, a pausing lead
    // reaches `paused`, and a paused lead, which the finalize leaves as it is, has them written
    // alone. Killed by the companions dropped (the message left waiting) and by them written twice
    // (the second write refused, or a second end recorded).
    #[rstest]
    #[case::a_gone_run("running", "interrupted")]
    #[case::a_pausing_lead("pausing", "paused")]
    #[case::a_left_run("paused", "paused")]
    #[tokio::test]
    async fn an_unreadable_record_ends_its_waiting_messages_in_the_runs_write(
        #[case] stored_as: &str,
        #[case] settled_as: &str,
    ) {
        let mut driver = MockProviderDriver::new();
        driver.expect_message_handing().return_const(HANDS_AT_ONCE);
        driver
            .expect_find_taken_messages()
            .times(1)
            .returning(|params| {
                let unreadable = Err(DriverError::from(session_process_unavailable(
                    params.session_id,
                )));
                async move { unreadable }.boxed()
            });
        let fixture = fixture(driver).await;
        let run_id = test_run_id();
        fixture.insert_running_turn(run_id).await;
        fixture
            .database
            .reader()
            .execute(
                "UPDATE runs SET state = ?2 WHERE run_id = ?1",
                [run_id.text().as_str(), stored_as],
            )
            .expect("the test stores the run's state");
        bind_run_to_first_provider(&fixture.database, run_id);
        let item_id = queue_message(&fixture.log.writer, fixture.session_id, run_id).await;

        fixture
            .finalize
            .finalize(ResumedRuns {
                session_id: fixture.session_id,
                runs: vec![ResumedRunAnswer {
                    run_id,
                    turn: ProviderTurnAnswer::StillRunning,
                }],
            })
            .await
            .expect("the resumed run is settled");

        assert_eq!(
            fixture.item_state(item_id),
            RecordedQueueItemState::NotDelivered {
                reason: QueueItemNotDeliveredReason::Failed {},
            }
        );
        let not_delivered_ends: i64 = fixture
            .database
            .reader()
            .query_row(
                "SELECT count(*) FROM session_events
                  WHERE type = 'agent.queueItem.notDelivered'
                    AND json_extract(payload, '$.queueItemId') = ?1",
                [item_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads the message's ends");
        assert_eq!(not_delivered_ends, 1);
        assert_eq!(stored_run_state(&fixture.database, &run_id).0, settled_as);
    }
}
