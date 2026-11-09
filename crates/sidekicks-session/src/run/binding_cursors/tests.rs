use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::{EpochPosition, RUN_START_POSITION};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::account::observer::AccountLiveTurns as _;
use sidekicks_provider::driver::test_registry::first_provider;
use sidekicks_provider::run::delivery::DeliveryOperation;
use sidekicks_provider::runtime_binding::store::{CreateRuntimeBindingInput, read_binding};
use sidekicks_provider::runtime_binding::test_store::{
    binding_input, open_store, spawn_config_on, spawned_build, test_provider_account_id,
};
use sidekicks_provider::runtime_binding::writer::RuntimeBindingWriter as _;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::statement::run_statement;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use sidekicks_store::events::content::codec::BodyEncoder;
use sidekicks_store::events::session::followers::CommittedEvent;
use sidekicks_store::events::session::insert::{
    SessionEventRow, insert_session_event, monotonic_ns_now,
};

use super::{RUN_BINDING_CURSORS_STATEMENT_CAPACITY, RunBindingCursorError, RunBindingCursors};
use crate::agent_tree::store::{NewAgentTreeNode, insert_node};
use crate::questions::schema::schema_parts;
use crate::run::engine::test_fixture::insert_run;
use crate::run::epochs::{ConfirmedCut, DeliveryAttribution, ExecutionEpochs};

struct Harness {
    database: TestDatabase,
    session_id: SessionId,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    cursors: RunBindingCursors,
}

