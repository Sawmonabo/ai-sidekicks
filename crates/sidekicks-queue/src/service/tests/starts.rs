//! A run's start waits for its session's process to settle before its binding is opened: within
//! the delivery timeout, and on the leg the process settled on; a send on a provider no driver
//! answers starts nothing and posts the session's `providerMissing` notice, unless the session is
//! closed; and a turn the daemon starts on a session not yet opened opens its process for its own
//! run, admitted on the session's bound account.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use rusqlite::params;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::run_control::{
    DaemonTurnBindingError, DaemonTurnBindingResolver as _, DaemonTurnProcess,
};
use sidekicks_provider::runtime_binding::store::{RuntimeBindingRelaunch, RuntimeBindingStore};
use sidekicks_provider::runtime_binding::test_store::spawned_build;
use sidekicks_session::queue_store::RecordedQueueItemState;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use tokio::time::timeout;

use super::{DriverCalls, Fixture, READ_STATEMENT_CAPACITY, WAIT, fixture, recording_driver};
use crate::admission::QUEUE_DELIVERY_TIMEOUT;
use crate::error::QueueError;
use crate::provider_session::errors::ProviderSessionError;
use crate::provider_session::test_opening::read_provider_missing_notices;

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
// never handed the run, the run fails `provider.unavailable` in the daemon's own words, its message
// reads not delivered and its place at the gate is given back. Killed by a settle waited on with
// no bound, and by the timer's own text in the run's end. The clock is paused only to step past
// the bound, as the store's writes run on threads of their own.
#[tokio::test]
async fn a_process_that_never_settles_fails_the_start_after_the_delivery_timeout() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    // Held and never released: the session's process stays on its way back.
    let never_settled = calls.settle_pause.arm();

    let item_id = fixture.send().await.expect("the send is saved");
    timeout(WAIT, never_settled.reached)
        .await
        .expect("the start settles the process")
        .expect("the settle reports its arrival");
    tokio::time::pause();
    tokio::time::advance(QUEUE_DELIVERY_TIMEOUT).await;
    tokio::time::resume();
    timeout(WAIT, fixture.queue.stop())
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
    let ends: Vec<String> = fixture
        .database
        .reader()
        .prepare("SELECT payload FROM session_events WHERE type = 'agent.run.failed'")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()
        })
        .expect("the test reads the run's end");
    let [end] = ends.as_slice() else {
        panic!("the run ends failed once: {ends:?}");
    };
    assert!(end.contains("provider process is not running"), "{end}");
    assert!(
        !end.contains("elapsed"),
        "the timer's words reach no one: {end}"
    );
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
        .record_relaunch(
            RuntimeBindingRelaunch {
                predecessor_id: fixture.run_binding_id(first_run_id),
                binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string())
                    .expect("a UUID is a binding id"),
                resume_handle: "conversation-relaunched".to_owned(),
                spawned_version: spawned_build("1.0.1", "/opt/provider/bin"),
                left_conversations: Vec::new(),
            },
            Vec::new(),
        )
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

// A send to a session whose lead runs on a provider no driver answers is refused
// `provider.notFound` once one `providerMissing` notice naming that provider is posted, and starts
// nothing. Killed by the admission refusing without posting, and by the notice posted twice.
#[tokio::test]
async fn a_send_on_a_provider_with_no_driver_posts_one_notice_and_is_refused() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    fixture
        .database
        .reader()
        .execute(
            "UPDATE session_events
                SET payload = json_set(payload, '$.mainAgent.binding.providerName', 'unregistered')
              WHERE type = 'session.created'",
            [],
        )
        .expect("the lead moves to a provider no driver answers");

    let sent = timeout(WAIT, fixture.send())
        .await
        .expect("the send answers");
    fixture.queue.stop().await;

    assert!(
        matches!(
            &sent,
            Err(QueueError::ProviderSession(ProviderSessionError::Provider(refusal)))
                if refusal.code == RefusalCode::ProviderNotFound
        ),
        "{sent:?}"
    );
    assert_eq!(
        read_provider_missing_notices(&fixture.database.reader()),
        vec![SessionNotice::ProviderMissing {
            session_id: fixture.session_id,
            provider: ProviderId::new("unregistered".to_owned()).expect("a provider id"),
            place: None,
        }]
    );
    assert_eq!(calls.starts(), Vec::new());
}

