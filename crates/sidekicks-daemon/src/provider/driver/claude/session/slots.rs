//! Every Claude Code session's slot: whether its process is coming up, live, going down or
//! refusing to die. A transition takes its slot synchronously, under a lock never held across an
//! await, so no caller sees a free slot while a process spawns or dies; its slow work then runs on
//! a task that holds the transition's guard, which settles the slot on every exit path, an aborted
//! task included: a bring-up that installs nothing restores what was there, and a close whose
//! disposal never finished leaves the process quarantined. A waiter waits on the transition's
//! settle cell, then reads the slot again.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use sidekicks_contracts::session::id::SessionId;
use tokio::sync::SetOnce;

use crate::mutex_lock::lock;
use crate::provider::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionSlotState,
};
use crate::provider::driver::claude::session::state::{
    ClaudeSessionSlot, ClaudeSlotSettled, LiveClaudeSession,
};
use crate::provider::driver::claude::session::transport::channel::ClaudeProcessChannel;

/// What runs when a rewind's predecessor, restored after a failed fork, exited while the fork
/// held its slot: the path any unrequested exit takes.
pub(crate) type ClaudePredecessorExited = Arc<dyn Fn(Arc<LiveClaudeSession>) + Send + Sync>;

#[derive(Default)]
struct SlotTable {
    by_session: HashMap<SessionId, ClaudeSessionSlot>,
    // Sessions whose rewind predecessor exited while the fork held the slot.
    exited_predecessors: HashSet<SessionId>,
}

/// One slot per session, shared by every transition and the guards that settle them.
#[derive(Clone)]
pub(crate) struct ClaudeSessionSlots {
    table: Arc<Mutex<SlotTable>>,
    predecessor_exited: ClaudePredecessorExited,
}

/// How a close found the session's slot.
pub(crate) enum ClaudeCloseStart {
    /// No process: nothing to close.
    Empty,
    /// Another transition is in flight; wait on it, then try again.
    Wait(ClaudeSlotSettled),
    /// The slot is the close's: dispose of the process, then finish the close.
    Closing(ClaudeSlotClose),
}

impl ClaudeSessionSlots {
    /// The slots, with what runs when a restored predecessor had exited.
    pub(crate) fn new(predecessor_exited: ClaudePredecessorExited) -> Self {
        Self {
            table: Arc::new(Mutex::new(SlotTable::default())),
            predecessor_exited,
        }
    }

    /// The session's live process; `None` while it comes up, goes down, refuses to die, or none
    /// runs, since only a live slot starts a run.
    pub(crate) fn live_session(&self, session_id: SessionId) -> Option<Arc<LiveClaudeSession>> {
        match lock(&self.table).by_session.get(&session_id)? {
            ClaudeSessionSlot::Live { session } => Some(Arc::clone(session)),
            ClaudeSessionSlot::Establishing { .. }
            | ClaudeSessionSlot::Closing { .. }
            | ClaudeSessionSlot::Quarantined { .. } => None,
        }
    }

    /// Every session whose process is live now.
    pub(crate) fn live_sessions(&self) -> Vec<Arc<LiveClaudeSession>> {
        lock(&self.table)
            .by_session
            .values()
            .filter_map(|slot| match slot {
                ClaudeSessionSlot::Live { session } => Some(Arc::clone(session)),
                ClaudeSessionSlot::Establishing { .. }
                | ClaudeSessionSlot::Closing { .. }
                | ClaudeSessionSlot::Quarantined { .. } => None,
            })
            .collect()
    }

    /// Every session holding a slot, in any state.
    pub(crate) fn session_ids(&self) -> Vec<SessionId> {
        lock(&self.table).by_session.keys().copied().collect()
    }

    /// Whether the session holds a slot, in any state.
    pub(crate) fn holds_slot(&self, session_id: SessionId) -> bool {
        lock(&self.table).by_session.contains_key(&session_id)
    }

