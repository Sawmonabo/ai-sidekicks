//! What the delivery remembers between calls, all behind its one mutex: the messages handed to a
//! provider and not yet settled, the messages kept for a run's next turn, the runs holding a
//! credits choice or held for an interrupt, the sessions held for an undo with the signal each
//! one's release sends, and each session's chain; with the rules that read it.

use std::collections::{HashMap, HashSet};

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::message_handing::MessageHanding;
use sidekicks_provider::process_identity::ProviderProcessIdentity;
use sidekicks_session::queue_store::QueueItemRecord;

use tokio::sync::watch;

use crate::delivery::chain::SessionChain;

/// How a message reached its provider: by the driver, which answered how it takes messages at the
/// hand, or by the continue of a paused run, which delivers the messages that waited for it.
#[derive(Clone, Copy, Debug)]
pub(super) enum HandRoute {
    /// Handed by the driver.
    Driver(MessageHanding),
    /// Read by a paused run's continue.
    Continue {
        /// Kept by a resume whose outcome is unknown: no later continue reads it until that
        /// outcome is settled.
        is_kept: bool,
        /// How the provider the resume went to takes messages.
        handing: MessageHanding,
    },
}

/// A message the provider has been handed and not yet confirmed taking.
#[derive(Clone, Copy, Debug)]
pub(super) struct HandedMessage {
    /// The run it was handed for.
    pub(super) run_id: RunId,
    /// How it was handed.
    pub(super) route: HandRoute,
    /// The provider process it went to, or `None` while none ran.
    pub(super) process: Option<ProviderProcessIdentity>,
    /// Unique for the delivery's life, so a late answer settles only the hand it was asked for.
    pub(super) hand_number: u64,
}

/// One undo's hold on a session, unique for the delivery's life, so a late release of a hold
/// that was let go never lets go a newer hold an undo with the same key took.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct UndoHoldId(u64);

/// The undos holding one session, the runs whose resume they held back, and the signal their last
/// release closes.
#[derive(Default)]
pub(super) struct UndoHolders {
    /// The hold of each undo holding the session.
    pub(super) holds: HashSet<UndoHoldId>,
    /// The runs a resume read while the session was held, each owed one resume at the last
    /// release, in the order their resumes came and each once.
    pub(super) owed_resumes: Vec<RunId>,
    /// Sends nothing and closes as the session's last undo lets go; a start waiting to read its
    /// opening waits on it.
    pub(super) released: watch::Sender<()>,
}

/// Everything the delivery keeps, guarded by one `std::sync::Mutex` never held across an await.
#[derive(Default)]
pub(super) struct DeliveryState {
    // The handed messages, by item; a hand leaves only through `forget_hand` or `retain_hands`.
    handed: HashMap<QueueItemId, HandedMessage>,
    // Moves on with every hand forgotten, so a reader of the waiting messages that read them
    // before taking this state's lock learns that one it read as waiting may have settled since.
    forgotten_hands: u64,
    /// Messages sent while their run waited on input, which go as its next turn, by item.
    pub(super) next_turn_runs: HashMap<QueueItemId, RunId>,
    /// Runs whose provider holds a credits choice that a message settles.
    pub(super) credits_choice_runs: HashSet<RunId>,
    /// Runs an interrupt is under way on, with each interrupt holding it; a run is handed nothing
    /// until every one of them settles.
    pub(super) interrupt_holds: HashMap<RunId, HashSet<InterventionId>>,
    /// Sessions an undo is under way on, with the hold of each undo holding it and the signal that
    /// closes once the last of them lets go; nothing of the session is handed until then.
    pub(super) undo_holds: HashMap<SessionId, UndoHolders>,
    /// Each session's chain, present only while its drain runs.
    pub(super) chains: HashMap<SessionId, SessionChain>,
    next_hand_number: u64,
    next_undo_hold_id: u64,
}

impl DeliveryState {
    /// The hand of `item_id`, while the provider holds it.
    pub(super) fn hand_of(&self, item_id: &QueueItemId) -> Option<&HandedMessage> {
        self.handed.get(item_id)
    }

    /// Every hand the provider holds, by item.
    pub(super) fn hands(&self) -> impl Iterator<Item = (&QueueItemId, &HandedMessage)> {
        self.handed.iter()
    }

    /// Every hand the provider holds, to change its route.
    pub(super) fn hands_mut(&mut self) -> impl Iterator<Item = &mut HandedMessage> {
        self.handed.values_mut()
    }

    /// Forgets the hand of `item_id`, a message never handed left as it is.
    pub(super) fn forget_hand(&mut self, item_id: &QueueItemId) {
        if self.handed.remove(item_id).is_some() {
            self.forgotten_hands += 1;
        }
    }