// A send to a closed session whose provider no driver answers is refused as closed, and posts no
// notice into the closed session's history. Killed by the admission running before the state's
// refusal.
#[tokio::test]
async fn a_send_to_a_closed_session_on_a_missing_provider_posts_no_notice() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let reader = fixture.database.reader();
    reader
        .execute(
            "UPDATE session_events
                SET payload = json_set(payload, '$.mainAgent.binding.providerName', 'unregistered')
              WHERE type = 'session.created'",
            [],
        )
        .expect("the lead moves to a provider no driver answers");
    reader
        .execute(
            "UPDATE sessions SET state = ?2 WHERE id = ?1",
            params![
                fixture.session_id.text().as_str(),
                <&'static str>::from(SessionState::Closed)
            ],
        )
        .expect("the session is closed");
    drop(reader);

    let sent = timeout(WAIT, fixture.send())
        .await
        .expect("the send answers");
    fixture.queue.stop().await;

    assert!(
        matches!(
            &sent,
            Err(QueueError::Refused(refusal)) if refusal.code == RefusalCode::SessionAlreadyClosed
        ),
        "{sent:?}"
    );
    assert_eq!(
        read_provider_missing_notices(&fixture.database.reader()),
        Vec::new()
    );
    assert_eq!(calls.starts(), Vec::new());
}

// A turn the daemon starts on a session this daemon never opened creates the session's process for
// that turn's run once, after its run took a place at the memory gate, which it keeps; the run's
// binding is the one the create recorded; a live-only turn there opens nothing and answers that the
// session has no process. Killed by binding the turn without opening the session first, which
// refuses a session not yet opened, by opening it outside the gate, and by a live-only turn
// opening the process.
#[tokio::test]
async fn a_daemon_turn_on_a_session_not_yet_opened_creates_its_process() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("queued").await;

    let live_only = timeout(
        WAIT,
        fixture.queue.admission().open_daemon_turn_binding(
            run_id,
            fixture.session_id,
            DaemonTurnProcess::LiveOnly,
        ),
    )
    .await
    .expect("the live-only binding answers in time");
    assert!(
        matches!(
            live_only,
            Err(DaemonTurnBindingError::NoProviderSession { .. })
        ),
        "{live_only:?}"
    );
    assert_eq!(calls.creates.load(Ordering::SeqCst), 0);

    let binding = timeout(
        WAIT,
        fixture.queue.admission().open_daemon_turn_binding(
            run_id,
            fixture.session_id,
            DaemonTurnProcess::OpenWhenAbsent,
        ),
    )
    .await
    .expect("the binding opens in time")
    .expect("the session opens for the turn");

    assert!(
        fixture
            .queue
            .provider_sessions
            .is_opened(fixture.session_id)
    );
    assert_eq!(calls.creates.load(Ordering::SeqCst), 1);
    assert!(fixture.queue.admission.is_admitting(run_id));
    assert_eq!(binding.binding_id, fixture.run_binding_id(run_id));
}

// A turn the daemon starts on a session closed before its process opened is refused as the open
// refuses it, `session.alreadyClosed`, and creates nothing. Killed by the open's refusal answered
// as a binding not recorded, which the client reads as a fault.
#[tokio::test]
async fn a_daemon_turn_on_a_closed_session_is_refused_as_its_open_refuses_it() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("queued").await;
    fixture
        .database
        .reader()
        .execute(
            "UPDATE sessions SET state = ?2 WHERE id = ?1",
            params![
                fixture.session_id.text().as_str(),
                <&'static str>::from(SessionState::Closed)
            ],
        )
        .expect("the session is closed");

    let opened = timeout(
        WAIT,
        fixture.queue.admission().open_daemon_turn_binding(
            run_id,
            fixture.session_id,
            DaemonTurnProcess::OpenWhenAbsent,
        ),
    )
    .await
    .expect("the open answers in time");

    assert!(
        matches!(
            &opened,
            Err(DaemonTurnBindingError::Refused { refusal, .. })
                if refusal.code == RefusalCode::SessionAlreadyClosed
        ),
        "{opened:?}"
    );
    assert_eq!(calls.creates.load(Ordering::SeqCst), 0);
}

// A turn the daemon starts on a session with no process is admitted against the account the
// session is bound to, at the posture its process opens at on that account. Killed by admitting it
// against the provider's current account instead.
#[tokio::test]
async fn a_daemon_turn_is_admitted_on_the_sessions_bound_account() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let bound = ProviderAccountId::new("account-bound".to_owned()).expect("a test account id");
    fixture
        .database
        .reader()
        .execute(
            "UPDATE session_events
                SET payload = json_set(payload, '$.mainAgent.binding.providerAccountId', ?1)
              WHERE type = 'session.created'",
            [bound.as_str()],
        )
        .expect("the lead is bound to an account other than the current one");

    let admission = fixture
        .queue
        .admission()
        .admit_daemon_turn(fixture.session_id)
        .await
        .expect("the turn is admitted");

    let posture = fixture
        .queue
        .provider_sessions
        .read_execution_posture(fixture.session_id, bound.clone())
        .await
        .expect("the posture reads");
    assert_eq!(admission.admitted_provider_account_id, bound);
    assert_eq!(admission.execution_posture, posture);
}
