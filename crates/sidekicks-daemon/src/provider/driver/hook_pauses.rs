//! The pauses a driver's hooks keep, whatever the provider: which conversations are paused, the
//! lead's or a helper's, the calls each pause holds until it continues or lets go, and when a
//! pause took effect. Each driver maps a pause's state to its own provider's hook answers.

use std::collections::HashMap;
use std::hash::Hash;

use sidekicks_contracts::session::id::SessionId;

/// The reason a paused lead's denied tool call gives the model, which it reads.
pub(crate) const PAUSED_REASON: &str = "Paused by you";

/// Whose conversation a pause is on: the session's lead or one of its helpers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PausedRole {
    /// The session's own conversation.
    Lead,
    /// A helper's conversation.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "run control pauses a helper's run on its own conversation"
        )
    )]
    Helper,
}

/// One pause in force on a conversation: its session, its role, what the driver keeps of it, the
/// calls it holds, and whether it took effect and that was reported.
#[derive(Debug)]
pub(crate) struct HookPause<Detail, Held> {
    /// The session the conversation belongs to.
    session_id: SessionId,
    /// Whose conversation it is.
    role: PausedRole,
    /// What the driver keeps of the pause, such as the run it stops.
    detail: Detail,
    /// The calls held until the pause continues, in the order they arrived.
    held: Vec<Held>,
    /// Whether the pause has stopped the conversation: its first held call, or the driver's mark.
    has_taken_effect: bool,
    /// Whether the pause's effect has been reported.
    #[expect(
        dead_code,
        reason = "Claude Code's run control reports its lead's pause once through it"
    )]
    is_effect_reported: bool,
}

impl<Detail, Held> HookPause<Detail, Held> {
    /// The session the paused conversation belongs to.
    pub(crate) fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    /// Whose conversation is paused.
    pub(crate) fn role(&self) -> PausedRole {
        self.role
    }

    /// What the driver keeps of the pause.
    pub(crate) fn detail(&self) -> &Detail {
        &self.detail
    }
}

/// A pause that ended by a continue or a let-go: what the driver kept of it, the calls it held,
/// which the driver answers, and whether it had taken effect.
#[derive(Debug)]
pub(crate) struct EndedHookPause<Detail, Held> {
    /// What the driver kept of the pause.
    pub(crate) detail: Detail,
    /// The calls it held, in the order they arrived.
    pub(crate) held: Vec<Held>,
    /// Whether the pause had stopped the conversation.
    pub(crate) had_taken_effect: bool,
}

/// Every conversation's pause, keyed by how the driver names a conversation.
#[derive(Debug)]
pub(crate) struct HookPauses<Conversation, Detail, Held> {
    /// The pauses in force.
    pauses: HashMap<Conversation, HookPause<Detail, Held>>,
}

impl<Conversation, Detail, Held> Default for HookPauses<Conversation, Detail, Held> {
    fn default() -> Self {
        Self {
            pauses: HashMap::new(),
        }
    }
}

impl<Conversation: Eq + Hash, Detail, Held> HookPauses<Conversation, Detail, Held> {
    /// Pauses `conversation` from its next hook on; a pause already in place is kept as it is.
    pub(crate) fn pause(
        &mut self,
        conversation: Conversation,
        session_id: SessionId,
        role: PausedRole,
        detail: Detail,
    ) {
        self.pauses.entry(conversation).or_insert(HookPause {
            session_id,
            role,
            detail,
            held: Vec::new(),
            has_taken_effect: false,
            is_effect_reported: false,
        });
    }

    /// The pause in force on `conversation`, or `None`.
    pub(crate) fn get(&self, conversation: &Conversation) -> Option<&HookPause<Detail, Held>> {
        self.pauses.get(conversation)
    }

    /// The conversation whose pause `is_sought` picks, or `None`.
    pub(crate) fn find(
        &self,
        is_sought: impl Fn(&HookPause<Detail, Held>) -> bool,
    ) -> Option<&Conversation> {
        self.pauses
            .iter()
            .find_map(|(conversation, pause)| is_sought(pause).then_some(conversation))
    }