    /// Whether `channel` still writes this session's transcript: its live process, or a rewind's
    /// predecessor while the fork comes up. A process the slot no longer binds acts on nothing.
    pub(crate) fn binds_channel(
        &self,
        session_id: SessionId,
        channel: &Arc<dyn ClaudeProcessChannel>,
    ) -> bool {
        match lock(&self.table).by_session.get(&session_id) {
            Some(
                ClaudeSessionSlot::Live { session }
                | ClaudeSessionSlot::Establishing {
                    predecessor: Some(session),
                    ..
                },
            ) => Arc::ptr_eq(&session.channel, channel),
            Some(
                ClaudeSessionSlot::Establishing {
                    predecessor: None, ..
                }
                | ClaudeSessionSlot::Closing { .. }
                | ClaudeSessionSlot::Quarantined { .. },
            )
            | None => false,
        }
    }

    /// Claims an empty slot for a create or resume. Refuses `SessionAlreadyLive` with the state
    /// the slot is in.
    pub(crate) fn claim_bring_up(
        &self,
        session_id: SessionId,
    ) -> Result<ClaudeSlotClaim, ClaudeSessionError> {
        let mut table = lock(&self.table);
        if let Some(slot) = table.by_session.get(&session_id) {
            return Err(ClaudeSessionError::SessionAlreadyLive {
                holder_state: state_of(slot),
            });
        }
        Ok(self.claim(&mut table, session_id, None))
    }

    /// Claims the live slot of `predecessor` for a rewind, which keeps its process writing the
    /// transcript until the fork is up. `false` when the slot no longer holds it live.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start registers the Claude driver, whose rewind claims the \
                      slot through it"
        )
    )]
    pub(crate) fn claim_rewind(
        &self,
        predecessor: &Arc<LiveClaudeSession>,
    ) -> Option<ClaudeSlotClaim> {
        let mut table = lock(&self.table);
        match table.by_session.get(&predecessor.session_id) {
            Some(ClaudeSessionSlot::Live { session }) if Arc::ptr_eq(session, predecessor) => {
                Some(self.claim(&mut table, predecessor.session_id, Some(predecessor)))
            }
            Some(_) | None => None,
        }
    }

    /// Starts a close: a live or quarantined process is the close's to dispose of, a transition
    /// in flight is waited out first, and an empty slot needs nothing.
    pub(crate) fn begin_close(&self, session_id: SessionId) -> ClaudeCloseStart {
        let mut table = lock(&self.table);
        let channel = match table.by_session.get(&session_id) {
            None => return ClaudeCloseStart::Empty,
            Some(
                ClaudeSessionSlot::Establishing { settled, .. }
                | ClaudeSessionSlot::Closing { settled },
            ) => return ClaudeCloseStart::Wait(Arc::clone(settled)),
            Some(ClaudeSessionSlot::Live { session }) => Arc::clone(&session.channel),
            Some(ClaudeSessionSlot::Quarantined { channel }) => Arc::clone(channel),
        };
        let settled: ClaudeSlotSettled = Arc::new(SetOnce::new());
        table.by_session.insert(
            session_id,
            ClaudeSessionSlot::Closing {
                settled: Arc::clone(&settled),
            },
        );
        ClaudeCloseStart::Closing(ClaudeSlotClose {
            table: Arc::clone(&self.table),
            session_id,
            settled,
            channel,
            is_disposed: false,
        })
    }

    /// Empties the slot of a process that exited with nothing in the daemon asking it to, and
    /// answers the session it held; a rewind's predecessor exiting while the fork comes up is
    /// recorded, for the fork's failure to act on. `None` when the slot no longer holds `channel`.
    pub(crate) fn release_exited(
        &self,
        session_id: SessionId,
        channel: &Arc<dyn ClaudeProcessChannel>,
    ) -> Option<Arc<LiveClaudeSession>> {
        let mut table = lock(&self.table);
        match table.by_session.get(&session_id) {
            Some(ClaudeSessionSlot::Live { session }) if Arc::ptr_eq(&session.channel, channel) => {
                let session = Arc::clone(session);
                table.by_session.remove(&session_id);
                Some(session)
            }
            Some(ClaudeSessionSlot::Establishing {
                predecessor: Some(session),
                ..
            }) if Arc::ptr_eq(&session.channel, channel) => {
                table.exited_predecessors.insert(session_id);
                None
            }
            Some(_) | None => None,
        }
    }

    fn claim(
        &self,
        table: &mut SlotTable,
        session_id: SessionId,
        predecessor: Option<&Arc<LiveClaudeSession>>,
    ) -> ClaudeSlotClaim {
        let settled: ClaudeSlotSettled = Arc::new(SetOnce::new());
        table.exited_predecessors.remove(&session_id);
        table.by_session.insert(
            session_id,
            ClaudeSessionSlot::Establishing {
                settled: Arc::clone(&settled),
                predecessor: predecessor.cloned(),
            },
        );
        ClaudeSlotClaim {
            slots: self.clone(),
            session_id,
            settled,
            is_installed: false,
        }
    }
}