impl Harness {
    async fn new() -> Self {
        let database =
            TestDatabase::new(schema_parts().with_parts(crate::agent_tree::schema::schema_parts()));
        let store = open_store(&database).await;
        let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(8).expect("the cap is not zero"),
        )));
        let cursors = RunBindingCursors::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                RUN_BINDING_CURSORS_STATEMENT_CAPACITY,
            )),
            Arc::new(|_: &SessionId| None),
            Arc::new(store),
            Arc::clone(&epochs),
        );
        Self {
            database,
            session_id: test_session_id(),
            epochs,
            cursors,
        }
    }

    // A running run of the session.
    fn run(&self) -> RunId {
        self.run_in("running")
    }

    // A run of the session in `state`.
    fn run_in(&self, state: &str) -> RunId {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_run(&self.database, self.session_id, run_id, state);
        run_id
    }

    // The provider's helper `subagent_id`, running under `parent`, with its node in the tree.
    fn running_helper(&self, parent: RunId, subagent_id: &str) {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let reader = self.database.reader();
        reader
            .execute(
                "INSERT INTO runs
                   (run_id, session_id, parent_run_id, reached_by, state, run_version)
                 VALUES (?1, ?2, ?3, 'providerSubagent', 'running', 1)",
                params![
                    run_id.text().as_str(),
                    self.session_id.text().as_str(),
                    parent.text().as_str(),
                ],
            )
            .expect("the test writes the helper's run");
        let node = NewAgentTreeNode {
            child_handle: ChildHandle::new(format!("handle-{subagent_id}"))
                .expect("a child handle"),
            session_id: self.session_id,
            provider_name: first_provider(),
            subagent_id: subagent_id.to_owned(),
            parent_subagent_id: None,
            parent_child_handle: None,
            name: None,
            role: None,
            provider_path: None,
            ask: None,
            model_id: None,
            effort: None,
            start_call_id: None,
            own_run_id: run_id,
            started_at: WireInstant::now(),
        };
        run_statement(&reader, &insert_node(&node)).expect("the test writes the helper's node");
    }

    // The account binding `binding_id`'s row names.
    fn stored_account(&self, binding_id: &RuntimeBindingId) -> ProviderAccountId {
        read_binding(&self.database.reader(), binding_id)
            .expect("the binding reads")
            .expect("the binding has a row")
            .spawn_config
            .provider_account_id
    }

    // The account a delivery on `binding_id` is charged to now, by its open cursor.
    fn charged_account(&self, binding_id: &RuntimeBindingId) -> ProviderAccountId {
        lock(&self.epochs)
            .binding(binding_id)
            .expect("the binding's cursor is open")
            .provider_account_id
            .clone()
    }

    // Records a binding of `run_id` through the cursors.
    async fn bind(&self, run_id: RunId) -> RuntimeBindingId {
        self.cursors
            .create(self.session_id, binding_of(run_id))
            .await
            .expect("the binding is recorded")
            .id
    }

    // Opens a binding of `run_id` through the cursors before its row, then records the row.
    async fn bind_opened(&self, run_id: RunId) -> RuntimeBindingId {
        let input = binding_of(run_id);
        self.cursors
            .open_binding(
                self.session_id,
                input.id.clone(),
                run_id,
                input.provider_name.clone(),
                test_provider_account_id(),
            )
            .await
            .expect("the cursor opens");
        self.cursors
            .record_opened_binding(input)
            .await
            .expect("the binding is recorded")
            .id
    }

    // Has the cursors hear `run_id` move from `from` to `to` by an event of `event_type`.
    fn hear_run_move(
        &self,
        run_id: RunId,
        event_type: SessionEventType,
        from: RunState,
        to: RunState,
    ) {
        self.hear(json!({
            "type": event_type.as_str(),
            "payload": {
                "sessionId": self.session_id,
                "runId": run_id,
                "runVersion": 2,
                "previousState": <&'static str>::from(from),
                "newState": <&'static str>::from(to),
            },
        }));
    }

    // Has the cursors hear `event`, a session event as the wire writes it.
    fn hear(&self, event: serde_json::Value) {
        let event: SessionEvent =
            serde_json::from_value(event).expect("the test writes a session event");
        self.cursors
            .observe(&CommittedEvent {
                envelope: Arc::new(test_envelope(self.session_id, &event)),
                sequence: SafeInt::new(1).expect("a sequence"),
            })
            .expect("the event reads as its type");
    }

    // Stores `events`, session events as the wire writes them, in order in the session's log.
    fn store_log(&self, events: &[serde_json::Value]) {
        let connection = self.database.reader();
        let mut encoder = BodyEncoder::new();
        for event in events {
            let event: SessionEvent =
                serde_json::from_value(event.clone()).expect("the test writes a session event");
            let envelope = test_envelope(self.session_id, &event);
            let row = SessionEventRow {
                payload: serde_json::to_string(envelope.payload())
                    .expect("a JSON object serializes"),
                envelope: Arc::new(envelope),
                monotonic_ns: monotonic_ns_now(),
                content_payload: None,
            };
            insert_session_event(&connection, &mut encoder, &row).expect("the event is stored");
        }
    }

    fn is_open(&self, binding_id: &RuntimeBindingId) -> bool {
        self.cursors.is_binding_open(binding_id)
    }

    // Has the cursors hear the session close.
    fn hear_close(&self) {
        self.hear(json!({
            "type": SessionEventType::SessionClosed.as_str(),
            "payload": {
                "sessionId": self.session_id,
                "previousState": "active",
                "newState": "closed",
            },
        }));
    }

    // Arms a hold for each of `count` opens, once its run is read and before its cursor
    // opens; waits until all are held, has the cursors hear the session close, and lets them
    // go on.
    async fn close_while_held(&self, count: usize) {
        let holds: Vec<_> = (0..count)
            .map(|_| self.cursors.held_run_read_pause.arm())
            .collect();
        let mut releases = Vec::new();
        for hold in holds {
            hold.reached.await.expect("the open reaches its hold");
            releases.push(hold.release);
        }
        self.hear_close();
        for release in releases {
            release.send(()).expect("the open waits at its hold");
        }
    }
}

fn binding_of(run_id: RunId) -> CreateRuntimeBindingInput {
    CreateRuntimeBindingInput {
        run_id,
        ..binding_input(
            spawn_config_on(test_provider_account_id()),
            spawned_build("2.0.0", "/opt/provider/bin"),
        )
    }
}