    /// Holds `held` on `conversation`'s pause until it continues. `None` when the conversation is
    /// not paused, which holds nothing; else whether this hold is the pause taking effect.
    pub(crate) fn hold(&mut self, conversation: &Conversation, held: Held) -> Option<bool> {
        let pause = self.pauses.get_mut(conversation)?;
        pause.held.push(held);
        let is_taking_effect = !pause.has_taken_effect;
        pause.has_taken_effect = true;
        Some(is_taking_effect)
    }

    /// Marks `conversation`'s pause as having stopped it, where the driver stops a conversation
    /// with no held call. Answers whether the conversation is paused.
    pub(crate) fn mark_taken_effect(&mut self, conversation: &Conversation) -> bool {
        let Some(pause) = self.pauses.get_mut(conversation) else {
            return false;
        };
        pause.has_taken_effect = true;
        true
    }

    /// The detail of `conversation`'s pause the first time it is asked after the pause took
    /// effect, so the effect is reported once; `None` before it took effect and after it was
    /// reported.
    #[expect(
        dead_code,
        reason = "Claude Code's run control reports its lead's pause once through it"
    )]
    pub(crate) fn report_effect(&mut self, conversation: &Conversation) -> Option<&Detail> {
        let pause = self.pauses.get_mut(conversation)?;
        if !pause.has_taken_effect || pause.is_effect_reported {
            return None;
        }
        pause.is_effect_reported = true;
        Some(&pause.detail)
    }

    /// The detail of `conversation`'s pause once its effect was reported, while it holds; `None`
    /// otherwise.
    #[expect(
        dead_code,
        reason = "Claude Code's run control reports its lead's pause once through it"
    )]
    pub(crate) fn reported(&self, conversation: &Conversation) -> Option<&Detail> {
        self.pauses
            .get(conversation)
            .filter(|pause| pause.is_effect_reported)
            .map(|pause| &pause.detail)
    }

    /// Takes the calls `conversation`'s pause holds, which the driver answers now, the pause
    /// staying in force; none when it is not paused.
    pub(crate) fn take_held(&mut self, conversation: &Conversation) -> Vec<Held> {
        self.pauses
            .get_mut(conversation)
            .map(|pause| std::mem::take(&mut pause.held))
            .unwrap_or_default()
    }

    /// Ends `conversation`'s pause, handing back what it held for the driver to answer; `None`
    /// when it was not paused.
    pub(crate) fn resume(
        &mut self,
        conversation: &Conversation,
    ) -> Option<EndedHookPause<Detail, Held>> {
        self.pauses
            .remove(conversation)
            .map(|pause| EndedHookPause {
                detail: pause.detail,
                held: pause.held,
                had_taken_effect: pause.has_taken_effect,
            })
    }

    /// Drops every held call of `session_id` that `is_withdrawn` picks, one the provider withdrew
    /// or that no longer waits; it is not answered.
    pub(crate) fn withdraw_held(
        &mut self,
        session_id: &SessionId,
        is_withdrawn: impl Fn(&Held) -> bool,
    ) {
        for pause in self
            .pauses
            .values_mut()
            .filter(|pause| pause.session_id == *session_id)
        {
            pause.held.retain(|held| !is_withdrawn(held));
        }
    }

    /// Ends every pause of `session_id`, whose conversations are gone, handing back each one's
    /// conversation and what it held.
    pub(crate) fn forget_session(
        &mut self,
        session_id: &SessionId,
    ) -> Vec<(Conversation, EndedHookPause<Detail, Held>)> {
        let (forgotten, kept) = std::mem::take(&mut self.pauses)
            .into_iter()
            .partition(|(_, pause)| pause.session_id == *session_id);
        self.pauses = kept;
        forgotten
            .into_iter()
            .map(
                |(conversation, pause): (Conversation, HookPause<Detail, Held>)| {
                    (
                        conversation,
                        EndedHookPause {
                            detail: pause.detail,
                            held: pause.held,
                            had_taken_effect: pause.has_taken_effect,
                        },
                    )
                },
            )
            .collect()
    }
}
