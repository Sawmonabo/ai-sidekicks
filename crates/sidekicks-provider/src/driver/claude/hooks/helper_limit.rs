//! The person's `Helpers at once` on Claude Code: the pre-tool hook on the helper tool lets a new
//! helper start while fewer than the limit run, and holds its start unanswered until one of the
//! session's running helpers finishes. Claude Code has no limit of its own to set.

use std::collections::{HashMap, HashSet, VecDeque};
use std::num::NonZeroUsize;

use sidekicks_contracts::session::id::SessionId;

use crate::thread_frame_router::{SubagentLifecycleEmission, SubagentLifecycleEventType};

// A held helper-tool callback: its request id and its tool call id.
struct HeldStart {
    request_id: String,
    tool_use_id: String,
}

// One session's helpers: its limit, admitted starts, running helpers and held starts.
struct ClaudeSessionHelpers {
    limit: NonZeroUsize,
    // Helper-tool calls let through whose helper has not announced itself yet, by tool call id.
    admitted_starts: HashSet<String>,
    running_helper_ids: HashSet<String>,
    // In arrival order.
    held_starts: VecDeque<HeldStart>,
}

impl ClaudeSessionHelpers {
    fn has_room(&self) -> bool {
        self.admitted_starts.len() + self.running_helper_ids.len() < self.limit.get()
    }

    // Admits held starts, oldest first, while the session has room, and answers their request
    // ids.
    fn admit_held_starts(&mut self) -> Vec<String> {
        let mut admitted = Vec::new();
        while self.has_room() {
            let Some(next) = self.held_starts.pop_front() else {
                break;
            };
            self.admitted_starts.insert(next.tool_use_id);
            admitted.push(next.request_id);
        }
        admitted
    }
}

/// How the limit answers one helper-tool callback: let it through now, or hold it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeHelperStartAnswer {
    /// Answer now: the helper may start.
    Admit,
    /// Leave the callback unanswered until a running helper finishes.
    Hold,
}

/// Every session's helper limit and the starts it holds.
#[derive(Default)]
pub(crate) struct ClaudeHelperLimit {
    sessions: HashMap<SessionId, ClaudeSessionHelpers>,
}

impl ClaudeHelperLimit {
    /// Sets the session's limit on helpers running at once, starting its count afresh.
    pub(crate) fn limit_session(&mut self, session_id: &SessionId, limit: NonZeroUsize) {
        self.sessions.insert(
            *session_id,
            ClaudeSessionHelpers {
                limit,
                admitted_starts: HashSet::new(),
                running_helper_ids: HashSet::new(),
                held_starts: VecDeque::new(),
            },
        );
    }

    /// Answers a new helper's start: admitted while the session runs fewer than its limit, or
    /// when the session has no limit.
    pub(crate) fn answer_start(
        &mut self,
        session_id: &SessionId,
        request_id: &str,
        tool_use_id: &str,
    ) -> ClaudeHelperStartAnswer {
        let Some(helpers) = self.sessions.get_mut(session_id) else {
            return ClaudeHelperStartAnswer::Admit;
        };
        if helpers.has_room() {
            helpers.admitted_starts.insert(tool_use_id.to_owned());
            return ClaudeHelperStartAnswer::Admit;
        }
        helpers.held_starts.push_back(HeldStart {
            request_id: request_id.to_owned(),
            tool_use_id: tool_use_id.to_owned(),
        });
        ClaudeHelperStartAnswer::Hold
    }

    /// Counts the helpers one frame started and ended, and answers the held starts their ends
    /// free, oldest first, each now admitted, by their request ids.
    pub(crate) fn observe_lifecycle(
        &mut self,
        session_id: &SessionId,
        emissions: &[SubagentLifecycleEmission],
    ) -> Vec<String> {
        let mut admitted = Vec::new();
        for emission in emissions {
            match emission.event_type {
                SubagentLifecycleEventType::Started => {
                    if let Some(parent_tool_use_id) = &emission.parent_tool_call_id {
                        self.helper_started(session_id, &emission.subagent_id, parent_tool_use_id);
                    }
                }
                SubagentLifecycleEventType::Completed => {
                    admitted.extend(self.helper_finished(session_id, &emission.subagent_id));
                }
            }
        }
        admitted
    }

