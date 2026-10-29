//! `Allow once` presses on a recorded block: sent to the blocked run's provider once, refused
//! before the driver where they must be, held while unanswered, and kept across a restart.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::approval::{ApprovalDenialOverrideRequest, ReviewerDenialId};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::{DriverError, MockProviderDriver};
use sidekicks_provider::driver::error_causes::unanswered;
use sidekicks_provider::port::reviewer_denial::ReviewerDenialPort as _;
use sidekicks_store::database::writer::test_file::test_session_id;

use super::{ANSWER_WAIT, Fixture, PROVIDER_RECORD};
use crate::reviewer_denials::{DenialOverrideError, ReviewerDenials};

/// A driver whose override answers each call with the next of `answers`, counting its calls.
fn driver_answering(
    calls: &Arc<AtomicUsize>,
    answers: impl Fn(usize) -> Result<(), DriverError> + Send + Sync + 'static,
) -> MockProviderDriver {
    let calls = Arc::clone(calls);
    let mut driver = MockProviderDriver::new();
    driver.expect_override_denial().returning(move |_| {
        let answer = answers(calls.fetch_add(1, Ordering::SeqCst));
        async move { answer }.boxed()
    });
    driver
}

/// The code of a refusal; `None` for any other failure.
fn refusal_code(error: DenialOverrideError) -> Option<RefusalCode> {
    if let DenialOverrideError::Refused(refusal) = error {
        Some(refusal.code)
    } else {
        None
    }
}

/// A driver whose one override pushes the run and the provider's record it was handed to
/// `handed`.
fn driver_recording(handed: &Arc<Mutex<Vec<(RunId, String)>>>) -> MockProviderDriver {
    let handed = Arc::clone(handed);
    let mut driver = MockProviderDriver::new();
    driver
        .expect_override_denial()
        .times(1)
        .returning(move |params| {
            handed
                .lock()
                .expect("the test's list locks")
                .push((params.run_id, params.provider_denial.get().to_owned()));
            async { Ok(()) }.boxed()
        });
    driver
}

// Two presses, at once and in turn, hand the block to the provider once, and every answer carries
// the first press's instant. Killed by dropping the earlier override's read, and by dropping the
// press hold.
#[tokio::test]
async fn presses_on_one_block_send_it_once_and_answer_the_first_instant() {
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture::new(
        driver_answering(&calls, |_| Ok(())),
        MockProviderDriver::new(),
    )
    .await;
    let denial_id = fixture.recorded_block().await;

    let (first, second) = tokio::join!(fixture.press(denial_id), fixture.press(denial_id));
    let third = fixture.press(denial_id).await;

    let first = first.expect("the press is allowed");
    assert_eq!(second.expect("the press is allowed"), first);
    assert_eq!(third.expect("the press is allowed"), first);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.overrides(), vec![first.as_str().to_owned()]);
}

/// A press refused before the driver is called.
#[derive(Clone, Copy, Debug)]
enum RefusedPress {
    /// The session is unknown.
    UnknownSession,
    /// The session holds no such block.
    UnknownBlock,
    /// The provider lets no person overrule the block.
    NotOverridable,
    /// The session has closed.
    ClosedSession,
}

// A press is refused in order, the driver never called and nothing recorded. Killed by any check
// dropped or moved after the driver's call.
#[rstest]
#[case::unknown_session(RefusedPress::UnknownSession, RefusalCode::SessionNotFound)]
#[case::unknown_block(RefusedPress::UnknownBlock, RefusalCode::ApprovalDenialNotFound)]
#[case::not_overridable(
    RefusedPress::NotOverridable,
    RefusalCode::ApprovalDenialNotOverridable
)]
#[case::closed_session(RefusedPress::ClosedSession, RefusalCode::SessionAlreadyClosed)]
#[tokio::test]
async fn a_refused_press_never_reaches_the_driver(
    #[case] press: RefusedPress,
    #[case] code: RefusalCode,
) {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    fixture.open_call(fixture.run_id, "call-1").await;
    let mut block = fixture.block(fixture.run_id, "call-1");
    block.is_overridable = !matches!(press, RefusedPress::NotOverridable);
    fixture.take(block).await.expect("the block is recorded");
    let mut session_id = fixture.session_id;
    let mut denial_id = fixture.denial_id();
    match press {
        RefusedPress::UnknownSession => session_id = test_session_id(),
        RefusedPress::UnknownBlock => {
            denial_id = ReviewerDenialId::try_from(mint_uuid_v7()).expect("a block id");
        }
        RefusedPress::NotOverridable => {}
        RefusedPress::ClosedSession => close_session(&fixture),
    }

    let refused = tokio::time::timeout(
        ANSWER_WAIT,
        fixture
            .denials
            .override_denial(&ApprovalDenialOverrideRequest {
                session_id,
                denial_id,
            }),
    )
    .await
    .expect("the press is answered")
    .expect_err("the press is refused");

    assert_eq!(refusal_code(refused), Some(code));
    assert_eq!(fixture.overrides(), Vec::<String>::new());
}

