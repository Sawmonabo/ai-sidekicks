//! Which session each conversation on one Codex service belongs to. Every frame and server request
//! a service sends names its thread, so this is where a shared service's traffic is told apart: a
//! session's own thread, and every child thread a helper opened beneath it.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;

use sidekicks_std::mutex_lock::lock;

/// A frame the service sent, held while a start or fork that may claim its thread is in flight.
#[derive(Clone, Debug)]
pub(crate) struct CodexHeldThreadFrame {
    /// The frame's method.
    pub(crate) method: String,
    /// The frame's params, as the service sent them.
    pub(crate) params: Box<RawValue>,
    /// The thread the frame names.
    pub(crate) thread_id: String,
}

impl PartialEq for CodexHeldThreadFrame {
    fn eq(&self, other: &Self) -> bool {
        self.method == other.method
            && self.params.get() == other.params.get()
            && self.thread_id == other.thread_id
    }
}

/// Where the frames no claim took go once the last open claim closes: the supervisor reports
/// each as unrouted. It is called only with a non-empty list, and never under the index's lock.
pub(crate) type UnclaimedThreadFrameReport = Arc<dyn Fn(Vec<CodexHeldThreadFrame>) + Send + Sync>;

/// What became of a frame offered to the hold.
#[derive(Debug, PartialEq)]
pub(crate) enum CodexThreadFrameHold {
    /// No claim is open, so the frame is handed back for the caller to report.
    NotHeld(CodexHeldThreadFrame),
    /// The frame is held.
    Held,
    /// The frame is held, and the bound pushed out this oldest held frame.
    PushedOut(CodexHeldThreadFrame),
}

/// The thread-to-session index of one service, and the bounded hold for frames that name a thread
/// a start or fork in flight is about to claim (a `thread/started` can come before its reply). It
/// keeps no lock of its own: the supervisor owns the `Mutex` around it.
pub(crate) struct CodexServiceThreads {
    max_held_frames: usize,
    report_unclaimed: UnclaimedThreadFrameReport,
    session_by_thread: BTreeMap<String, SessionId>,
    held_frames: VecDeque<CodexHeldThreadFrame>,
    claims_in_flight: usize,
}

impl CodexServiceThreads {
    /// An empty index whose hold keeps at most `max_held_frames`, the oldest pushed out past it,
    /// and whose claims report the frames no claim took through `report_unclaimed`.
    pub(crate) fn new(
        max_held_frames: usize,
        report_unclaimed: UnclaimedThreadFrameReport,
    ) -> Self {
        Self {
            max_held_frames,
            report_unclaimed,
            session_by_thread: BTreeMap::new(),
            held_frames: VecDeque::new(),
            claims_in_flight: 0,
        }
    }

    /// The session a thread belongs to, or `None` for one no session on this service holds.
    pub(crate) fn session_for(&self, thread_id: &str) -> Option<&SessionId> {
        self.session_by_thread.get(thread_id)
    }

    /// Every session holding a conversation on this service, each once.
    pub(crate) fn sessions(&self) -> Vec<SessionId> {
        self.session_by_thread
            .values()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .copied()
            .collect()
    }

    /// Every thread one session holds here: its own and its helpers'.
    pub(crate) fn threads_of(&self, session_id: &SessionId) -> Vec<String> {
        self.session_by_thread
            .iter()
            .filter(|(_, owner)| *owner == session_id)
            .map(|(thread_id, _)| thread_id.clone())
            .collect()
    }

    /// Records a thread as the session's, and returns the frames held for it, in arrival order,
    /// for the caller to deliver now.
    pub(crate) fn register(
        &mut self,
        thread_id: String,
        session_id: SessionId,
    ) -> Vec<CodexHeldThreadFrame> {
        let mut released = Vec::new();
        for frame in std::mem::take(&mut self.held_frames) {
            if frame.thread_id == thread_id {
                released.push(frame);
            } else {
                self.held_frames.push_back(frame);
            }
        }
        self.session_by_thread.insert(thread_id, session_id);
        released
    }

    /// Forgets one thread.
    pub(crate) fn release(&mut self, thread_id: &str) {
        self.session_by_thread.remove(thread_id);
    }