/// A bring-up's hold on its slot. Installing a live session settles it; dropped without one, it
/// restores what was there, if the slot is still its own: a rewind's predecessor live again (or
/// taken down the exit path when it exited meanwhile), and no entry for a create or resume.
pub(crate) struct ClaudeSlotClaim {
    slots: ClaudeSessionSlots,
    session_id: SessionId,
    settled: ClaudeSlotSettled,
    is_installed: bool,
}

impl ClaudeSlotClaim {
    /// Installs the process the bring-up started as the session's live slot and answers the
    /// rewind's predecessor it replaces, which the caller then disposes of. `None` when the slot
    /// is no longer this claim's (a close took it), so the new process is the caller's to end.
    pub(crate) fn install(
        mut self,
        live: Arc<LiveClaudeSession>,
    ) -> Result<Option<Arc<LiveClaudeSession>>, Arc<LiveClaudeSession>> {
        let mut table = lock(&self.slots.table);
        let predecessor = match table.by_session.get(&self.session_id) {
            Some(ClaudeSessionSlot::Establishing {
                settled,
                predecessor,
            }) if Arc::ptr_eq(settled, &self.settled) => predecessor.clone(),
            Some(_) | None => return Err(live),
        };
        table.exited_predecessors.remove(&self.session_id);
        table
            .by_session
            .insert(self.session_id, ClaudeSessionSlot::Live { session: live });
        drop(table);
        self.is_installed = true;
        Ok(predecessor)
    }
}

impl Drop for ClaudeSlotClaim {
    fn drop(&mut self) {
        if !self.is_installed {
            let exited = {
                let mut table = lock(&self.slots.table);
                let is_own = matches!(
                    table.by_session.get(&self.session_id),
                    Some(ClaudeSessionSlot::Establishing { settled, .. })
                        if Arc::ptr_eq(settled, &self.settled)
                );
                let has_exited = table.exited_predecessors.remove(&self.session_id);
                let restored = if is_own {
                    table
                        .by_session
                        .remove(&self.session_id)
                        .and_then(ClaudeSessionSlot::after_failed_bring_up)
                } else {
                    None
                };
                match restored {
                    Some(ClaudeSessionSlot::Live { session }) if has_exited => Some(session),
                    Some(slot) => {
                        table.by_session.insert(self.session_id, slot);
                        None
                    }
                    None => None,
                }
            };
            if let Some(predecessor) = exited {
                (self.slots.predecessor_exited)(predecessor);
            }
        }
        settle(&self.settled);
    }
}

/// A close's hold on its slot. Finishing it empties the slot once the process is disposed of;
/// dropped otherwise, it leaves the process quarantined, the only handle on a process that may
/// still run.
pub(crate) struct ClaudeSlotClose {
    table: Arc<Mutex<SlotTable>>,
    session_id: SessionId,
    settled: ClaudeSlotSettled,
    channel: Arc<dyn ClaudeProcessChannel>,
    is_disposed: bool,
}

impl ClaudeSlotClose {
    /// The process the close disposes of.
    pub(crate) fn channel(&self) -> &Arc<dyn ClaudeProcessChannel> {
        &self.channel
    }

    /// Empties the slot once the process is disposed of.
    pub(crate) fn finish(mut self) {
        self.is_disposed = true;
    }
}

impl Drop for ClaudeSlotClose {
    fn drop(&mut self) {
        {
            let mut table = lock(&self.table);
            let is_own = matches!(
                table.by_session.get(&self.session_id),
                Some(ClaudeSessionSlot::Closing { settled }) if Arc::ptr_eq(settled, &self.settled)
            );
            if is_own {
                if self.is_disposed {
                    table.by_session.remove(&self.session_id);
                } else {
                    table.by_session.insert(
                        self.session_id,
                        ClaudeSessionSlot::Quarantined {
                            channel: Arc::clone(&self.channel),
                        },
                    );
                }
            }
        }
        settle(&self.settled);
    }
}

