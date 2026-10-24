//! The one gate every driver passes a run's terminal frame through: at most one terminal per run
//! and run version reaches the emission pipeline, and it says whether a close the daemon asked for
//! came first. A suppressed duplicate is ordinary provider behavior, and the thread-frame router
//! already reported any frame it did not route to the session's own thread, so the gate reports
//! nothing itself.

use std::num::NonZeroUsize;

use lru::LruCache;
use sidekicks_contracts::run::id::RunId;

use crate::provider::thread_frame_router::ThreadFrameRoute;

/// How many settled run versions one session remembers; a duplicate comes in the same turn or the
/// same teardown, never hundreds of runs later, so the oldest is forgotten first.
const SETTLED_EPOCH_MEMORY: NonZeroUsize = NonZeroUsize::new(256).expect("256 is not zero");

/// One terminal frame of a run as the emission boundary sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TerminalRunFrame {
    /// The run the frame ends.
    pub(crate) run_id: RunId,
    /// The run's version, supplied by the caller since no provider frame carries one.
    pub(crate) run_version: u64,
    /// The router's decision for the frame, read unchanged.
    pub(crate) route: ThreadFrameRoute,
}

/// The gate's decision for one terminal frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TerminalEmissionDecision {
    /// The terminal goes out.
    Emit {
        /// Whether a close the daemon asked for came before it.
        intended_close: bool,
    },
    /// The terminal is dropped: the router did not route it to the session's own thread, or a
    /// terminal already settled its run and version.
    Suppressed {},
}

/// The gate of one provider session, held by its driver. It is per session because a close covers
/// whichever run is in flight at teardown, which the closing code does not know.
pub(crate) struct TerminalEmissionGate {
    /// The run versions a terminal settled, oldest first.
    settled_epochs: LruCache<(RunId, u64), ()>,
    /// Whether the daemon asked to close the session.
    is_intended_close_signaled: bool,
}

impl TerminalEmissionGate {
    /// A gate with nothing settled and no close asked for.
    pub(crate) fn new() -> Self {
        Self {
            settled_epochs: LruCache::new(SETTLED_EPOCH_MEMORY),
            is_intended_close_signaled: false,
        }
    }

    /// Marks a close the daemon asked for. Called first in a session's close, before the provider
    /// is asked to stop, so the terminal the stop provokes carries it.
    pub(crate) fn signal_intended_close(&mut self) {
        self.is_intended_close_signaled = true;
    }

    /// Whether the daemon asked to close the session, after which nothing new starts on it.
    pub(crate) fn is_intended_close_signaled(&self) -> bool {
        self.is_intended_close_signaled
    }

    /// Whether `frame` may go out and, if so, whether a close the daemon asked for came first. A
    /// suppressed frame is a decision, never an error.
    pub(crate) fn admit_terminal_frame(
        &mut self,
        frame: &TerminalRunFrame,
    ) -> TerminalEmissionDecision {
        if frame.route != ThreadFrameRoute::Project {
            return TerminalEmissionDecision::Suppressed {};
        }
        let epoch = (frame.run_id, frame.run_version);
        if self.settled_epochs.contains(&epoch) {
            return TerminalEmissionDecision::Suppressed {};
        }
        // Pushed only when absent, so the oldest settled version is the one forgotten.
        self.settled_epochs.push(epoch, ());
        TerminalEmissionDecision::Emit {
            intended_close: self.is_intended_close_signaled,
        }
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::run::id::RunId;

    use super::{TerminalEmissionDecision, TerminalEmissionGate, TerminalRunFrame};
    use crate::provider::thread_frame_router::ThreadFrameRoute;

    #[test]
    fn a_second_terminal_for_one_run_version_is_suppressed() {
        let run_id =
            RunId::new("0192f3a4-5b6c-7d8e-9f01-23456789abcd").expect("the text is a UUID");
        let terminal = || TerminalRunFrame {
            run_id,
            run_version: 1,
            route: ThreadFrameRoute::Project,
        };
        let mut gate = TerminalEmissionGate::new();

        let first = gate.admit_terminal_frame(&terminal());
        let second = gate.admit_terminal_frame(&terminal());

        assert_eq!(
            first,
            TerminalEmissionDecision::Emit {
                intended_close: false
            }
        );
        assert_eq!(second, TerminalEmissionDecision::Suppressed {});
    }
}
