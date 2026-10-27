use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::event::declared_variants::RunAgentOutputPayload;
use sidekicks_contracts::event::envelope::{DAEMON_SCOPE_SENTINEL_SESSION_ID, SourcePosition};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::{
    ProviderWarningSource, RunSafetyBufferingUpdatedPayload, SessionNotice,
    SessionNoticePostedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::operations::REASONING_ENTRY_CONTENT_MAX_LEN;
use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use tempfile::TempDir;

use super::{InboundDispatchError, RunInboundDispatch};
use crate::questions::schema::schema_parts;
use crate::run::engine::tests::{
    DRIVER_HOLD, SETTLE_WAIT, append, continue_request, held_driver, insert_running_run,
    stored_run_state, test_engine, turn_completed_at, turn_started_at,
};
use crate::run::engine::{RunEngine, RunEngineError};
use crate::run::epochs::{ConfirmedCut, DeliveryAttribution, EpochBinding, ExecutionEpochs};
use crate::run::refusals::RunRefusal;
use crate::run::state_change::RunStateChangeCompanions;
use crate::transcript::reasoning::read_reasoning;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::diagnostics::RecordedEvents;
use sidekicks_provider::driver::registry::test_provider;
use sidekicks_provider::driver::test_registry::new_run_id;
use sidekicks_provider::port::run_state_publisher::RunStatePublisher;
use sidekicks_provider::run::delivery::{
    DeliveryBinding, DeliveryOperation, InboundDelivery, InboundOutcome, LateAppendableRow,
    LateEventAbsorbReason, MachineScopedRow, SessionScopedRow,
};
use sidekicks_provider::run::state_entry::{RunStateEntry, RunStateReport};
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::tests::open_log;

// A run-state stream no one reads.
struct UnreadRunStates;

impl RunStatePublisher for UnreadRunStates {
    fn publish(&self, _hold: RunSafetyBufferingUpdatedPayload) {}
}

// A dispatch over one binding of one run, its cursor remembering two operations.
struct Harness {
    database: TestDatabase,
    _home: TempDir,
    run_id: RunId,
    binding_id: RuntimeBindingId,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    engine: Arc<RunEngine>,
    dispatch: Arc<RunInboundDispatch>,
}

impl Harness {
    // A run stored in `state`, with its binding's cursor open at the run's start.
    async fn new(state: RunState) -> Self {
        let database = TestDatabase::new(schema_parts());
        let home = tempfile::tempdir().expect("the test makes a home folder");
        // Opening the writer creates the file with the daemon's schema.
        let log = open_log(&database, None).await;
        let engine = test_engine(&database, Arc::clone(&log.service), home.path());
        let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(2).expect("the cap is not zero"),
        )));
        let dispatch = Arc::new(RunInboundDispatch::new(
            Arc::clone(&engine),
            Arc::clone(&epochs),
            Arc::new(UnreadRunStates),
            Arc::clone(&log.service),
        ));
        let run_id = new_run_id();
        insert_running_run(&database, test_session_id(), run_id);
        database
            .reader()
            .execute(
                "UPDATE runs SET state = ?1 WHERE run_id = ?2",
                params![<&'static str>::from(state), run_id.text().as_str()],
            )
            .expect("the test sets the run's state");
        let binding_id =
            RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a UUID is a binding id");
        epochs
            .lock()
            .expect("no test thread panics holding the cursors")
            .open_binding(
                EpochBinding {
                    id: binding_id.clone(),
                    run_id,
                    provider_name: test_provider(),
                    provider_account_id: None,
                },
                RUN_START_POSITION,
            )
            .expect("the binding has no cursor yet");
        Self {
            database,
            _home: home,
            run_id,
            binding_id,
            epochs,
            engine,
            dispatch,
        }
    }

    // Opens `first`, then past two in-place cuts and two more openings evicts it, so a later
    // delivery of `first` may be from either cut's generation: its execution is unknown.
    fn evict_first_operation(&self) {
        let mut epochs = self
            .epochs
            .lock()
            .expect("no test thread panics holding the cursors");
        let binding_id = &self.binding_id;
        let opening = |correlation_key| {
            Some(DeliveryOperation {
                correlation_key,
                is_opening: true,
            })
        };
        let cut = |point| ConfirmedCut::InPlace {
            binding_id: binding_id.clone(),
            point: SourcePosition(SafeInt::new(point).expect("a small turn")),
        };
        epochs.open_turn(binding_id).expect("the cursor is open");
        epochs
            .attribute(binding_id, opening("first"))
            .expect("the cursor is open");
        epochs
            .fence_cut(cut(1))
            .expect("the cursor is open and not frozen");
        epochs.open_turn(binding_id).expect("the cursor is open");
        epochs
            .attribute(binding_id, opening("second"))
            .expect("the cursor is open");
        epochs
            .fence_cut(cut(2))
            .expect("the cursor is open and not frozen");
        epochs
            .attribute(binding_id, opening("third"))
            .expect("the cursor is open");
        assert!(
            matches!(
                epochs.attribute(binding_id, Some(CONTINUED_FIRST)),
                Ok(DeliveryAttribution::Unknown { .. })
            ),
            "the continuation of the evicted operation reads as unknown"
        );
    }

    // A delivery on the binding, of `operation` where it names one.
    fn on_binding(
        &self,
        operation: Option<DeliveryOperation<'static>>,
    ) -> DeliveryBinding<'static> {
        DeliveryBinding {
            binding_id: self.binding_id.clone(),
            operation,
        }
    }

    // The provider's interrupt of the run, on the binding.
    fn terminal(
        &self,
        operation: Option<DeliveryOperation<'static>>,
        is_daemon_interrupt_end: bool,
    ) -> InboundDelivery<'static> {
        InboundDelivery::RunLifecycle {
            binding: self.on_binding(operation),
            change: RunStateReport::new(
                self.run_id,
                RunStateEntry::Interrupted {
                    intended_close: None,
                    trigger: None,
                },
            ),
            turn_end: None,
            is_daemon_interrupt_end,
        }
    }

    async fn dispatched(&self, delivery: InboundDelivery<'_>) -> InboundOutcome {
        tokio::time::timeout(SETTLE_WAIT, self.dispatch.dispatch(delivery))
            .await
            .expect("the dispatch settles")
            .expect("the delivery is dispatched")
    }

    fn session_id(&self) -> SessionId {
        self.database
            .reader()
            .query_row(
                "SELECT session_id FROM runs WHERE run_id = ?1",
                [self.run_id.text().as_str()],
                |row| row.get::<_, String>(0),
            )
            .map(|text| SessionId::new(&text).expect("the run's session is a session id"))
            .expect("the test reads the run's session")
    }

    // A piece of the run's reply or reasoning `message_id`, without the stamp.
    fn piece_payload(&self, message_id: &str) -> RunAgentOutputPayload {
        serde_json::from_value(json!({
            "sessionId": self.session_id(),
            "runId": self.run_id,
            "providerMessageId": message_id,
        }))
        .expect("the test writes a piece's payload")
    }

    // A piece of `payload`'s reply, or of its reasoning, holding `text`, on the binding.
    fn piece(
        &self,
        payload: RunAgentOutputPayload,
        is_reasoning: bool,
        text: &str,
    ) -> InboundDelivery<'static> {
        if is_reasoning {
            InboundDelivery::ThinkingUpdate {
                binding: self.on_binding(None),
                payload,
                content: text.to_owned(),
            }
        } else {
            InboundDelivery::SessionRow {
                binding: self.on_binding(None),
                row: LateAppendableRow::AgentMessageSent(payload),
                content: Some(text.to_owned()),
            }
        }
    }

    // The sequence of the event `event_id` and the row it joins, where it joins one.
    fn stored_join(&self, event_id: &str) -> (i64, Option<i64>) {
        self.database
            .reader()
            .query_row(
                "SELECT sequence, joins_sequence FROM session_events WHERE id = ?1",
                [event_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the test reads the piece's stamp")
    }

    // The run's stored event types, in log order.
    fn stored_event_types(&self) -> Vec<String> {
        self.database
            .reader()
            .prepare("SELECT type FROM session_events WHERE run_id = ?1 ORDER BY sequence")
            .and_then(|mut statement| {
                statement
                    .query_map([self.run_id.text().as_str()], |row| row.get(0))?
                    .collect()
            })
            .expect("the test reads the run's events")
    }

    fn stored_event_count(&self) -> i64 {
        self.database
            .reader()
            .query_row(
                "SELECT COUNT(*) FROM session_events WHERE run_id = ?1",
                [self.run_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test counts the run's events")
    }
}

// A later delivery of the operation `first`.
const CONTINUED_FIRST: DeliveryOperation<'static> = DeliveryOperation {
    correlation_key: "first",
    is_opening: false,
};

// Killed by an unknown execution read as from before the cut, which absorbs the ask or the
// terminal and leaves the provider waiting on it for good.
#[rstest]
#[case::a_permission_ask(false)]
#[case::a_live_terminal(true)]
#[tokio::test]
async fn inbound_reads_an_unknown_execution_as_current_for_a_live_terminal_and_an_ask(
    #[case] is_terminal: bool,
) {
    let harness = Harness::new(RunState::Running).await;
    harness.evict_first_operation();

    let delivery = if is_terminal {
        harness.terminal(Some(CONTINUED_FIRST), false)
    } else {
        InboundDelivery::PermissionAsk {
            binding: harness.on_binding(Some(CONTINUED_FIRST)),
        }
    };
    let outcome = harness.dispatched(delivery).await;

    if is_terminal {
        let is_interrupted = matches!(
            &outcome,
            InboundOutcome::Transitioned { state } if *state == RunState::Interrupted
        );
        assert!(is_interrupted, "{outcome:?}");
        assert_eq!(
            stored_run_state(&harness.database, &harness.run_id).0,
            "interrupted"
        );
    } else {
        assert_eq!(outcome, InboundOutcome::AskAdmitted);
    }
}

// Killed by the ended run's refusal surfaced as a failure, by its diagnostic left out, by the
// daemon's own interrupt's end reported as late, and by any row written for it.
#[rstest]
#[case::with_a_diagnostic(false, 1)]
#[case::silently_after_the_daemons_interrupt(true, 0)]
fn inbound_absorbs_a_late_terminal_on_an_ended_run(
    #[case] is_daemon_interrupt_end: bool,
    #[case] diagnostics: usize,
) {
    let recorded = RecordedEvents::default();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the test's runtime starts");
    recorded.record_during(|| {
        runtime.block_on(async {
            let harness = Harness::new(RunState::Completed).await;

            let outcome = harness
                .dispatched(harness.terminal(None, is_daemon_interrupt_end))
                .await;

            assert_eq!(
                outcome,
                InboundOutcome::Absorbed {
                    reason: LateEventAbsorbReason::RunEnded,
                }
            );
            assert_eq!(harness.stored_event_count(), 0);
            assert_eq!(
                stored_run_state(&harness.database, &harness.run_id).0,
                "completed"
            );
        });
    });
    assert_eq!(
        recorded.field_on("run.lateEvent.absorbed", "counter").len(),
        diagnostics
    );
}

// Killed by a guard without its open-turn clause, which absorbs the piece sent after a person's
// interrupt, by the run's end closing the row of its open turn, by a piece taken once every turn of
// the ended run has ended, by its refusal surfaced as a failure, and by its diagnostic left out.
#[rstest]
#[case::a_reply_piece(false)]
#[case::a_reasoning_piece(true)]
fn inbound_takes_a_piece_until_every_turn_of_its_ended_run_has_ended(#[case] is_reasoning: bool) {
    let recorded = RecordedEvents::default();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the test's runtime starts");
    recorded.record_during(|| {
        runtime.block_on(async {
            let harness = Harness::new(RunState::Running).await;
            let (session_id, run_id) = (harness.session_id(), harness.run_id);
            append(
                &harness.engine,
                session_id,
                &turn_started_at(session_id, run_id, 1, 1),
            )
            .await;
            let before = harness
                .dispatched(harness.piece(harness.piece_payload("m1"), is_reasoning, "Before "))
                .await;
            let ended = harness
                .engine
                .end_run_for_interrupt(run_id, 1, None, None, RunStateChangeCompanions::default())
                .await
                .expect("the person's interrupt ends the run");
            assert!(ended);
            let after = harness
                .dispatched(harness.piece(harness.piece_payload("m1"), is_reasoning, "the cut."))
                .await;
            append(
                &harness.engine,
                session_id,
                &turn_completed_at(session_id, run_id, 1, 2),
            )
            .await;
            let late = harness
                .dispatched(harness.piece(harness.piece_payload("m1"), is_reasoning, "Late."))
                .await;

            let event_id = |outcome: &InboundOutcome| {
                let InboundOutcome::Appended { event_id } = outcome else {
                    panic!("the piece is appended as it is: {outcome:?}");
                };
                event_id.as_str().to_owned()
            };
            let (before_sequence, _) = harness.stored_join(&event_id(&before));
            let (_, after_joins) = harness.stored_join(&event_id(&after));
            assert_eq!(after_joins, Some(before_sequence));
            assert_eq!(
                late,
                InboundOutcome::Absorbed {
                    reason: LateEventAbsorbReason::RunEnded,
                }
            );
            let pieces = harness
                .stored_event_types()
                .into_iter()
                .filter(|event_type| {
                    matches!(
                        event_type.as_str(),
                        "agent.message.sent" | "agent.thinking.updated"
                    )
                })
                .count();
            assert_eq!(pieces, 2);
        });
    });
    assert_eq!(
        recorded.field_on("run.lateEvent.absorbed", "counter").len(),
        1
    );
}

// Killed by the piece's write not waiting out the continue, which absorbs a piece of the continued
// run as late while its `running` write is still to land.
#[tokio::test]
async fn inbound_appends_a_piece_of_a_run_being_continued_after_its_running_write() {
    let harness = Harness::new(RunState::Running).await;
    let ended = harness
        .engine
        .end_run_for_interrupt(
            harness.run_id,
            1,
            None,
            None,
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the person's interrupt ends the run");
    assert!(ended);
    let (start_driver, driver_has_started, release_driver) = held_driver();
    let request = continue_request(harness.run_id, start_driver);
    let piece_during_continue = async {
        driver_has_started
            .await
            .expect("the driver's start is reached");
        let release = async {
            tokio::time::sleep(DRIVER_HOLD).await;
            release_driver
                .send(())
                .expect("the continue still waits in its driver");
        };
        let piece = harness.piece(harness.piece_payload("m1"), false, "Going on.");
        tokio::join!(harness.dispatch.dispatch(piece), release).0
    };
    let (continued, dispatched) = tokio::time::timeout(SETTLE_WAIT, async {
        tokio::join!(
            Box::pin(harness.engine.continue_run(request)),
            Box::pin(piece_during_continue)
        )
    })
    .await
    .expect("the continue and the piece settle");

    continued.expect("the continue runs the run again");
    let outcome = dispatched.expect("the piece is dispatched");
    assert!(
        matches!(outcome, InboundOutcome::Appended { .. }),
        "{outcome:?}"
    );
    let types = harness.stored_event_types();
    assert_eq!(
        types[types.len() - 2..],
        ["agent.run.running", "agent.message.sent"]
    );
}

// Killed by every refusal of a piece's write absorbed as late, which reads a run with no row as
// ended and logs a driver's fault as a late piece.
#[tokio::test]
async fn inbound_fails_a_piece_of_a_run_with_no_row() {
    let harness = Harness::new(RunState::Running).await;
    let unknown = new_run_id();
    let mut payload = harness.piece_payload("m1");
    payload.run_id = unknown;

    let failure = tokio::time::timeout(
        SETTLE_WAIT,
        harness
            .dispatch
            .dispatch(harness.piece(payload, false, "Nowhere.")),
    )
    .await
    .expect("the dispatch settles");

    assert!(
        matches!(
            &failure,
            Err(InboundDispatchError::Engine(RunEngineError::Refused(
                RunRefusal::NotFound { run_id }
            ))) if *run_id == unknown
        ),
        "{failure:?}"
    );
    assert_eq!(harness.stored_event_count(), 0);
}

// Killed by a late `paused` or `running` report on a run a resume already set running surfaced as
// a failure on the event path, or by any row written for it; and by the engine taking a pause
// report that expects no state from `running` (`Next::Paused` added to `running`'s row in
// `transitions.rs`, which kills `a_late_pause_expecting_no_state`) or refusing one from `pausing`
// (`Next::Paused` dropped from `pausing`'s row).
#[rstest]
#[case::a_late_pause(
    RunState::Running,
    RunStateEntry::Paused,
    Some(RunState::Pausing),
    None
)]
#[case::a_late_pause_expecting_no_state(RunState::Running, RunStateEntry::Paused, None, None)]
#[case::a_late_turn_under_way(
    RunState::Running,
    RunStateEntry::Running {
        execution_posture: None,
    },
    None,
    None
)]
#[case::a_pause_from_pausing(
    RunState::Pausing,
    RunStateEntry::Paused,
    Some(RunState::Pausing),
    Some(RunState::Paused)
)]
#[tokio::test]
async fn inbound_takes_a_pause_report_only_from_pausing_and_absorbs_one_on_a_resumed_run(
    #[case] stored: RunState,
    #[case] entry: RunStateEntry,
    #[case] expected_state: Option<RunState>,
    #[case] moved_to: Option<RunState>,
) {
    let harness = Harness::new(stored).await;

    let outcome = harness
        .dispatched(InboundDelivery::RunLifecycle {
            binding: harness.on_binding(None),
            change: RunStateReport {
                expected_state,
                ..RunStateReport::new(harness.run_id, entry)
            },
            turn_end: None,
            is_daemon_interrupt_end: false,
        })
        .await;

    let stored_state = stored_run_state(&harness.database, &harness.run_id).0;
    if let Some(state) = moved_to {
        assert_eq!(outcome, InboundOutcome::Transitioned { state });
        assert_eq!(stored_state, <&'static str>::from(state));
    } else {
        assert_eq!(
            outcome,
            InboundOutcome::Absorbed {
                reason: LateEventAbsorbReason::RunResumed,
            }
        );
        assert_eq!(harness.stored_event_count(), 0);
        assert_eq!(stored_state, "running");
    }
}

// Killed by a long reasoning text stored as one piece over an entry's length, by a text cut by
// bytes rather than characters, by a piece left out, by the pieces read back out of order, and by
// an empty text stored as no piece.
#[tokio::test]
async fn inbound_stores_long_reasoning_as_pieces_the_reasoning_read_joins_back() {
    let harness = Harness::new(RunState::Running).await;
    // An astral character sits across the first cut, so a cut by bytes would split it.
    let letters: String = (0..2 * REASONING_ENTRY_CONTENT_MAX_LEN)
        .map(|index| {
            let index = u32::try_from(index % 26).expect("a letter's index fits");
            char::from_u32(0x61 + index).expect("a letter")
        })
        .collect();
    let text = format!(
        "{}\u{1f600}{letters}",
        "a".repeat(REASONING_ENTRY_CONTENT_MAX_LEN - 1)
    );
    let payload = harness.piece_payload("reasoning-1");

    harness
        .dispatched(InboundDelivery::ThinkingUpdate {
            binding: harness.on_binding(None),
            payload: payload.clone(),
            content: text.clone(),
        })
        .await;

    assert_eq!(harness.stored_event_count(), 3);
    let request = serde_json::from_value(json!({ "runId": harness.run_id }))
        .expect("the test's request reads");
    let page = read_reasoning(&harness.database.reader(), &|_: &SessionId| None, &request)
        .expect("the reasoning reads");
    let page = serde_json::to_value(page).expect("a page serializes");
    let entries = page["reasoningEntries"]
        .as_array()
        .expect("the page holds entries");
    assert!(entries.iter().all(|entry| {
        entry["content"]
            .as_str()
            .is_some_and(|content| content.chars().count() <= REASONING_ENTRY_CONTENT_MAX_LEN)
    }));
    let read_back: String = entries
        .iter()
        .map(|entry| entry["content"].as_str().expect("an entry holds text"))
        .collect();
    assert_eq!(read_back, text);

    harness
        .dispatched(InboundDelivery::ThinkingUpdate {
            binding: harness.on_binding(None),
            payload,
            content: String::new(),
        })
        .await;
    assert_eq!(harness.stored_event_count(), 4);
}

// An account's quota reading is filed under the machine's sentinel session with the account's
// credential generation, so one from before a sign-in again reads as stale. Killed by dropping the
// generation from the row.
#[tokio::test]
async fn inbound_files_a_rate_limit_reading_under_the_sentinel_session_with_its_generation() {
    let harness = Harness::new(RunState::Running).await;
    let reading = serde_json::from_value(json!({
        "provider": "codex",
        "providerAccountId": "account-1",
        "credentialGeneration": 3,
        "windowMins": 300,
        "usedPercent": 42,
    }))
    .expect("the test writes a quota reading");

    harness
        .dispatched(InboundDelivery::MachineEvent {
            row: MachineScopedRow::UsageRateLimitUpdated(reading),
        })
        .await;

    let filed: Vec<(String, i64)> = harness
        .database
        .reader()
        .prepare(
            "SELECT type, json_extract(payload, '$.credentialGeneration') FROM session_events
             WHERE session_id = ?1",
        )
        .and_then(|mut statement| {
            statement
                .query_map([DAEMON_SCOPE_SENTINEL_SESSION_ID.text().as_str()], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect()
        })
        .expect("the test reads the sentinel session's rows");
    assert_eq!(filed, [("usage.rateLimit.updated".to_owned(), 3)]);
}

// A notice, a side question's answer, and the run's context-window reading and retried request
// each reach the log on their session, the run's rows on the run. Killed by dropping the append
// of the `SessionNotice` or the `SessionEvent` arm, or by filing a `SessionRow` without its run.
#[tokio::test]
async fn inbound_appends_a_notice_an_answer_and_the_runs_usage_rows() {
    let harness = Harness::new(RunState::Running).await;
    let session_id = harness.session_id();
    let run_id = harness.run_id;
    let warning = FreeFormText::new("the model is deprecated".to_owned())
        .expect("the test's warning is text");
    harness
        .dispatched(InboundDelivery::SessionNotice {
            session_id,
            notice: SessionNoticePostedPayload::Notice(SessionNotice::ProviderWarning {
                session_id,
                source: ProviderWarningSource::Deprecation,
                text: warning,
                details: None,
            }),
        })
        .await;
    let answer = serde_json::from_value(json!({
        "sessionId": session_id,
        "sideQuestionId": mint_uuid_v7().to_string(),
        "question": "what changed?",
        "answer": "the parser",
    }))
    .expect("the test writes a side question's answer");
    harness
        .dispatched(InboundDelivery::SessionEvent {
            row: SessionScopedRow::SideQuestionAnswered(answer),
        })
        .await;
    let context_window = serde_json::from_value(json!({
        "sessionId": session_id,
        "runId": run_id,
        "windowUsedTokens": 1200,
        "windowMaxTokens": 200_000,
        "windowSource": "providerReported",
        "exceeded": false,
    }))
    .expect("the test writes a context-window reading");
    let retried = serde_json::from_value(json!({
        "sessionId": session_id,
        "runId": run_id,
        "provider": "codex",
        "errorKind": "overloaded",
    }))
    .expect("the test writes a retried request");
    for row in [
        LateAppendableRow::UsageContextWindowUpdated(context_window),
        LateAppendableRow::UsageApiRequestRetried(retried),
    ] {
        harness
            .dispatched(InboundDelivery::SessionRow {
                binding: harness.on_binding(None),
                row,
                content: None,
            })
            .await;
    }

    let stored: Vec<(String, Option<String>, String)> = harness
        .database
        .reader()
        .prepare(
            "SELECT type, run_id, CAST(COALESCE(json_extract(payload, '$.text'),
                    json_extract(payload, '$.answer'), json_extract(payload, '$.windowUsedTokens'),
                    json_extract(payload, '$.errorKind')) AS TEXT)
               FROM session_events WHERE session_id = ?1 ORDER BY sequence",
        )
        .and_then(|mut statement| {
            statement
                .query_map([session_id.text().as_str()], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect()
        })
        .expect("the test reads the session's rows");
    let on_run = Some(run_id.text().as_str().to_owned());
    assert_eq!(
        stored,
        [
            (
                "session.notice.posted".to_owned(),
                None,
                "the model is deprecated".to_owned()
            ),
            (
                "session.sideQuestion.answered".to_owned(),
                None,
                "the parser".to_owned()
            ),
            (
                "usage.contextWindow.updated".to_owned(),
                on_run.clone(),
                "1200".to_owned()
            ),
            (
                "usage.apiRequest.retried".to_owned(),
                on_run,
                "overloaded".to_owned()
            ),
        ]
    );
}
