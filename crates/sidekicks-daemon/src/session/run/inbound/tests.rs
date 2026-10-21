use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::event::declared_variants::RunAgentOutputPayload;
use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::operations::REASONING_ENTRY_CONTENT_MAX_LEN;
use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;
use sidekicks_contracts::wire::integer::SafeInt;
use tempfile::TempDir;

use super::{
    DeliveryBinding, InboundDelivery, InboundOutcome, LateEventAbsorbReason, RunInboundDispatch,
};
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::provider::driver::diagnostics::RecordedEvents;
use crate::provider::driver::registry::test_provider;
use crate::provider::port::run_state_publisher::RunStatePublisher;
use crate::session::run::engine::tests::{
    SETTLE_WAIT, insert_running_run, stored_run_state, test_engine,
};
use crate::session::run::epochs::{
    ConfirmedCut, DeliveryAttribution, DeliveryOperation, EpochBinding, ExecutionEpochs,
};
use crate::session::run::state_change::{RunStateChange, RunStateEntry};
use crate::transcript::reasoning::read_reasoning;
use crate::uuid_v7::mint_uuid_v7;

// A publisher no run state stream reads.
struct UnreadPublisher;

impl RunStatePublisher for UnreadPublisher {
    fn publish(&self, _hold: RunSafetyBufferingUpdatedPayload) {}
}

// A dispatch over one binding of one run, its cursor remembering two operations.
struct Harness {
    database: TestDatabase,
    _home: TempDir,
    run_id: RunId,
    binding_id: RuntimeBindingId,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    dispatch: RunInboundDispatch,
}

impl Harness {
    // A run stored in `state`, with its binding's cursor open at the run's start.
    async fn new(state: RunState) -> Self {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
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
        let mut epochs = ExecutionEpochs::new(NonZeroUsize::new(2).expect("the cap is not zero"));
        epochs
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
        let epochs = Arc::new(Mutex::new(epochs));
        let engine = test_engine(&database, Arc::clone(&log.service), home.path());
        let dispatch = RunInboundDispatch::new(
            engine,
            Arc::clone(&epochs),
            Arc::new(UnreadPublisher),
            log.service,
        );
        Self {
            database,
            _home: home,
            run_id,
            binding_id,
            epochs,
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
            change: RunStateChange::new(
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
            InboundOutcome::Transitioned { run } if run.state == RunState::Interrupted
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

// Killed by a late `paused` or `running` report on a run a resume already set running surfaced as
// a failure on the event path, or by any row written for it.
#[rstest]
#[case::a_late_pause(RunStateEntry::Paused)]
#[case::a_late_turn_under_way(RunStateEntry::Running {
    execution_posture: None,
})]
#[tokio::test]
async fn inbound_absorbs_a_late_report_on_a_resumed_run(#[case] entry: RunStateEntry) {
    let harness = Harness::new(RunState::Running).await;

    let outcome = harness
        .dispatched(InboundDelivery::RunLifecycle {
            binding: harness.on_binding(None),
            change: RunStateChange::new(harness.run_id, entry),
            turn_end: None,
            is_daemon_interrupt_end: false,
        })
        .await;

    assert_eq!(
        outcome,
        InboundOutcome::Absorbed {
            reason: LateEventAbsorbReason::RunResumed,
        }
    );
    assert_eq!(harness.stored_event_count(), 0);
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id).0,
        "running"
    );
}

// Killed by a long reasoning text stored as one piece over an entry's length, by a text cut by
// bytes rather than characters, by a piece left out, by the pieces read back out of order, and by
// an empty text stored as no piece.
#[tokio::test]
async fn inbound_stores_long_reasoning_as_pieces_the_reasoning_read_joins_back() {
    let harness = Harness::new(RunState::Running).await;
    let session_id: SessionId = harness
        .database
        .reader()
        .query_row(
            "SELECT session_id FROM runs WHERE run_id = ?1",
            [harness.run_id.text().as_str()],
            |row| row.get::<_, String>(0),
        )
        .map(|text| SessionId::new(&text).expect("the run's session is a session id"))
        .expect("the test reads the run's session");
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
    let payload: RunAgentOutputPayload = serde_json::from_value(json!({
        "sessionId": session_id,
        "runId": harness.run_id,
        "providerMessageId": "reasoning-1",
    }))
    .expect("the test writes a reasoning payload");

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
