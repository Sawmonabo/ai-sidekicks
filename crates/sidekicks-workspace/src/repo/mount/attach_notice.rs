//! The notice that a project's folder changed: raised when a project's mount is attached, and when
//! a re-attach or a move gives a project a new mount, so a reader of the projects' roots reads
//! them again.

use tokio::sync::Notify;

/// Raised each time a project's mount is attached or replaced; a raise no one waits for is kept
/// for the next wait, and raises meanwhile settle one wait.
#[derive(Debug, Default)]
pub struct ProjectAttachNotice {
    raised: Notify,
}

impl ProjectAttachNotice {
    /// Raises the notice for its waiter, or for the next wait where none waits.
    pub(crate) fn raise(&self) {
        self.raised.notify_one();
    }

    /// Settles once the notice was raised since the last wait settled, at once when it was
    /// raised with no one waiting.
    pub async fn wait(&self) {
        self.raised.notified().await;
    }
}