fn close_session(fixture: &Fixture) {
    fixture
        .database
        .reader()
        .execute(
            "UPDATE sessions SET state = 'closed' WHERE id = ?1",
            [fixture.session_id.text().as_str()],
        )
        .expect("the test closes the session");
}

// A block already allowed answers its settled override in a closed session, since the earlier
// override is read before the session's state. Killed by checking the session first.
#[tokio::test]
async fn an_allowed_block_answers_its_override_after_its_session_closes() {
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture::new(
        driver_answering(&calls, |_| Ok(())),
        MockProviderDriver::new(),
    )
    .await;
    let denial_id = fixture.recorded_block().await;
    let allowed = fixture
        .press(denial_id)
        .await
        .expect("the press is allowed");

    close_session(&fixture);

    assert_eq!(fixture.press(denial_id).await.expect("it answers"), allowed);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// How the driver answers the first press.
#[derive(Clone, Copy, Debug)]
enum FirstAnswer {
    /// It refuses; the next press sends again.
    Refused,
    /// No answer came; the press is held until the process it went to ends.
    Unanswered,
    /// No answer came because the process it went to ended first; the next press sends again.
    UnansweredAfterItsProcessEnded,
}

// A refused press records nothing and the next one sends again; an unanswered one answers its
// refusal again and sends nothing until the process it went to has ended, however the release and
// the answer are ordered, and the press after that sends and is recorded. Killed by recording on a
// refusal, by a held press that sends again, by a hold the process's end does not release, by a
// release that reaches another binding's hold, and by a hold written after an earlier release.
#[rstest]
#[case::refused(FirstAnswer::Refused)]
#[case::unanswered(FirstAnswer::Unanswered)]
#[case::unanswered_after_its_process_ended(FirstAnswer::UnansweredAfterItsProcessEnded)]
#[tokio::test]
async fn a_press_the_driver_did_not_take_records_nothing(#[case] first: FirstAnswer) {
    let calls = Arc::new(AtomicUsize::new(0));
    let service: Arc<OnceLock<(Weak<ReviewerDenials>, RuntimeBindingId)>> = Arc::default();
    let ended_process = Arc::clone(&service);
    let fixture = Fixture::new(
        driver_answering(&calls, move |call| match (call, first) {
            (0, FirstAnswer::Refused) => Err(DriverError::Refused(DomainError::new(
                "the provider refused",
                RefusalCode::ProviderUnavailable,
            ))),
            (0, FirstAnswer::Unanswered) => Err(unanswered()),
            (0, FirstAnswer::UnansweredAfterItsProcessEnded) => {
                // The process's exit is reported before its pending request fails.
                let (denials, binding_id) = ended_process.get().expect("the service is set");
                denials
                    .upgrade()
                    .expect("the service is running")
                    .release_held_presses(binding_id);
                Err(unanswered())
            }
            _ => Ok(()),
        }),
        MockProviderDriver::new(),
    )
    .await;
    service
        .set((Arc::downgrade(&fixture.denials), fixture.binding_id.clone()))
        .expect("the service is set once");
    let denial_id = fixture.recorded_block().await;

    let refused = fixture.press(denial_id).await.expect_err("the press fails");
    match first {
        FirstAnswer::Refused => {
            assert!(matches!(refused, DenialOverrideError::Driver(_)));
        }
        FirstAnswer::Unanswered => {
            assert_eq!(refusal_code(refused), Some(RefusalCode::ProviderTimeout));
            fixture.denials.release_held_presses(
                &RuntimeBindingId::new("another-binding".to_owned()).expect("a binding id"),
            );
            let held = fixture
                .press(denial_id)
                .await
                .expect_err("the press is held");
            assert_eq!(refusal_code(held), Some(RefusalCode::ProviderTimeout));
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            fixture.denials.release_held_presses(&fixture.binding_id);
        }
        FirstAnswer::UnansweredAfterItsProcessEnded => {
            assert_eq!(refusal_code(refused), Some(RefusalCode::ProviderTimeout));
        }
    }
    assert_eq!(fixture.overrides(), Vec::<String>::new());

    let allowed = fixture
        .press(denial_id)
        .await
        .expect("the press is allowed");

    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.overrides(), vec![allowed.as_str().to_owned()]);
}

