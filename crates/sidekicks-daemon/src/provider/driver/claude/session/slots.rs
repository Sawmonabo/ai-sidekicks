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

use crate::claude::run::routes::ClaudeRunRoutes;
use crate::claude::session::errors::{ClaudeSessionError, ClaudeSessionSlotState};
use crate::claude::session::state::{ClaudeSessionSlot, ClaudeSlotSettled, LiveClaudeSession};
use crate::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::ports::DriverPorts;
use sidekicks_std::mutex_lock::lock;

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

/// What a resume found once no transition held the session's slot.
pub(crate) enum ClaudeResumeSlot {
    /// The slot was empty and is the resume's now.
    Claimed(ClaudeSlotClaim),
    /// This process is live, left by a transition the resume waited out or already up.
    CameUp(Arc<LiveClaudeSession>),
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

    /// Whether `channel` still writes this session's transcript: its live process, a rewind's
    /// predecessor while the fork comes up, or a closing process until its channel closes. A
    /// process the slot no longer binds acts on nothing.
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
            Some(ClaudeSessionSlot::Closing {
                reading: Some(reading),
                ..
            }) => Arc::ptr_eq(reading, channel),
            Some(
                ClaudeSessionSlot::Establishing {
                    predecessor: None, ..
                }
                | ClaudeSessionSlot::Closing { reading: None, .. }
                | ClaudeSessionSlot::Quarantined { .. },
            )
            | None => false,
        }
    }

    /// Claims an empty slot for a create, which starts a conversation of its own and so never
    /// waits on or takes over another's. Refuses `SessionAlreadyLive` with the slot's state.
    pub(crate) fn claim_create(
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

    /// Claims the slot for a resume once no transition holds it, waiting out each one in flight,
    /// one that settles into another included: an empty slot is claimed, and a live process is
    /// answered, whether a waited transition left it or it was already up. Refuses
    /// `SessionAlreadyLive` when the slot holds a quarantined process.
    pub(crate) async fn claim_resume(
        &self,
        session_id: SessionId,
    ) -> Result<ClaudeResumeSlot, ClaudeSessionError> {
        loop {
            let settled = {
                let mut table = lock(&self.table);
                match table.by_session.get(&session_id) {
                    None => {
                        let claim = self.claim(&mut table, session_id, None);
                        return Ok(ClaudeResumeSlot::Claimed(claim));
                    }
                    Some(
                        ClaudeSessionSlot::Establishing { settled, .. }
                        | ClaudeSessionSlot::Closing { settled, .. },
                    ) => Arc::clone(settled),
                    Some(ClaudeSessionSlot::Live { session }) => {
                        return Ok(ClaudeResumeSlot::CameUp(Arc::clone(session)));
                    }
                    Some(slot @ ClaudeSessionSlot::Quarantined { .. }) => {
                        return Err(ClaudeSessionError::SessionAlreadyLive {
                            holder_state: state_of(slot),
                        });
                    }
                }
            };
            settled.wait().await;
        }
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
        let session = match table.by_session.get(&session_id) {
            None => return ClaudeCloseStart::Empty,
            Some(
                ClaudeSessionSlot::Establishing { settled, .. }
                | ClaudeSessionSlot::Closing { settled, .. },
            ) => return ClaudeCloseStart::Wait(Arc::clone(settled)),
            Some(
                ClaudeSessionSlot::Live { session } | ClaudeSessionSlot::Quarantined { session },
            ) => Arc::clone(session),
        };
        ClaudeCloseStart::Closing(self.close(&mut table, session))
    }

    /// Starts the close of `live` while it is still the session's live process; `None` once the
    /// slot holds anything else, which is then not this close's to dispose of.
    pub(crate) fn begin_close_of(&self, live: &Arc<LiveClaudeSession>) -> Option<ClaudeSlotClose> {
        let mut table = lock(&self.table);
        match table.by_session.get(&live.session_id) {
            Some(ClaudeSessionSlot::Live { session }) if Arc::ptr_eq(session, live) => {
                Some(self.close(&mut table, Arc::clone(live)))
            }
            Some(_) | None => None,
        }
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

    // Marks the slot closing for `session`'s disposal, under the caller's lock.
    fn close(&self, table: &mut SlotTable, session: Arc<LiveClaudeSession>) -> ClaudeSlotClose {
        let session_id = session.session_id;
        let settled: ClaudeSlotSettled = Arc::new(SetOnce::new());
        table.by_session.insert(
            session_id,
            ClaudeSessionSlot::Closing {
                settled: Arc::clone(&settled),
                reading: Some(Arc::clone(&session.channel)),
            },
        );
        ClaudeSlotClose {
            table: Arc::clone(&self.table),
            session_id,
            settled,
            session,
            is_disposed: false,
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
    session: Arc<LiveClaudeSession>,
    is_disposed: bool,
}

impl ClaudeSlotClose {
    /// The session whose process the close disposes of.
    pub(crate) fn session(&self) -> &Arc<LiveClaudeSession> {
        &self.session
    }

    /// Closes the process's channel, waits until the process's task has taken every arrival its
    /// reader queued before the exit, or ended without it, then stops taking its frames: every
    /// frame read before the process exited reaches the session, whole, and none after.
    pub(crate) async fn close_channel(&self) {
        self.session.channel.close().await;
        self.session.task_ended.wait().await;
        if let Some(ClaudeSessionSlot::Closing { settled, reading }) =
            lock(&self.table).by_session.get_mut(&self.session_id)
            && Arc::ptr_eq(settled, &self.settled)
        {
            *reading = None;
        }
    }

    /// Empties the slot once the process is disposed of.
    pub(crate) fn finish(mut self) {
        self.is_disposed = true;
    }

    /// Closes the process for a bring-up that follows at once, keeping its runs bound for the next
    /// process: closes its channel, retires its run routes after it, empties the slot, releases
    /// the reviewer presses it served and tells the queue the process is gone.
    pub(crate) async fn retire_for_bring_up(self, routes: &ClaudeRunRoutes, ports: &DriverPorts) {
        let live = Arc::clone(&self.session);
        self.close_channel().await;
        // Once the channel is closed, so a frame read before it still reaches its run.
        routes.retire_run_routes(live.session_id);
        self.finish();
        live.release_served_presses(&ports.reviewer_denials);
        if let Some(process_gone) = ports.process_gone.port() {
            process_gone.process_gone(live.session_id);
        }
    }
}

impl Drop for ClaudeSlotClose {
    fn drop(&mut self) {
        {
            let mut table = lock(&self.table);
            let is_own = matches!(
                table.by_session.get(&self.session_id),
                Some(ClaudeSessionSlot::Closing { settled, .. })
                    if Arc::ptr_eq(settled, &self.settled)
            );
            if is_own {
                if self.is_disposed {
                    table.by_session.remove(&self.session_id);
                } else {
                    table.by_session.insert(
                        self.session_id,
                        ClaudeSessionSlot::Quarantined {
                            session: Arc::clone(&self.session),
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
    use std::pin::pin;
    use std::sync::{Arc, Mutex};

    use super::{ClaudeCloseStart, ClaudeResumeSlot, ClaudeSessionSlots};
    use crate::claude::session::errors::{ClaudeSessionError, ClaudeSessionSlotState};
    use crate::claude::session::scripted::channel::ScriptedChannel;
    use crate::claude::session::scripted::scripted_live_session;
    use crate::claude::session::state::LiveClaudeSession;
    use crate::driver::test_registry::new_session_id;
    use sidekicks_contracts::session::id::SessionId;

    fn live(session_id: SessionId) -> Arc<LiveClaudeSession> {
        Arc::new(scripted_live_session(
            session_id,
            Arc::new(ScriptedChannel::default()),
        ))
    }

    fn install(slots: &ClaudeSessionSlots, live: &Arc<LiveClaudeSession>) {
        let installed = slots
            .claim_create(live.session_id)
            .expect("the slot is free")
            .install(Arc::clone(live));
        assert!(installed.is_ok(), "a fresh claim installs");
    }

    // Killed by a create taking a slot mid-disposal, by a resume claim answered before the
    // disposal settles, by a failed disposal emptying the slot, which loses the only handle on a
    // process that may still run, and by a quarantined slot read as a close in flight.
    #[tokio::test]
    async fn a_close_refuses_a_create_holds_a_resume_and_a_failed_disposal_quarantines() {
        let slots = ClaudeSessionSlots::new(Arc::new(|_predecessor| {}));
        let session_id = new_session_id();
        let live = live(session_id);
        install(&slots, &live);

        let ClaudeCloseStart::Closing(close) = slots.begin_close(session_id) else {
            unreachable!("a live slot is the close's")
        };
        let refused = |slots: &ClaudeSessionSlots, state| {
            matches!(
                slots.claim_create(session_id),
                Err(ClaudeSessionError::SessionAlreadyLive { holder_state })
                    if holder_state == state
            )
        };
        assert!(refused(&slots, ClaudeSessionSlotState::Closing));
        let mut resuming = pin!(slots.claim_resume(session_id));
        assert!(futures::poll!(resuming.as_mut()).is_pending());
        drop(close);
        assert!(matches!(
            resuming.await,
            Err(ClaudeSessionError::SessionAlreadyLive {
                holder_state: ClaudeSessionSlotState::Quarantined
            })
        ));
        assert!(refused(&slots, ClaudeSessionSlotState::Quarantined));

        let ClaudeCloseStart::Closing(close) = slots.begin_close(session_id) else {
            unreachable!("a quarantined process is the next close's")
        };
        assert!(Arc::ptr_eq(close.session(), &live));
        close.finish();
        assert!(slots.claim_create(session_id).is_ok());
    }

    // Killed by a resume that refuses once its first wait settles into another transition: here a
    // bring-up settles into a close it waits out too, then claims the empty slot.
    #[tokio::test]
    async fn a_resume_waits_out_each_transition_in_turn_and_claims_the_emptied_slot() {
        let slots = ClaudeSessionSlots::new(Arc::new(|_predecessor| {}));
        let session_id = new_session_id();
        let live = live(session_id);
        let bring_up = slots.claim_create(session_id).expect("the slot is free");

        let mut resuming = pin!(slots.claim_resume(session_id));
        assert!(futures::poll!(resuming.as_mut()).is_pending());
        assert!(bring_up.install(Arc::clone(&live)).is_ok());
        let ClaudeCloseStart::Closing(close) = slots.begin_close(session_id) else {
            unreachable!("the installed process is the close's")
        };
        assert!(futures::poll!(resuming.as_mut()).is_pending());
        close.finish();

        let Ok(ClaudeResumeSlot::Claimed(claim)) = resuming.await else {
            unreachable!("the emptied slot is the resume's")
        };
        assert!(claim.install(live).is_ok());
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
        let session_id = new_session_id();
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
