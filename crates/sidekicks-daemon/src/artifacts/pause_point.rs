//! A point inside a critical section where a test holds one call, so a second call meets the
//! section while the first is inside it, whatever the scheduler does. Compiled into test builds
//! only.

use std::sync::{Mutex, PoisonError};

use tokio::sync::oneshot;

/// One armed hold: the call that reaches the point first reports on `reached` and waits for
/// `release`; every other call passes.
#[derive(Default)]
pub(crate) struct PausePoint {
    armed: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
}

/// The test's ends of an armed hold.
pub(crate) struct ArmedPause {
    /// Answers once a call is held at the point.
    pub(crate) reached: oneshot::Receiver<()>,
    /// Lets the held call go on.
    pub(crate) release: oneshot::Sender<()>,
}

impl PausePoint {
    /// Arms the point for the next call to reach it.
    pub(crate) fn arm(&self) -> ArmedPause {
        let (reached_sender, reached) = oneshot::channel();
        let (release, released) = oneshot::channel();
        *self.armed.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((reached_sender, released));
        ArmedPause { reached, release }
    }

    /// Holds the call here when the point is armed, until the test releases it.
    pub(crate) async fn pass(&self) {
        let armed = self
            .armed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some((reached, released)) = armed {
            reached
                .send(())
                .expect("the test waits for the call to arrive");
            released.await.expect("the test releases the held call");
        }
    }
}