// Killed by a run's end dropping its cursor at once, so a late delivery finds none; by a
// continue leaving the run marked, so the next binding drops a live run's cursor; and by the
// next binding, opened before its row, leaving an ended run's cursor open. The session's
// current binding, which a command's ending is appended on, is the one recorded last: killed by
// `hold` leaving it unset or keeping the first one.
#[tokio::test]
async fn binding_cursors_drop_an_ended_run_only_at_the_sessions_next_binding() {
    let harness = Harness::new().await;
    let first_run = harness.run();
    let first_binding = harness.bind(first_run).await;
    let current = || harness.cursors.current_binding(&harness.session_id);
    assert_eq!(current(), Some(first_binding.clone()));

    let completed = SessionEventType::AgentRunCompleted;
    harness.hear_run_move(first_run, completed, RunState::Running, RunState::Completed);
    assert!(
        harness.is_open(&first_binding),
        "an ended run keeps its cursor until then"
    );

    let running = SessionEventType::AgentRunRunning;
    harness.hear_run_move(first_run, running, RunState::Interrupted, RunState::Running);
    let second_binding = harness.bind(harness.run()).await;
    assert!(
        harness.is_open(&first_binding),
        "a continued run keeps its cursor"
    );
    assert_eq!(current(), Some(second_binding));

    harness.hear_run_move(first_run, completed, RunState::Running, RunState::Completed);
    let last_binding = harness.bind_opened(harness.run()).await;
    assert!(
        !harness.is_open(&first_binding),
        "the next binding drops the ended run's"
    );
    assert!(harness.is_open(&last_binding));
    assert_eq!(current(), Some(last_binding));
}

// Killed by an open that does not check for the session's close: a close heard while an open
// awaits its read would leave a cursor and an entry for the closed session that nothing drops.
#[tokio::test]
async fn a_session_closed_while_its_opens_read_opens_no_cursor() {
    let harness = Harness::new().await;
    let run_id = harness.run();
    let leg = harness
        .cursors
        .create(harness.session_id, binding_of(run_id))
        .await
        .expect("the binding is recorded");
    let (minted, relaunched, opened) = (
        binding_of(run_id).id,
        binding_of(run_id).id,
        binding_of(run_id),
    );
    let session_id = harness.session_id;

    let (opened_answer, relaunch_answer, driver_relaunch_answer, ()) = tokio::join!(
        harness.cursors.open_binding(
            session_id,
            opened.id.clone(),
            run_id,
            opened.provider_name,
            test_provider_account_id(),
        ),
        harness
            .cursors
            .open_relaunch(session_id, &leg, minted.clone()),
        harness
            .cursors
            .open_driver_relaunch(session_id, relaunched.clone()),
        harness.close_while_held(3),
    );

    for answer in [opened_answer, relaunch_answer, driver_relaunch_answer] {
        assert!(
            matches!(
                answer,
                Err(RunBindingCursorError::SessionClosed { session_id: closed })
                    if closed == session_id
            ),
            "{answer:?}"
        );
    }
    for binding_id in [&leg.id, &opened.id, &minted, &relaunched] {
        assert!(!harness.is_open(binding_id), "no cursor stays open");
    }
    assert!(
        harness.cursors.lock_sessions().by_session.is_empty(),
        "no entry outlives the session"
    );
}

// Killed by a close mark the last open in flight leaves behind, which the cursors would keep
// for every session that ever closed.
#[tokio::test]
async fn a_close_mark_goes_with_the_last_open_in_flight() {
    let harness = Harness::new().await;
    let run_id = harness.run();
    let opened = binding_of(run_id);

    let (answer, ()) = tokio::join!(
        harness.cursors.open_binding(
            harness.session_id,
            opened.id,
            run_id,
            opened.provider_name,
            test_provider_account_id(),
        ),
        harness.close_while_held(1),
    );

    assert!(
        matches!(answer, Err(RunBindingCursorError::SessionClosed { .. })),
        "{answer:?}"
    );
    assert!(
        harness.cursors.lock_sessions().in_flight.is_empty(),
        "no mark outlives the opens"
    );
}