    // Records a helper's announcement, by the helper-tool call that started it.
    fn helper_started(
        &mut self,
        session_id: &SessionId,
        helper_id: &str,
        parent_tool_use_id: &str,
    ) {
        let Some(helpers) = self.sessions.get_mut(session_id) else {
            return;
        };
        helpers.admitted_starts.remove(parent_tool_use_id);
        helpers.running_helper_ids.insert(helper_id.to_owned());
    }

    // Records a helper's end and answers the held starts it frees, oldest first, each now
    // admitted, by their request ids.
    fn helper_finished(&mut self, session_id: &SessionId, helper_id: &str) -> Vec<String> {
        let Some(helpers) = self.sessions.get_mut(session_id) else {
            return Vec::new();
        };
        helpers.running_helper_ids.remove(helper_id);
        helpers.admit_held_starts()
    }

    /// At the end of the lead's turn, an admitted start that never announced a helper never will:
    /// it is let go, and the held starts it frees are answered by their request ids.
    pub(crate) fn turn_ended(&mut self, session_id: &SessionId) -> Vec<String> {
        let Some(helpers) = self.sessions.get_mut(session_id) else {
            return Vec::new();
        };
        helpers.admitted_starts.clear();
        helpers.admit_held_starts()
    }

    /// Drops a held start Claude Code withdrew.
    pub(crate) fn withdraw_start(&mut self, session_id: &SessionId, request_id: &str) {
        if let Some(helpers) = self.sessions.get_mut(session_id)
            && let Some(index) = helpers
                .held_starts
                .iter()
                .position(|held| held.request_id == request_id)
        {
            helpers.held_starts.remove(index);
        }
    }

    /// Forgets a session whose process is gone; its helpers went with it.
    pub(crate) fn forget_session(&mut self, session_id: &SessionId) {
        self.sessions.remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;

    use sidekicks_contracts::session::id::SessionId;

    use super::{ClaudeHelperLimit, ClaudeHelperStartAnswer};
    use crate::thread_frame_router::{SubagentLifecycleEmission, SubagentLifecycleEventType};

    fn lifecycle(
        event_type: SubagentLifecycleEventType,
        parent_tool_call_id: &str,
    ) -> [SubagentLifecycleEmission; 1] {
        [SubagentLifecycleEmission {
            event_type,
            subagent_id: "h1".to_owned(),
            parent_tool_call_id: Some(parent_tool_call_id.to_owned()),
        }]
    }

    // A session limited to one helper at once, with `r1` admitted and `r2` held behind it.
    fn one_admitted_one_held() -> (ClaudeHelperLimit, SessionId) {
        let session_id =
            SessionId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d").expect("a valid session id");
        let mut limit = ClaudeHelperLimit::default();
        limit.limit_session(&session_id, NonZeroUsize::MIN);
        assert_eq!(
            limit.answer_start(&session_id, "r1", "t1"),
            ClaudeHelperStartAnswer::Admit
        );
        assert_eq!(
            limit.answer_start(&session_id, "r2", "t2"),
            ClaudeHelperStartAnswer::Hold
        );
        (limit, session_id)
    }

    // Killed by a helper's start left uncounted, which frees the held start at the turn's end
    // while the helper still runs, and by its end left uncounted, which holds it for good.
    #[test]
    fn a_held_start_waits_for_a_running_helper_to_finish() {
        let (mut limit, session_id) = one_admitted_one_held();
        let started = lifecycle(SubagentLifecycleEventType::Started, "t1");
        assert_eq!(
            limit.observe_lifecycle(&session_id, &started),
            Vec::<String>::new()
        );
        assert_eq!(limit.turn_ended(&session_id), Vec::<String>::new());

        let completed = lifecycle(SubagentLifecycleEventType::Completed, "t1");
        assert_eq!(limit.observe_lifecycle(&session_id, &completed), ["r2"]);
    }

    #[test]
    fn a_turn_end_frees_an_admitted_start_that_never_announced() {
        let (mut limit, session_id) = one_admitted_one_held();

        assert_eq!(limit.turn_ended(&session_id), ["r2"]);
    }

    #[test]
    fn a_withdrawn_hold_is_never_admitted() {
        let (mut limit, session_id) = one_admitted_one_held();
        limit.withdraw_start(&session_id, "r2");

        assert_eq!(limit.turn_ended(&session_id), Vec::<String>::new());
    }
}
