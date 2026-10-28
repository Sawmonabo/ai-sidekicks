//! A run's start waits for its session's process to settle before its binding is opened: within
//! the delivery timeout, and on the leg the process settled on.

use std::sync::Arc;

use rusqlite::params;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::runtime_binding::store::{RuntimeBindingRelaunch, RuntimeBindingStore};
use sidekicks_provider::runtime_binding::test_store::spawned_build;
use sidekicks_session::queue_store::RecordedQueueItemState;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use tokio::time::timeout;

use super::{DriverCalls, Fixture, READ_STATEMENT_CAPACITY, WAIT, fixture, recording_driver};
use crate::admission::QUEUE_DELIVERY_TIMEOUT;

impl Fixture {
    /// The resume handle of the binding `run_id` was given.
    fn run_resume_handle(&self, run_id: RunId) -> String {
        self.database
            .reader()
            .query_row(
                "SELECT resume_handle FROM runtime_bindings WHERE run_id = ?1
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                params![run_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads the run's binding")
    }

    /// The id of the binding `run_id` was given.
    fn run_binding_id(&self, run_id: RunId) -> RuntimeBindingId {
        let id: String = self
            .database
            .reader()
            .query_row(
                "SELECT id FROM runtime_bindings WHERE run_id = ?1",
                params![run_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads the run's binding");
        RuntimeBindingId::new(id).expect("a stored binding id reads")
    }
}

// A process that never settles fails the start once the delivery timeout passed: the driver is
// never handed the run, the run fails `provider.unavailable`, its message reads not delivered and
// its place at the gate is given back. Killed by a settle waited on with no bound.
#[tokio::test(start_paused = true)]
async fn a_process_that_never_settles_fails_the_start_after_the_delivery_timeout() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    // Held and never released: the session's process stays on its way back.
    let _never_settled = calls.settle_pause.arm();

    let item_id = fixture.send().await.expect("the send is saved");
    timeout(QUEUE_DELIVERY_TIMEOUT * 2, fixture.queue.stop())
        .await
        .expect("the start ends at the delivery timeout");

    assert!(calls.starts().is_empty(), "{:?}", calls.starts());
    let item = fixture.stored_item(item_id);
    assert_eq!(
        item.state,
        RecordedQueueItemState::NotDelivered {
            reason: QueueItemNotDeliveredReason::Failed {}
        }
    );
    let run_id = item.target_run_id.expect("the message names its run");
    assert_eq!(fixture.run_state(run_id), "failed");
    assert!(!fixture.queue.admission.is_admitting(run_id));
    let unavailable_ends: i64 = fixture
        .database
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM session_events
             WHERE type = 'agent.run.failed' AND instr(payload, ?1) > 0",
            ["provider process is not running"],
            |row| row.get(0),
        )
        .expect("the test reads the run's end");
    assert_eq!(unavailable_ends, 1);
}

// A run admitted while its session's process is coming back is bound on the leg the process came
// back on: the relaunch recorded during the settle is the leg the run's binding copies. Killed by
// opening the run's binding before the settle, which copies the leg the process left.
#[tokio::test]
async fn a_run_admitted_during_a_relaunch_is_bound_on_the_relaunched_leg() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    fixture.send().await.expect("the send is saved");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the first run starts");
    let [(first_run_id, _)] = calls.starts()[..] else {
        panic!("one run started: {:?}", calls.starts());
    };
    fixture.set_run_state(first_run_id, "completed");

    let settle = calls.settle_pause.arm();
    let item_id = fixture.send().await.expect("the send is saved");
    timeout(WAIT, settle.reached)
        .await
        .expect("the second start settles the process")
        .expect("the settle reports its arrival");
    let bindings = RuntimeBindingStore::new(
        Arc::new(DatabaseReadPool::new(
            fixture.database.path(),
            READ_STATEMENT_CAPACITY,
        )),
        Arc::clone(&fixture.log.writer),
    );
    bindings
        .record_relaunch(RuntimeBindingRelaunch {
            predecessor_id: fixture.run_binding_id(first_run_id),
            binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string())
                .expect("a UUID is a binding id"),
            resume_handle: "conversation-relaunched".to_owned(),
            spawned_version: spawned_build("1.0.1", "/opt/provider/bin"),
            left_conversations: Vec::new(),
        })
        .await
        .expect("the relaunch is recorded");
    settle.release.send(()).expect("the settle waits");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the second run starts");

    let second_run_id = fixture
        .stored_item(item_id)
        .target_run_id
        .expect("the message names its run");
    assert_eq!(calls.starts().len(), 2, "{:?}", calls.starts());
    assert_eq!(
        fixture.run_resume_handle(second_run_id),
        "conversation-relaunched"
    );
}