// Killed by the fence skipped, so the fork has no cursor and a delivery from before the cut
// reads as current, and by the fork's binding left out of its run's cursors, so it is not the
// session's current binding and its cursor outlives the session's close.
#[tokio::test]
async fn a_fenced_fork_opens_the_new_epoch_on_a_binding_its_run_holds() {
    let harness = Harness::new().await;
    let run_id = harness.run();
    let cut_binding = harness.bind(run_id).await;
    let fork_binding = binding_of(run_id).id;
    let operation = |is_opening| {
        Some(DeliveryOperation {
            correlation_key: "call",
            is_opening,
        })
    };
    {
        let mut epochs = harness
            .epochs
            .lock()
            .expect("no test thread panics holding them");
        epochs.open_turn(&cut_binding).expect("the cursor is open");
        epochs
            .attribute(&cut_binding, operation(true))
            .expect("the cursor is open");
    }

    harness
        .cursors
        .fence_cut(ConfirmedCut::ForkRestart {
            binding_id: cut_binding.clone(),
            point: SourcePosition(SafeInt::new(1).expect("a small turn")),
            new_binding_id: fork_binding.clone(),
        })
        .expect("the cut binding's cursor is open and not frozen");

    {
        let mut epochs = harness
            .epochs
            .lock()
            .expect("no test thread panics holding them");
        assert_eq!(
            epochs
                .attribute(&cut_binding, operation(false))
                .expect("the cut binding's cursor stays open"),
            DeliveryAttribution::BeforeCut {
                source: EpochPosition {
                    epoch: RUN_START_POSITION.epoch,
                    position: SourcePosition(SafeInt::new(1).expect("a small turn")),
                },
            }
        );
        assert_eq!(
            epochs
                .attribute(&fork_binding, None)
                .expect("the fork's cursor is open"),
            DeliveryAttribution::Current
        );
    }
    assert_eq!(
        harness.cursors.current_binding(&harness.session_id),
        Some(fork_binding.clone())
    );
    harness.hear_close();
    assert!(
        !harness.is_open(&fork_binding),
        "the fork's cursor drops with its session"
    );
}

// Killed by a cursor opened at the run's start rather than where its log stands: the run took turn
// 1, rolled back to before it and took turn 2, so it stands at epoch 1's first turn, and an
// operation opened in the binding's next turn reads, past the next cut, as from epoch 1's second
// turn, where a cursor opened at the start would place it at epoch 0's first. A relaunch whose
// predecessor's cursor is gone falls back to the same standing.
#[rstest]
#[case::a_new_binding(false)]
#[case::a_relaunch_with_no_predecessor_cursor(true)]
#[tokio::test]
async fn a_cursor_opens_where_its_runs_log_stands(#[case] is_relaunch: bool) {
    let harness = Harness::new().await;
    let run_id = harness.run();
    let turn_started = |turn_number: u64, run_version: u64| {
        json!({
            "type": SessionEventType::AgentTurnStarted.as_str(),
            "payload": {
                "sessionId": harness.session_id,
                "runId": run_id,
                "runVersion": run_version,
                "turnNumber": turn_number,
            },
        })
    };
    harness.store_log(&[
        turn_started(1, 1),
        json!({
            "type": SessionEventType::AgentRunRolledBack.as_str(),
            "payload": {
                "sessionId": harness.session_id,
                "runId": run_id,
                "runVersion": 2,
                "targetPosition": 0,
            },
        }),
        turn_started(2, 2),
    ]);
    let leg = harness
        .cursors
        .create(harness.session_id, binding_of(run_id))
        .await
        .expect("the binding is recorded");
    let binding_id = if is_relaunch {
        harness.cursors.forget_binding(&leg.id);
        let minted = binding_of(run_id).id;
        harness
            .cursors
            .open_relaunch(harness.session_id, &leg, minted.clone())
            .await
            .expect("the relaunch's cursor opens");
        minted
    } else {
        leg.id
    };
    let operation = |is_opening| {
        Some(DeliveryOperation {
            correlation_key: "call",
            is_opening,
        })
    };
    {
        let mut epochs = harness
            .epochs
            .lock()
            .expect("no test thread panics holding them");
        epochs.open_turn(&binding_id).expect("the cursor is open");
        epochs
            .attribute(&binding_id, operation(true))
            .expect("the cursor is open");
    }

    harness
        .cursors
        .fence_cut(ConfirmedCut::InPlace {
            binding_id: binding_id.clone(),
            point: SourcePosition(SafeInt::ZERO),
        })
        .expect("the cursor is open and not frozen");

    let attribution = harness
        .epochs
        .lock()
        .expect("no test thread panics holding them")
        .attribute(&binding_id, operation(false))
        .expect("the cursor stays open");
    assert_eq!(
        attribution,
        DeliveryAttribution::BeforeCut {
            source: EpochPosition {
                epoch: SourceEpoch(SafeInt::new(1).expect("a small epoch")),
                position: SourcePosition(SafeInt::new(2).expect("a small turn")),
            },
        }
    );
}

