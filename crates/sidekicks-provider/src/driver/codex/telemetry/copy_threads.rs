//! The threads of a session's copies, a side question at rest, a hand-over's copy and a title
//! pass: each copy's filing and a ledger of what its own stream filed, so the export's twin of a
//! filed request is passed over and a request its stream never stated is filed once, after the
//! copy's read ended; a filed copy's ledger is kept a while for the export's late records.

use std::collections::VecDeque;
use std::path::PathBuf;

use tokio::time::Instant;

use crate::driver::codex::session::side_questions::copy_turn::SessionUsageFiling;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::exports::CODEX_EXPORT_INTERVAL;
use crate::driver::codex::telemetry::placement::refuse_unplaced;
use crate::driver::codex::telemetry::streamed_responses::CodexStreamedResponses;
use crate::pricing::export_status::INTERVALS_WAITED;
use crate::usage_delta_accountant::UsageAxisCounts;

/// How many copy threads one launch keeps live, and how many filed ones it keeps the ledger of;
/// past either the oldest is dropped, what a live one held refused.
const COPY_THREADS_KEPT: usize = 64;

/// One launch's copy threads, oldest first. What they hold unfiled is refused as they drop.
#[derive(Default)]
pub(crate) struct CodexCopyThreads {
    copies: VecDeque<CodexCopyThread>,
    // The filed copies' threads and the ledgers of what their streams filed, oldest first, which
    // a late record of the export is claimed against.
    filed: VecDeque<(String, CodexStreamedResponses)>,
}

// One copy's thread: where its spend is filed, what its stream filed, the exported responses
// its stream has not claimed, and when its read ended.
struct CodexCopyThread {
    thread_id: String,
    filing: SessionUsageFiling,
    folder: PathBuf,
    ledger: CodexStreamedResponses,
    unclaimed: Vec<CodexCompletedResponse>,
    ended_at: Option<Instant>,
}

/// A copy whose read ended two export intervals ago: its filing, the folder its region is read
/// for, and the exported responses its stream never stated, to be filed as the session's own.
pub(crate) struct CodexEndedCopy {
    /// Where the copy's spend is filed.
    pub(crate) filing: SessionUsageFiling,
    /// The folder the copy ran in, whose region prices its spend.
    pub(crate) folder: PathBuf,
    /// The responses its stream never stated.
    pub(crate) unclaimed: Vec<CodexCompletedResponse>,
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
            && let Some(dropped) = self.copies.pop_front()
        {
            refuse_unfiled(&dropped, "its launch keeps too many copies' threads");
        }
        self.copies.push_back(CodexCopyThread {
            thread_id,
            filing,
            folder,
            ledger: CodexStreamedResponses::default(),
            unclaimed: Vec::new(),
            ended_at: None,
        });
    }

    /// The copy on `thread_id` filed a request of `counts` from its own stream.
    pub(crate) fn filed(&mut self, thread_id: &str, counts: UsageAxisCounts) {
        if let Some(copy) = self.copy_mut(thread_id) {
            copy.ledger.record(thread_id, counts);
        }
    }

    /// Takes `response` where its thread is a copy's: passed over where the copy's stream filed
    /// it, else held until the copy's read ended; one on a filed copy's thread is passed over
    /// where its ledger claims it, else refused. Answers it back where its thread is no copy's.
    pub(crate) fn offer(
        &mut self,
        response: CodexCompletedResponse,
    ) -> Option<CodexCompletedResponse> {
        if let Some((_thread_id, ledger)) = self
            .filed
            .iter_mut()
            .find(|(thread_id, _ledger)| *thread_id == response.conversation_id)
        {
            if !ledger.claim(&response.conversation_id, &response.counts) {
                refuse_unplaced(
                    &response.conversation_id,
                    response.provider_account_id.clone(),
                    "it arrived after its copy's spend was filed",
                );
            }
            return None;
        }
        let Some(copy) = self.copy_mut(&response.conversation_id) else {
            return Some(response);
        };
        if !copy
            .ledger
            .claim(&response.conversation_id, &response.counts)
        {
            copy.unclaimed.push(response);
        }
        None
    }

    /// The copy on `thread_id`'s read ended at `now`.
    pub(crate) fn ended(&mut self, thread_id: &str, now: Instant) {
        if let Some(copy) = self.copy_mut(thread_id) {
            copy.ended_at = Some(now);
        }
    }

    /// When the earliest ended copy is due: two export intervals after its read ended.
    pub(crate) fn next_due(&self) -> Option<Instant> {
        self.copies.iter().filter_map(CodexCopyThread::due_at).min()
    }

    /// Takes every copy due at `now`, each response its stream claimed by then passed over, and
    /// keeps its ledger for the export's late records, the oldest let go past the bound.
    pub(crate) fn take_due(&mut self, now: Instant) -> Vec<CodexEndedCopy> {
        let (due, kept): (VecDeque<_>, VecDeque<_>) = std::mem::take(&mut self.copies)
            .into_iter()
            .partition(|copy| copy.due_at().is_some_and(|due_at| due_at <= now));
        self.copies = kept;
        let mut ended = Vec::with_capacity(due.len());
        for copy in due {
            let CodexCopyThread {
                thread_id,
                filing,
                folder,
                mut ledger,
                unclaimed,
                ..
            } = copy;
            let unclaimed = unclaimed
                .into_iter()
                .filter(|response| !ledger.claim(&thread_id, &response.counts))
                .collect();
            if self.filed.len() >= COPY_THREADS_KEPT
                && let Some((let_go, _ledger)) = self.filed.pop_front()
            {
                tracing::debug!(
                    conversation_id = let_go.as_str(),
                    "a codex launch keeps too many filed copies' threads; the oldest is let go"
                );
            }
            self.filed.push_back((thread_id, ledger));
            ended.push(CodexEndedCopy {
                filing,
                folder,
                unclaimed,
            });
        }
        ended
    }

    fn copy_mut(&mut self, thread_id: &str) -> Option<&mut CodexCopyThread> {
        self.copies
            .iter_mut()
            .find(|copy| copy.thread_id == thread_id)
    }
}

impl CodexCopyThread {
    // When the copy may be filed: two export intervals after its read ended.
    fn due_at(&self) -> Option<Instant> {
        self.ended_at
            .map(|ended_at| ended_at + CODEX_EXPORT_INTERVAL * INTERVALS_WAITED)
    }
}

impl Drop for CodexCopyThreads {
    // A launch that goes takes its copies with it, each unfiled response refused.
    fn drop(&mut self) {
        for copy in &self.copies {
            refuse_unfiled(copy, "its launch ended before its copy's spend was filed");
        }
    }
}

// Refuses each response `copy` holds unfiled, naming its thread and `reason`.
fn refuse_unfiled(copy: &CodexCopyThread, reason: &str) {
    for response in &copy.unclaimed {
        refuse_unplaced(
            &response.conversation_id,
            response.provider_account_id.clone(),
            reason,
        );
    }
}