// A press the provider took whose record failed is recorded by the next press at the first press's
// instant, and the provider is not told again, even once its process has ended. Killed by a failed
// record that holds nothing, by a process's end that drops it, and by an instant taken at the
// second press.
#[tokio::test]
async fn a_taken_press_whose_record_failed_is_recorded_by_the_next() {
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture::new(
        driver_answering(&calls, |_| Ok(())),
        MockProviderDriver::new(),
    )
    .await;
    let denial_id = fixture.recorded_block().await;
    let refuse_overrides = "CREATE TRIGGER refuse_override BEFORE INSERT ON session_events
       WHEN NEW.type = 'approval.denial.overridden'
       BEGIN SELECT RAISE(ABORT, 'the test refuses the override'); END";
    fixture
        .database
        .reader()
        .execute(refuse_overrides, [])
        .expect("the test refuses overrides");

    let before = WireInstant::now();
    fixture
        .press(denial_id)
        .await
        .expect_err("the record fails");
    let after = WireInstant::now();
    fixture
        .database
        .reader()
        .execute("DROP TRIGGER refuse_override", [])
        .expect("the test lets overrides through");
    tokio::time::sleep(Duration::from_millis(5)).await;
    fixture.denials.release_held_presses(&fixture.binding_id);

    let allowed = fixture
        .press(denial_id)
        .await
        .expect("the press is allowed");

    assert!(before.as_str() <= allowed.as_str() && allowed.as_str() <= after.as_str());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.overrides(), vec![allowed.as_str().to_owned()]);
}

// The press reaches the driver of the provider the blocked run runs on, not the first provider,
// with that run and the provider's whole record as it was taken. Killed by resolving any other
// provider, and by handing back anything but the stored record.
#[tokio::test]
async fn a_press_reaches_the_blocked_runs_own_provider_with_the_whole_record() {
    let handed: Arc<Mutex<Vec<(RunId, String)>>> = Arc::default();
    let fixture = Fixture::new(MockProviderDriver::new(), driver_recording(&handed)).await;
    let helper_run = fixture.queue_run().await;
    fixture
        .database
        .reader()
        .execute(
            "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
               cli_version_raw, created_at, updated_at)
             VALUES ('helper-binding', ?1, ?2, '1.0.0', '1.0.0', '', '')",
            params![helper_run.text().as_str(), PROVIDERS[1].id],
        )
        .expect("the test binds the helper's run to the second provider");
    fixture.open_call(helper_run, "call-1").await;
    fixture
        .take(fixture.block(helper_run, "call-1"))
        .await
        .expect("the block is recorded");

    fixture
        .press(fixture.denial_id())
        .await
        .expect("the press is allowed");

    assert_eq!(
        *handed.lock().expect("the test's list locks"),
        vec![(helper_run, PROVIDER_RECORD.to_owned())]
    );
}

// A block that names no call is recorded as it arrives, with no row of a call, even on a run that
// has ended, and `Allow once` answers it as it does a call's block. Killed by a call-less block
// that waits for a row or is refused at its run's end.
#[tokio::test]
async fn a_block_that_names_no_call_is_recorded_at_once_and_allowed_once() {
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture::new(
        driver_answering(&calls, |_| Ok(())),
        MockProviderDriver::new(),
    )
    .await;
    fixture
        .database
        .reader()
        .execute(
            "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
            [fixture.run_id.text().as_str()],
        )
        .expect("the test ends the run");
    let mut block = fixture.block(fixture.run_id, "unused");
    block.tool_call_id = None;

    fixture.take(block).await.expect("the block is recorded");
    let event_id: Option<String> = fixture
        .database
        .reader()
        .query_row(
            "SELECT json_extract(payload, '$.eventId') FROM session_events
             WHERE type = 'approval.reviewer.denied'",
            [],
            |row| row.get(0),
        )
        .expect("the test reads the block");
    let allowed = fixture
        .press(fixture.denial_id())
        .await
        .expect("the press is allowed");

    assert_eq!(event_id, None);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.overrides(), vec![allowed.as_str().to_owned()]);
}

// A block recorded before the daemon restarts is allowed by the service its next start builds,
// which hands the driver the blocked run and the provider's whole record. Killed by a press that
// reads the block from what the stopped service held in memory.
#[tokio::test]
async fn a_block_recorded_before_a_restart_is_allowed_after_it_with_the_whole_record() {
    let mut fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let denial_id = fixture.recorded_block().await;
    let handed: Arc<Mutex<Vec<(RunId, String)>>> = Arc::default();

    fixture.restart(driver_recording(&handed), MockProviderDriver::new());
    let allowed = fixture
        .press(denial_id)
        .await
        .expect("the press is allowed");

    assert_eq!(
        *handed.lock().expect("the test's list locks"),
        vec![(fixture.run_id, PROVIDER_RECORD.to_owned())]
    );
    assert_eq!(fixture.overrides(), vec![allowed.as_str().to_owned()]);
}