// A live turn's binding a driver moves onto another account through the cursors counts as a live
// turn on that account and no longer on the one it left, so the account it runs on now cannot be
// removed under it. Killed by a move that writes the row and leaves the cursor on the old account.
#[tokio::test]
async fn a_binding_moved_onto_another_account_holds_a_live_turn_there() {
    let harness = Harness::new().await;
    let binding_id = harness.bind(harness.run()).await;
    let (left, moved_to) = (
        test_provider_account_id(),
        ProviderAccountId::new("account-2".to_owned()).expect("the test's account id is valid"),
    );
    let live_on = |account| harness.cursors.sessions_with_live_turns(account);
    assert_eq!(live_on(&left), [harness.session_id]);

    harness
        .cursors
        .move_account(binding_id, moved_to.clone())
        .await
        .expect("the binding moves");

    assert_eq!(live_on(&moved_to), [harness.session_id]);
    assert_eq!(live_on(&left), Vec::new());
}

// A lead's binding a driver moves onto another account carries, in the same write, the binding of
// each run a live helper of its session runs under: the binding of an earlier lead run a helper
// it left running still rides reads the new account in its row, and a usage frame on it is charged
// to the new account the moment the lead's move returns, with no write of its own after; an ended
// lead run's binding no helper rides stays. A helper charged to the old account between the two
// writes spends the limit its lead left. Killed by the helpers' bindings moved in a later write or
// not at all (both read the old account), by a helper's own run read in place of the run it runs
// under (it has no binding, so nothing rides), by the cursors left on the old account, and by
// every binding of the session moved (the ended one moves).
#[tokio::test]
async fn a_moved_binding_carries_the_bindings_its_helpers_ride_in_the_same_write() {
    let harness = Harness::new().await;
    let (old, to) = (
        test_provider_account_id(),
        ProviderAccountId::new("account-2".to_owned()).expect("the test's account id is valid"),
    );
    let ended = harness.bind(harness.run_in("completed")).await;
    let earlier = harness.run_in("completed");
    let left_running_on = harness.bind(earlier).await;
    let current = harness.run();
    let current_binding = harness.bind(current).await;
    harness.running_helper(earlier, "helper-left-running");
    harness.running_helper(current, "helper-current");

    harness
        .cursors
        .move_account(current_binding.clone(), to.clone())
        .await
        .expect("the binding moves");

    assert_eq!(harness.charged_account(&left_running_on), to);
    assert_eq!(harness.charged_account(&current_binding), to);
    assert_eq!(harness.stored_account(&left_running_on), to);
    assert_eq!(harness.stored_account(&current_binding), to);
    assert_eq!(harness.stored_account(&ended), old);
    assert_eq!(harness.charged_account(&ended), old);
}
