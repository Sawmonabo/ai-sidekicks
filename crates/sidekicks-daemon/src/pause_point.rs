//! A point where a test holds one call, so a second call meets the state the first left there,
//! inside a lock or outside any, whatever the scheduler does.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};

use tokio::sync::oneshot;

/// The armed holds, in the order they were armed: each call that reaches the point takes the
/// oldest, reports on its `reached` and waits for the `Answer` its `release` sends; a call that
/// finds none passes.
pub(crate) struct PausePoint<Answer = ()> {
    armed: Mutex<VecDeque<(oneshot::Sender<()>, oneshot::Receiver<Answer>)>>,
}

impl<Answer> Default for PausePoint<Answer> {
    fn default() -> Self {
        Self {
            armed: Mutex::new(VecDeque::new()),
        }
    }
}

/// The test's ends of an armed hold.
pub(crate) struct ArmedPause<Answer = ()> {
    /// Answers once a call is held at the point.
    pub(crate) reached: oneshot::Receiver<()>,
    /// Lets the held call go on with its answer.
    pub(crate) release: oneshot::Sender<Answer>,
}

impl<Answer> PausePoint<Answer> {
    /// Arms one more hold, for the first call to reach the point after the holds armed before it.
    pub(crate) fn arm(&self) -> ArmedPause<Answer> {
        let (reached_sender, reached) = oneshot::channel();
        let (release, released) = oneshot::channel();
        self.armed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push_back((reached_sender, released));
        ArmedPause { reached, release }
    }

    /// Holds the call here when a hold is armed, until the test releases it, and answers what the
    /// test sent; `None` when no hold was armed.
    pub(crate) async fn pass(&self) -> Option<Answer> {
        let released = self.reach()?;
        Some(released.await.expect("the test releases the held call"))
    }

    /// [`PausePoint::pass`] for a call on a blocking thread, such as a read on the pool's thread.
    pub(crate) fn pass_blocking(&self) -> Option<Answer> {
        let released = self.reach()?;
        Some(
            released
                .blocking_recv()
                .expect("the test releases the held call"),
        )
    }

    // Takes the oldest armed hold and reports the call there; `None` when no hold was armed.
    fn reach(&self) -> Option<oneshot::Receiver<Answer>> {
        let (reached, released) = self
            .armed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()?;
        reached
            .send(())
            .expect("the test waits for the call to arrive");
        Some(released)
    }
}