    /// Forgets every hand `keep` refuses.
    pub(super) fn retain_hands(&mut self, mut keep: impl FnMut(&HandedMessage) -> bool) {
        let held = self.handed.len();
        self.handed.retain(|_, handed| keep(handed));
        if self.handed.len() < held {
            self.forgotten_hands += 1;
        }
    }

    /// How many times a hand was forgotten: a reader of the waiting messages compares it from
    /// before its read to under the lock, and reads again when it moved.
    pub(super) fn forgotten_hands(&self) -> u64 {
        self.forgotten_hands
    }

    /// Marks each of `items` handed for `run_id` by `route` to the process `process`, each under a
    /// fresh hand number.
    pub(super) fn mark_handed(
        &mut self,
        items: &[QueueItemRecord],
        run_id: RunId,
        route: HandRoute,
        process: Option<ProviderProcessIdentity>,
    ) {
        for item in items {
            self.next_hand_number += 1;
            self.handed.insert(
                item.id,
                HandedMessage {
                    run_id,
                    route,
                    process,
                    hand_number: self.next_hand_number,
                },
            );
        }
    }

    /// Records `run_id` as owed a resume at the release of the undos holding `session_id`, once,
    /// and answers whether any holds it; nothing is recorded when none does.
    pub(super) fn owe_resume_after_undo(&mut self, session_id: SessionId, run_id: RunId) -> bool {
        let Some(holders) = self.undo_holds.get_mut(&session_id) else {
            return false;
        };
        if !holders.owed_resumes.contains(&run_id) {
            holders.owed_resumes.push(run_id);
        }
        true
    }

    /// A fresh undo hold's id, no other hold's.
    pub(super) fn mint_undo_hold_id(&mut self) -> UndoHoldId {
        self.next_undo_hold_id += 1;
        UndoHoldId(self.next_undo_hold_id)
    }

    /// The messages of `lead_waiting` that go now: not handed, except by a continue no resume
    /// keeps when `rereads_continue` (a continue that did not go delivered nothing), not kept for
    /// a next turn, and none of a session an undo holds.
    pub(super) fn unhanded_of(
        &self,
        lead_waiting: Vec<QueueItemRecord>,
        rereads_continue: bool,
    ) -> Vec<QueueItemRecord> {
        lead_waiting
            .into_iter()
            .filter(|item| {
                let is_free = match self.handed.get(&item.id) {
                    None => true,
                    Some(handed) => match handed.route {
                        HandRoute::Continue { is_kept, .. } => rereads_continue && !is_kept,
                        HandRoute::Driver(_) => false,
                    },
                };
                is_free
                    && !self.next_turn_runs.contains_key(&item.id)
                    && !self.undo_holds.contains_key(&item.session_id)
            })
            .collect()
    }

    /// The ids of the messages the continue of `run_id` holds, kept by an earlier resume or not as
    /// `is_kept` says.
    pub(super) fn continued_of(&self, run_id: RunId, is_kept: bool) -> Vec<QueueItemId> {
        self.handed
            .iter()
            .filter(|(_, handed)| {
                let is_continue_kept = match handed.route {
                    HandRoute::Continue { is_kept, .. } => Some(is_kept),
                    HandRoute::Driver(_) => None,
                };
                handed.run_id == run_id && is_continue_kept == Some(is_kept)
            })
            .map(|(item_id, _)| *item_id)
            .collect()
    }

    /// Whether a run in `state` takes a message at once: while a turn runs or waits on an
    /// approval, and while it waits on input only when its provider holds a credits choice, which
    /// the message settles.
    pub(super) fn takes_messages_now(&self, state: RunState, run_id: RunId) -> bool {
        match state {
            RunState::Running | RunState::WaitingForApproval => true,
            RunState::WaitingForInput => self.credits_choice_runs.contains(&run_id),
            RunState::Queued
            | RunState::Starting
            | RunState::Pausing
            | RunState::Paused
            | RunState::Completed
            | RunState::Interrupted
            | RunState::Stopped
            | RunState::Failed => false,
        }
    }
}

/// Whether `handed` is kept by the provider process it went to, which is still the session's
/// process `live_process`, for a turn that process starts with it: a driver's hand, or one a
/// resume kept, its outcome unknown. A new process that reuses the old one's id keeps nothing,
/// since its spawn sequence differs.
pub(super) fn is_kept_by_process(
    handed: &HandedMessage,
    live_process: Option<ProviderProcessIdentity>,
) -> bool {
    let handing = match handed.route {
        HandRoute::Driver(handing)
        | HandRoute::Continue {
            is_kept: true,
            handing,
        } => handing,
        HandRoute::Continue { is_kept: false, .. } => return false,
    };
    handing.kept_by_process && handed.process.is_some() && handed.process == live_process
}
