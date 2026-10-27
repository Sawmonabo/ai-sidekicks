//! One shell's flow control: the shell's read pauses only while every connection watching it has
//! fallen behind, so one slow watcher never freezes a healthy one; the slow one catches up from the
//! scrollback window instead. With no watchers the read never pauses, so output keeps reaching the
//! scrollback window. The control lease does not gate it: it moves no bytes toward the shell.

use std::collections::HashMap;

use sidekicks_ipc::registry::TransportId;

/// A change the shell's read needs, which the caller applies with `Terminals::pause` or
/// `Terminals::resume`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadChange {
    /// Every watcher is behind: stop reading.
    Pause,
    /// A watcher caught up, or the last one left: read again.
    Resume,
}

/// Which of a shell's watching connections are behind, and whether its read is paused.
pub(crate) struct ShellFlowControl {
    /// Each watching connection, `true` while it is behind.
    watchers: HashMap<TransportId, bool>,
    is_read_paused: bool,
}

impl ShellFlowControl {
    /// A shell nobody watches, reading.
    pub(crate) fn new() -> Self {
        Self {
            watchers: HashMap::new(),
            is_read_paused: false,
        }
    }

    /// Counts `transport_id` as a watcher, caught up; answers the resume of a read every watcher
    /// had paused.
    pub(crate) fn add_watcher(&mut self, transport_id: TransportId) -> Option<ReadChange> {
        if self.watchers.contains_key(&transport_id) {
            return None;
        }
        self.watchers.insert(transport_id, false);
        self.read_change()
    }

    /// Stops counting `transport_id` as a watcher, on unsubscribe or disconnect, clearing its
    /// state; answers the change that leaves the read in.
    pub(crate) fn remove_watcher(&mut self, transport_id: TransportId) -> Option<ReadChange> {
        self.watchers.remove(&transport_id)?;
        self.read_change()
    }

    /// Records whether a watching connection is behind; a connection not watching changes
    /// nothing. Answers the change the read needs.
    pub(crate) fn declare(
        &mut self,
        transport_id: TransportId,
        is_behind: bool,
    ) -> Option<ReadChange> {
        *self.watchers.get_mut(&transport_id)? = is_behind;
        self.read_change()
    }

    /// Whether a watching connection last declared itself behind; one not watching is not.
    pub(crate) fn is_behind(&self, transport_id: TransportId) -> bool {
        self.watchers.get(&transport_id).copied().unwrap_or(false)
    }

    /// The change the read needs now, recorded as made: the caller's pause and resume fail only
    /// for a shell that is gone.
    fn read_change(&mut self) -> Option<ReadChange> {
        let should_pause =
            !self.watchers.is_empty() && self.watchers.values().all(|is_behind| *is_behind);
        if should_pause == self.is_read_paused {
            return None;
        }
        self.is_read_paused = should_pause;
        Some(if should_pause {
            ReadChange::Pause
        } else {
            ReadChange::Resume
        })
    }
}
