//! A paused run continued in a session no process holds since the daemon's restart: a lead's
//! session is opened before its driver is asked to continue it, and a helper whose lead is still
//! held, or a lead held behind a run waiting on the person, moves to running with no driver call,
//! its waiting messages kept for the lead's continue.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rusqlite::params;
use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::port::run_pause::SessionOpening;
use sidekicks_provider::run::turn_end::TurnOutcome;

use super::{WaitingMessages, fixture, waiting_message};
use crate::run::engine::test_fixture::insert_run;

// The continue opens the run's session before its driver's `resume_run`, which would otherwise
// find no live session. Killed by dropping the open (no opening seen at the driver's call).
#[tokio::test]
async fn a_paused_lead_in_an_unopened_session_is_opened_before_its_driver_is_called() {
    let messages = Arc::new(WaitingMessages::default());
    let seen = Arc::new(Mutex::new(None::<usize>));
    let mut driver = MockProviderDriver::new();
    let (counted, recorded) = (Arc::clone(&messages), Arc::clone(&seen));
    driver
        .expect_resume_run()
        .times(1)
        .returning(move |_params| {
            let openings = counted.openings.load(Ordering::SeqCst);
            *recorded.lock().expect("the openings read") = Some(openings);
            async { Ok(()) }.boxed()
        });
    let fixture = fixture(driver, "paused").await;

    let resumed = fixture.resume(1, messages.as_ref()).await;

    assert!(resumed.is_ok(), "{resumed:?}");
    assert_eq!(*seen.lock().expect("the openings read"), Some(1));
}

// A provider's helper the restart cut, whose session's opening is deferred under its held lead,
// moves to running with no driver call and its waiting message kept, not delivered. Killed by
// calling the driver anyway (`.times(0)` fails).
#[tokio::test]
async fn a_paused_helper_under_a_held_lead_moves_running_with_no_driver_call() {
    let mut driver = MockProviderDriver::new();
    driver.expect_resume_run().times(0);
    let fixture = fixture(driver, "paused").await;
    let lead_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_run(&fixture.database, fixture.session_id, lead_id, "running");
    fixture
        .database
        .reader()
        .execute(
            "UPDATE runs SET parent_run_id = ?2, reached_by = ?3 WHERE run_id = ?1",
            params![
                fixture.run_id.text().as_str(),
                lead_id.text().as_str(),
                <&'static str>::from(ChildRunProvenance::ProviderSubagent),
            ],
        )
        .expect("the test makes the run a helper");
    fixture
        .engine
        .record_daemon_turn_end(
            fixture.run_id,
            SafeInt::new(1).expect("the test's turn is a safe integer"),
            TurnOutcome::Interrupted(Some(TurnEndCause::DaemonRestart)),
        )
        .await
        .expect("the test ends the turn");
    let messages = WaitingMessages {
        opening: SessionOpening::Deferred,
        ..WaitingMessages::holding(waiting_message())
    };

    let resumed = fixture.resume(1, &messages).await;

    assert!(resumed.is_ok(), "{resumed:?}");
    assert_eq!(fixture.run().0, "running");
    assert_eq!(messages.kept_messages().len(), 1);
}

// A paused lead whose session's opening is deferred, a run beneath it waiting on the person, moves
// to running with no driver call, its waiting message kept for the continue the person's answer
// frees, and hands no continue to the queue now. Killed by calling the driver anyway (`.times(0)`
// fails, as does the driver's refusal of a session no process holds), by the message given back
// rather than kept, and by the lead's continue handed before the answer.
#[tokio::test]
async fn a_paused_lead_held_behind_a_waiting_helper_moves_running_with_no_driver_call() {
    let mut driver = MockProviderDriver::new();
    driver.expect_resume_run().times(0);
    let fixture = fixture(driver, "paused").await;
    let messages = WaitingMessages {
        opening: SessionOpening::Deferred,
        ..WaitingMessages::holding(waiting_message())
    };

    let resumed = fixture.resume(1, &messages).await;

    assert!(resumed.is_ok(), "{resumed:?}");
    assert_eq!(fixture.run().0, "running");
    assert_eq!(messages.kept_messages().len(), 1);
    assert_eq!(messages.releases.load(Ordering::SeqCst), 0);
    assert!(
        messages
            .held_lead_continues
            .lock()
            .expect("the continues read")
            .is_empty(),
        "the lead's continue was handed before the answer that frees it"
    );
}
