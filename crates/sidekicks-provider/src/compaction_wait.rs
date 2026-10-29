//! The pending-compaction wait both drivers share. Both providers answer a compaction request
//! before the work is done, so `applied` is admitted only by the provider's typed compaction frame:
//! arm, dispatch, then wait for it.
//!
//! - The wait has no time limit of its own: it ends when the frame arrives, when the provider ends
//!   the compaction's turn without one, or when the binding stops being live.
//! - A late frame still becomes `agent.run.context.compacted` on its ordinary route, waited on or
//!   not.
//! - Settlement is per key; withdrawal is per waiter and settles no one.

use sidekicks_std::keyed_wait::{ArmedWait, KeyedWaits};

/// How a compaction wait ended; only `Observed` admits `applied`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompactionWaitTerminal {
    /// The provider's typed compaction frame arrived.
    Observed,
    /// The provider ended the compaction's turn without a compaction frame.
    NotCompacted,
    /// The binding stopped being live before a compaction frame arrived.
    BindingLost,
}

impl CompactionWaitTerminal {
    /// Why a wait settled with no compaction, in words for the driver's diagnostic; `None` for
    /// `Observed`.
    pub(crate) const fn failure_detail(self) -> Option<&'static str> {
        match self {
            Self::Observed => None,
            Self::NotCompacted => {
                Some("the provider ended the compaction's turn without a compaction frame")
            }
            Self::BindingLost => {
                Some("the binding stopped being live before a compaction frame arrived")
            }
        }
    }
}

/// The settlement handed to one waiter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CompactionWaitSettlement {
    /// How the wait ended.
    pub(crate) terminal: CompactionWaitTerminal,
    /// Where the compaction's boundary sits, when the frame says; `None` unless `Observed`.
    pub(crate) boundary_position: Option<u64>,
}

/// The pending compactions of one driver, keyed by the driver's address for a live binding. The
/// key names the binding a wait was dispatched under, so a path that replaces the binding can
/// release its stranded waits; clones share the same waits.
#[derive(Clone, Default)]
pub struct PendingCompactionRegistry {
    /// The waits every clone shares.
    waits: KeyedWaits<String, CompactionWaitSettlement>,
}

/// One armed compaction wait. Dropping it before it settles withdraws it without settling any
/// other waiter, so a caller drops it on a failed dispatch and awaits its `settled` on a
/// successful one.
pub(crate) type ArmedCompactionWait = ArmedWait<String, CompactionWaitSettlement>;

impl PendingCompactionRegistry {
    /// Arms a wait for `key`. Arm before dispatching: a frame delivered before the registration
    /// would find no waiter, and the wait would never see it.
    pub(crate) fn arm(&self, key: &str) -> ArmedCompactionWait {
        self.waits.arm(key.to_owned())
    }

    /// A typed compaction frame arrived on `key`: settles every waiter; a no-op with none armed.
    pub(crate) fn observe_boundary(&self, key: &str, boundary_position: Option<u64>) {
        self.waits.settle_all(
            key,
            CompactionWaitSettlement {
                terminal: CompactionWaitTerminal::Observed,
                boundary_position,
            },
        );
    }

    /// The provider ended the turn that ran the compaction on `key`, which delivers its frame
    /// before that end: settles every waiter still armed. A no-op with none.
    pub(crate) fn observe_turn_end(&self, key: &str) {
        self.waits.settle_all(
            key,
            CompactionWaitSettlement {
                terminal: CompactionWaitTerminal::NotCompacted,
                boundary_position: None,
            },
        );
    }

    /// The binding behind `key` is gone (teardown, quarantine): settles every waiter. A no-op
    /// with none.
    pub(crate) fn release_binding(&self, key: &str) {
        self.waits.settle_all(
            key,
            CompactionWaitSettlement {
                terminal: CompactionWaitTerminal::BindingLost,
                boundary_position: None,
            },
        );
    }
}