    /// Opens a claim for a start or fork whose thread is not known yet. The claim closes when it
    /// is dropped, however its caller ends; the last one to close reports the frames no claim
    /// took. It locks `threads` to open and to close, so it is never dropped under that lock.
    pub(crate) fn begin_claim(threads: &Arc<Mutex<Self>>) -> ThreadClaim {
        let report_unclaimed = {
            let mut index = lock(threads);
            index.claims_in_flight += 1;
            Arc::clone(&index.report_unclaimed)
        };
        ThreadClaim {
            threads: Arc::clone(threads),
            report_unclaimed,
        }
    }

    /// Holds a frame for an unknown thread while a claim is open. Answers `NotHeld` with the frame
    /// when no claim is open, else `Held`, or `PushedOut` with the oldest frame past the bound.
    pub(crate) fn hold(&mut self, frame: CodexHeldThreadFrame) -> CodexThreadFrameHold {
        if self.claims_in_flight == 0 {
            return CodexThreadFrameHold::NotHeld(frame);
        }
        self.held_frames.push_back(frame);
        if self.held_frames.len() <= self.max_held_frames {
            return CodexThreadFrameHold::Held;
        }
        CodexThreadFrameHold::PushedOut(
            self.held_frames
                .pop_front()
                .expect("the hold is past its bound, so it holds a frame"),
        )
    }
}

/// An open claim on one service's thread index, closed when dropped. Dropping the last open claim
/// reports the frames no claim took; it locks the index, so it is never dropped while that lock
/// is held.
#[must_use = "the claim closes as soon as it is dropped"]
pub(crate) struct ThreadClaim {
    threads: Arc<Mutex<CodexServiceThreads>>,
    report_unclaimed: UnclaimedThreadFrameReport,
}

impl Drop for ThreadClaim {
    fn drop(&mut self) {
        let unclaimed: Vec<CodexHeldThreadFrame> = {
            let mut index = lock(&self.threads);
            index.claims_in_flight -= 1;
            if index.claims_in_flight > 0 {
                return;
            }
            index.held_frames.drain(..).collect()
        };
        // Called after the lock is let go, since the report may reach the index again.
        if !unclaimed.is_empty() {
            (self.report_unclaimed)(unclaimed);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::value::RawValue;

    use super::{CodexHeldThreadFrame, CodexServiceThreads, CodexThreadFrameHold};

    fn frame(method: &str) -> CodexHeldThreadFrame {
        CodexHeldThreadFrame {
            method: method.to_owned(),
            params: RawValue::from_string(r#"{"threadId":"thread-unknown"}"#.to_owned())
                .expect("the params are JSON"),
            thread_id: "thread-unknown".to_owned(),
        }
    }

    #[test]
    fn the_last_claim_dropped_reports_the_held_frames_once_and_the_bound_pushes_out_the_oldest() {
        let reports: Arc<Mutex<Vec<Vec<CodexHeldThreadFrame>>>> = Arc::default();
        let recorded = Arc::clone(&reports);
        let threads = Arc::new(Mutex::new(CodexServiceThreads::new(
            1,
            Arc::new(move |frames| recorded.lock().unwrap().push(frames)),
        )));
        let first_claim = CodexServiceThreads::begin_claim(&threads);
        let last_claim = CodexServiceThreads::begin_claim(&threads);

        assert_eq!(
            threads.lock().unwrap().hold(frame("item/started")),
            CodexThreadFrameHold::Held
        );
        assert_eq!(
            threads.lock().unwrap().hold(frame("item/completed")),
            CodexThreadFrameHold::PushedOut(frame("item/started"))
        );

        drop(first_claim);
        assert!(reports.lock().unwrap().is_empty());

        drop(last_claim);
        assert_eq!(
            *reports.lock().unwrap(),
            vec![vec![frame("item/completed")]]
        );

        assert_eq!(
            threads.lock().unwrap().hold(frame("turn/started")),
            CodexThreadFrameHold::NotHeld(frame("turn/started"))
        );
        // A last claim that closes with nothing held reports nothing.
        drop(CodexServiceThreads::begin_claim(&threads));
        assert_eq!(reports.lock().unwrap().len(), 1);
    }
}
