//! A session that closed or is being deleted: an opening, a wake, a restart, a run binding or a
//! level change is refused under its hold and no process comes up; a session deleted takes no
//! `providerMissing` notice.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};

use futures::FutureExt as _;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_session::idle_sleep::openings::SessionProcessWaker;
use tokio::sync::Notify;
use tokio::time::timeout;

use sidekicks_provider::driver::contract::error::DriverError;

use super::{CLOSE_HELD, Opening, WAIT, unresolvable_provider};
use crate::provider_session::errors::ProviderSessionError;
use crate::provider_session::test_opening::read_provider_missing_notices;

// A run admitted before a close, whose open waits out the close, and an idle sleep's wake that
// waits it out too, are refused once the close's `session.closed` is written, and no process comes
// up for the closed session. Killed by the open or the wake no longer reading the session's state
// (the conversation resumes after the close), and by the close letting the session's transition
// lock go before it writes the event, or the opening or the wake taking a lock of its own (the
// resume lands while the event's write is held).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_open_or_a_wake_waiting_out_a_close_is_refused_and_starts_no_process() {
    let resumes = Arc::new(AtomicUsize::new(0));
    let resumed = Arc::new(Notify::new());
    let closing = Arc::new(Notify::new());
    let (release_close, close_released) = mpsc::channel::<()>();
    let close_released = Mutex::new(close_released);
    let opening = Opening::new(
        Box::new({
            let resumes = Arc::clone(&resumes);
            let resumed = Arc::clone(&resumed);
            move |_| {
                resumes.fetch_add(1, Ordering::SeqCst);
                resumed.notify_one();
            }
        }),
        Box::new({
            let closing = Arc::clone(&closing);
            move || {
                closing.notify_one();
                // Held on a worker the runtime hands its other tasks off from.
                tokio::task::block_in_place(|| {
                    close_released
                        .lock()
                        .expect("the release's lock holds")
                        .recv()
                        .expect("the test releases the close");
                });
            }
        }),
        |_, _| {},
    )
    .await;
    let session_id = opening.session_id;
    let run_id = opening.run_id;

    let close = tokio::spawn({
        let changes = Arc::clone(&opening.changes);
        async move { changes.close(session_id).await }
    });
    closing.notified().await;
    let open = tokio::spawn({
        let sessions = Arc::clone(&opening.sessions);
        async move { sessions.open(session_id, run_id).await }
    });
    let wake = tokio::spawn({
        let sessions = Arc::clone(&opening.sessions);
        async move { sessions.wake_process(session_id).await }
    });
    assert!(
        timeout(CLOSE_HELD, resumed.notified()).await.is_err(),
        "the resume waits while the close's event is held"
    );
    release_close
        .send(())
        .expect("the close waits for its release");

    timeout(WAIT, close)
        .await
        .expect("the close ends")
        .expect("the close's task ends whole")
        .expect("the session closes");
    let opened = timeout(WAIT, open)
        .await
        .expect("the open ends")
        .expect("the open's task ends whole");
    assert!(
        matches!(
            opened,
            Err(ProviderSessionError::Closed { session_id: refused }) if refused == session_id
        ),
        "the open is refused for the closed session: {opened:?}"
    );
    let woken = timeout(WAIT, wake)
        .await
        .expect("the wake ends")
        .expect("the wake's task ends whole");
    assert!(
        woken.as_ref().is_err_and(|error| matches!(
            error.downcast_ref::<ProviderSessionError>(),
            Some(ProviderSessionError::Closed { session_id: refused }) if *refused == session_id
        )),
        "the wake is refused for the closed session: {woken:?}"
    );
    assert_eq!(
        resumes.load(Ordering::SeqCst),
        0,
        "no process comes up for the closed session"
    );
}

// A closed session and one being deleted take no process, no restart, no run binding and no level
// change: each is refused under the session's hold and no process comes up. Killed by any of the
// four paths no longer reading the session's state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ended_session_is_refused_an_opening_a_restart_a_binding_and_a_level_change() {
    for state in [SessionState::Closed, SessionState::PurgeRequested] {
        let resumes = Arc::new(AtomicUsize::new(0));
        let opening = Opening::new(
            Box::new({
                let resumes = Arc::clone(&resumes);
                move |_| {
                    resumes.fetch_add(1, Ordering::SeqCst);
                }
            }),
            Box::new(|| {}),
            |_, _| {},
        )
        .await;
        let session_id = opening.session_id;
        let run_id = opening.run_id;
        opening
            .database
            .reader()
            .execute(
                "UPDATE sessions SET state = ?1 WHERE id = ?2",
                [<&'static str>::from(state), session_id.text().as_str()],
            )
            .expect("the session's state is stored");
        let refused = |answer: &ProviderSessionError| match state {
            SessionState::Closed => matches!(
                answer,
                ProviderSessionError::Closed { session_id: refused } if *refused == session_id
            ),
            SessionState::PurgeRequested => matches!(
                answer,
                ProviderSessionError::BeingDeleted { session_id: refused } if *refused == session_id
            ),
            SessionState::Provisioning | SessionState::Active | SessionState::Archived => false,
        };
        let opened = opening.sessions.open(session_id, run_id).await;
        assert!(
            opened.as_ref().is_err_and(refused),
            "the open is refused for the {state:?} session: {opened:?}"
        );
        let restarted = opening.sessions.restart(session_id).await;
        assert!(
            restarted.as_ref().is_err_and(refused),
            "the restart is refused for the {state:?} session: {restarted:?}"
        );
        let bound = opening.sessions.open_run_binding(run_id, session_id).await;
        assert!(
            bound.as_ref().is_err_and(refused),
            "the binding is refused for the {state:?} session: {bound:?}"
        );
        let changed = opening
            .sessions
            .change_level(session_id, PermissionLevel::Readonly)
            .await;
        assert!(
            changed.as_ref().is_err_and(refused),
            "the level change is refused for the {state:?} session: {changed:?}"
        );
        assert_eq!(
            resumes.load(Ordering::SeqCst),
            0,
            "no process comes up for the {state:?} session"
        );
    }
}

// A start on a session deleted, its directory row gone, whose provider is not installed posts no
// `providerMissing` notice and still fails as its driver failed it. Killed by the session's
// existence check dropped from the notice's write (the notice lands for a session gone), and by a
// session gone counted a failure of the post (the start answers that in place of its own).
#[tokio::test]
async fn a_deleted_session_takes_no_provider_missing_notice() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        driver
            .expect_create_session()
            .returning(|_params| async { Err(unresolvable_provider(false)) }.boxed());
    })
    .await;
    let reader = opening.database.reader();
    reader
        .execute("DELETE FROM runtime_bindings", [])
        .expect("the session is left with no conversation");
    reader
        .execute(
            "DELETE FROM sessions WHERE id = ?1",
            [opening.session_id.text().as_str()],
        )
        .expect("the session's directory row is deleted");

    let opened = opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await;

    assert!(
        matches!(
            &opened,
            Err(ProviderSessionError::Driver(
                DriverError::ExecutableUnresolvable(_)
            ))
        ),
        "{opened:?}"
    );
    assert_eq!(
        read_provider_missing_notices(&opening.database.reader()),
        Vec::new()
    );
}
