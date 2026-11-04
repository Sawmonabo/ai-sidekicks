//! A paused lead continued in a session no process holds since the daemon's restart: the session
//! is opened before the run's driver is asked to continue it.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use sidekicks_provider::driver::contract::MockProviderDriver;

use super::{WaitingMessages, fixture};

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
