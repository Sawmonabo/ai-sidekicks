//! The threads of a session's copies, a side question at rest, a hand-over's copy and a title
//! pass: where each copy's spend is filed, so an exported response on a copy's thread is filed
//! there with its sighting, which the usage record passes over where the copy's own stream filed
//! it first.

use std::collections::VecDeque;
use std::path::PathBuf;

use crate::driver::codex::session::side_questions::copy_turn::SessionUsageFiling;

/// How many copy threads one launch keeps the filing of; past it the oldest is let go.
const COPY_THREADS_KEPT: usize = 64;

/// One launch's copy threads, oldest first.
#[derive(Default)]
pub(crate) struct CodexCopyThreads {
    copies: VecDeque<CodexCopyThread>,
}

/// Where one copy's spend is filed: the session's filing and the folder its region is read for.
#[derive(Clone)]
pub(crate) struct CodexCopyThread {
    /// The copy's thread.
    pub(crate) thread_id: String,
    /// Where the copy's spend is filed.
    pub(crate) filing: SessionUsageFiling,
    /// The folder the copy ran in, whose region prices its spend.
    pub(crate) folder: PathBuf,
}

impl CodexCopyThreads {
    /// Registers the copy on `thread_id`, its spend filed through `filing` for `folder`.
    pub(crate) fn register(
        &mut self,
        thread_id: String,
        filing: SessionUsageFiling,
        folder: PathBuf,
    ) {
        if self.copies.len() >= COPY_THREADS_KEPT
            && let Some(let_go) = self.copies.pop_front()
        {
            tracing::debug!(
                conversation_id = let_go.thread_id.as_str(),
                "a codex launch keeps too many copies' threads; the oldest is let go"
            );
        }
        self.copies.push_back(CodexCopyThread {
            thread_id,
            filing,
            folder,
        });
    }

    /// The copy on `thread_id`, `None` where no copy holds the thread.
    pub(crate) fn copy_of(&self, thread_id: &str) -> Option<CodexCopyThread> {
        self.copies
            .iter()
            .find(|copy| copy.thread_id == thread_id)
            .cloned()
    }
}