fn state_of(slot: &ClaudeSessionSlot) -> ClaudeSessionSlotState {
    match slot {
        ClaudeSessionSlot::Establishing { .. } => ClaudeSessionSlotState::Establishing,
        ClaudeSessionSlot::Live { .. } => ClaudeSessionSlotState::Live,
        ClaudeSessionSlot::Closing { .. } => ClaudeSessionSlotState::Closing,
        ClaudeSessionSlot::Quarantined { .. } => ClaudeSessionSlotState::Quarantined,
    }
}

// Sets a transition's cell from its guard; each guard drops once, so a second set cannot happen,
// and were it to, the first settlement stands.
fn settle(settled: &SetOnce<()>) {
    drop(settled.set(()));
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::{ClaudeCloseStart, ClaudeSessionSlots};
    use crate::provider::driver::claude::session::errors::{
        ClaudeSessionError, ClaudeSessionSlotState,
    };
    use crate::provider::driver::claude::session::scripted::channel::ScriptedChannel;
    use crate::provider::driver::claude::session::scripted::{
        mint_session_id, scripted_live_session,
    };
    use crate::provider::driver::claude::session::state::LiveClaudeSession;
    use sidekicks_contracts::session::id::SessionId;

    fn live(session_id: SessionId) -> Arc<LiveClaudeSession> {
        Arc::new(scripted_live_session(
            session_id,
            Arc::new(ScriptedChannel::default()),
        ))
    }

    fn install(slots: &ClaudeSessionSlots, live: &Arc<LiveClaudeSession>) {
        let installed = slots
            .claim_bring_up(live.session_id)
            .expect("the slot is free")
            .install(Arc::clone(live));
        assert!(installed.is_ok(), "a fresh claim installs");
    }

    // Killed by a create taking a slot mid-disposal, by a failed disposal emptying the slot, which
    // loses the only handle on a process that may still run, and by a quarantined slot read as a
    // close in flight.
    #[test]
    fn a_closing_slot_refuses_a_create_and_a_failed_disposal_quarantines_its_process() {
        let slots = ClaudeSessionSlots::new(Arc::new(|_predecessor| {}));
        let session_id = mint_session_id();
        let live = live(session_id);
        install(&slots, &live);

        let ClaudeCloseStart::Closing(close) = slots.begin_close(session_id) else {
            unreachable!("a live slot is the close's")
        };
        let refused = |slots: &ClaudeSessionSlots, state| {
            matches!(
                slots.claim_bring_up(session_id),
                Err(ClaudeSessionError::SessionAlreadyLive { holder_state })
                    if holder_state == state
            )
        };
        assert!(refused(&slots, ClaudeSessionSlotState::Closing));
        drop(close);
        assert!(refused(&slots, ClaudeSessionSlotState::Quarantined));

        let ClaudeCloseStart::Closing(close) = slots.begin_close(session_id) else {
            unreachable!("a quarantined process is the next close's")
        };
        assert!(Arc::ptr_eq(close.channel(), &live.channel));
        close.finish();
        assert!(slots.claim_bring_up(session_id).is_ok());
    }

    // Killed by restoring a rewind's predecessor live after it exited while the fork held its
    // slot, which would leave a dead process serving the session.
    #[test]
    fn a_failed_rewind_hands_a_predecessor_that_exited_to_the_exit_path() {
        let exited = Arc::new(Mutex::new(Vec::new()));
        let slots = ClaudeSessionSlots::new({
            let exited = Arc::clone(&exited);
            Arc::new(move |predecessor| {
                exited
                    .lock()
                    .expect("the exits' lock holds")
                    .push(predecessor);
            })
        });
        let session_id = mint_session_id();
        let predecessor = live(session_id);
        install(&slots, &predecessor);

        let fork = slots
            .claim_rewind(&predecessor)
            .expect("the predecessor is live");
        assert!(
            slots
                .release_exited(session_id, &predecessor.channel)
                .is_none()
        );
        drop(fork);

        let exited = exited.lock().expect("the exits' lock holds");
        assert_eq!(exited.len(), 1);
        assert!(Arc::ptr_eq(&exited[0], &predecessor));
        assert!(slots.live_session(session_id).is_none());
    }
}
