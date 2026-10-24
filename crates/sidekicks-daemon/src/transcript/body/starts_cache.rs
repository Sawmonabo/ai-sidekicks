//! The block cuts of ended replies, kept in memory so a later part of a long reply decodes only
//! the frames it covers. An ended reply's cut never changes, so it is cut once from its whole text;
//! a reply still taking pieces is cut whole on each part and never kept. The cache holds at most
//! 8 MiB of starts, letting go of the oldest first, and a purged session's cuts with it; the
//! session service that reads bodies owns it.

use std::collections::{HashMap, VecDeque};
use std::mem::size_of;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{BodyBlockCut, BodyBlockStart};

/// The most starts, in bytes, the cache holds.
const BLOCK_STARTS_CACHE_BYTES: usize = 8 * 1024 * 1024;

/// An ended reply's row: its session, its sequence and its whole body's length, so a row a skip
/// range or a later piece reshaped is a new key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct BlockCutKey {
    /// The row's session.
    pub(super) session_id: SessionId,
    /// The row's sequence.
    pub(super) sequence: i64,
    /// The row's whole body's UTF-8 length.
    pub(super) body_length: usize,
}

/// An ended reply's cut: not cut into blocks, or the starts of its whole body.
#[derive(Clone, Debug)]
pub(super) enum EndedBlockCut {
    /// The reply is not drawn as markdown.
    NotCut,
    /// Every start of the whole body, ascending.
    Starts(Arc<[BodyBlockStart]>),
}

impl EndedBlockCut {
    /// The cut as a body read carries it.
    pub(super) fn as_block_cut(&self) -> BodyBlockCut<'_> {
        match self {
            Self::NotCut => BodyBlockCut::NotCut,
            Self::Starts(starts) => BodyBlockCut::Starts(starts),
        }
    }

    // What the cut counts against the cache's bound.
    fn held_bytes(&self) -> usize {
        size_of::<BlockCutKey>()
            + match self {
                Self::NotCut => 0,
                Self::Starts(starts) => starts.len() * size_of::<BodyBlockStart>(),
            }
    }
}

/// The kept cuts of ended replies, at most 8 MiB of starts, letting go of the oldest first; the
/// session service that reads bodies owns one.
#[derive(Default)]
pub(crate) struct BlockCuts {
    kept: Mutex<KeptBlockCuts>,
}

#[derive(Default)]
struct KeptBlockCuts {
    cuts: HashMap<BlockCutKey, EndedBlockCut>,
    // Keys in the order they were kept, the oldest first.
    order: VecDeque<BlockCutKey>,
    held_bytes: usize,
}

impl BlockCuts {
    /// The kept cut of the ended reply at `key`, `None` when none is kept.
    pub(super) fn kept_block_cut(&self, key: &BlockCutKey) -> Option<EndedBlockCut> {
        self.lock().cuts.get(key).cloned()
    }

    /// Keeps `cut` for the ended reply at `key`, letting go of the oldest cuts past the bound; a
    /// cut larger than the bound by itself is not kept.
    pub(super) fn keep_block_cut(&self, key: BlockCutKey, cut: EndedBlockCut) {
        let held_bytes = cut.held_bytes();
        if held_bytes > BLOCK_STARTS_CACHE_BYTES {
            return;
        }
        let mut cuts = self.lock();
        if cuts.cuts.contains_key(&key) {
            return;
        }
        while cuts.held_bytes + held_bytes > BLOCK_STARTS_CACHE_BYTES {
            let Some(oldest) = cuts.order.pop_front() else {
                break;
            };
            if let Some(dropped) = cuts.cuts.remove(&oldest) {
                cuts.held_bytes -= dropped.held_bytes();
            }
        }
        cuts.held_bytes += held_bytes;
        cuts.order.push_back(key);
        cuts.cuts.insert(key, cut);
    }

    /// Lets go of every kept cut of `session_id`'s replies, once the session is purged.
    pub(crate) fn forget_session_block_cuts(&self, session_id: &SessionId) {
        let mut cuts = self.lock();
        let KeptBlockCuts {
            cuts: kept,
            order,
            held_bytes,
        } = &mut *cuts;
        order.retain(|key| {
            if key.session_id != *session_id {
                return true;
            }
            if let Some(dropped) = kept.remove(key) {
                *held_bytes -= dropped.held_bytes();
            }
            false
        });
    }

    fn lock(&self) -> MutexGuard<'_, KeptBlockCuts> {
        self.kept.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
