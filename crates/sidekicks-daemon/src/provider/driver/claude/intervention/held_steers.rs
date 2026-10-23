//! The steers held behind a person's `Send now` while Claude Code holds an ask, a question or a
//! choice open: a `now` message would cancel the open card, so the priority row waits for the
//! card's close, and every steer handed after it waits behind it, keeping the queue's order.

use std::collections::{HashMap, VecDeque};

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::claude::session::transport::user_message::ClaudeUserContentBlock;

/// One steer as the driver writes it: the person's words and files' blocks, for its run.
#[derive(Clone)]
pub(crate) struct ClaudeSteer {
    /// The run the steer goes to.
    pub(crate) run_id: RunId,
    /// The message's own id, which its user frame carries.
    pub(crate) message_id: QueueItemId,
    /// The words.
    pub(crate) content: String,
    /// The blocks of its files, in staging order.
    pub(crate) attachment_blocks: Vec<ClaudeUserContentBlock>,
    /// Whether it carries Claude Code's `now` mark.
    pub(crate) is_priority: bool,
}

// One session's held rows, under the hold that opened them, so a release meant for an earlier
// hold never writes a later one.
struct HeldRows {
    hold: u64,
    rows: VecDeque<ClaudeSteer>,
}

/// Each session's held rows.
#[derive(Default)]
pub(crate) struct ClaudeHeldSteers {
    by_session: HashMap<SessionId, HeldRows>,
    next_hold: u64,
}

impl ClaudeHeldSteers {
    /// Holds `steer` for the session: a priority row first, any other behind the rows held. Answers
    /// the new hold's number when this opened the session's hold, which its release names.
    pub(crate) fn hold(&mut self, session_id: SessionId, steer: ClaudeSteer) -> Option<u64> {
        if let Some(held) = self.by_session.get_mut(&session_id) {
            if steer.is_priority {
                held.rows.push_front(steer);
            } else {
                held.rows.push_back(steer);
            }
            return None;
        }
        self.next_hold += 1;
        self.by_session.insert(
            session_id,
            HeldRows {
                hold: self.next_hold,
                rows: VecDeque::from([steer]),
            },
        );
        Some(self.next_hold)
    }

    /// Whether the session holds any row.
    pub(crate) fn is_holding(&self, session_id: SessionId) -> bool {
        self.by_session.contains_key(&session_id)
    }

    /// Takes the session's rows in order when they are still the ones `hold` opened.
    pub(crate) fn take_released(&mut self, session_id: SessionId, hold: u64) -> Vec<ClaudeSteer> {
        if self
            .by_session
            .get(&session_id)
            .is_none_or(|held| held.hold != hold)
        {
            return Vec::new();
        }
        self.take_all(session_id)
    }

    /// Takes every row the session holds, in order.
    pub(crate) fn take_all(&mut self, session_id: SessionId) -> Vec<ClaudeSteer> {
        self.by_session
            .remove(&session_id)
            .map(|held| held.rows.into())
            .unwrap_or_default()
    }

    /// Withdraws one held row, which was never written; answers whether it was held.
    pub(crate) fn withdraw(&mut self, session_id: SessionId, message_id: &QueueItemId) -> bool {
        let Some(held) = self.by_session.get_mut(&session_id) else {
            return false;
        };
        let count = held.rows.len();
        held.rows.retain(|row| row.message_id != *message_id);
        let is_withdrawn = held.rows.len() < count;
        if held.rows.is_empty() {
            self.by_session.remove(&session_id);
        }
        is_withdrawn
    }
}
