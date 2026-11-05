//! The person's `Helpers at once` on Claude Code: the pre-tool hook on the helper and message tools
//! lets a new helper start, or a message wake a helper that had ended, while fewer than the limit
//! run, and holds the call unanswered until one of the session's running helpers finishes. The
//! running helpers are the ones the session's routing holds, so the count has one source.

use std::collections::{HashMap, HashSet, VecDeque};
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::session::state::ClaudeSessionRoutingBand;
#[cfg(test)]
use crate::driver::test_registry::fixed_session_id;
#[cfg(test)]
use crate::thread_frame_router::ChildThreadAnnouncement;
use crate::thread_frame_router::{SubagentLifecycleEmission, SubagentLifecycleEventType};

// A held helper-tool callback: its request id and its tool call id.
struct HeldStart {
    request_id: String,
    tool_use_id: String,
}

// One session's helpers: its limit, the routing band of its process, admitted starts and held
// starts.
struct ClaudeSessionHelpers {
    limit: NonZeroUsize,
    // Whose router holds the session's running helpers.
    band: Arc<Mutex<ClaudeSessionRoutingBand>>,
    // Helper-tool calls let through whose helper has not announced itself yet, by tool call id.
    admitted_starts: HashSet<String>,
    // In arrival order.
    held_starts: VecDeque<HeldStart>,
}

impl ClaudeSessionHelpers {
    // How many more helpers may start now.
    fn room(&self) -> usize {
        let running = lock(&self.band).router.running_subagent_count();
        self.limit
            .get()
            .saturating_sub(self.admitted_starts.len() + running)
    }

    // Admits held starts, oldest first, while the session has room, and answers their request
    // ids.
    fn admit_held_starts(&mut self) -> Vec<String> {
        let room = self.room().min(self.held_starts.len());
        self.held_starts
            .drain(..room)
            .map(|next| {
                self.admitted_starts.insert(next.tool_use_id);
                next.request_id
            })
            .collect()
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
    /// Sets the session's limit on helpers running at once, counting the helpers `band`'s router
    /// holds for the session's process, and starts its admitted and held starts afresh.
    pub(crate) fn limit_session(
        &mut self,
        session_id: &SessionId,
        limit: NonZeroUsize,
        band: Arc<Mutex<ClaudeSessionRoutingBand>>,
    ) {
        self.sessions.insert(
            *session_id,
            ClaudeSessionHelpers {
                limit,
                band,
                admitted_starts: HashSet::new(),
                held_starts: VecDeque::new(),
            },
        );
    }

    /// Answers a new helper's start, or the wake of an ended one by a message, either named by
    /// its tool call `tool_use_id`: admitted while the session runs fewer than its limit, or when
    /// the session has no limit.
    pub(crate) fn answer_start(
        &mut self,
        session_id: &SessionId,
        request_id: &str,
        tool_use_id: &str,
    ) -> ClaudeHelperStartAnswer {
        let Some(helpers) = self.sessions.get_mut(session_id) else {
            return ClaudeHelperStartAnswer::Admit;
        };
        if helpers.room() > 0 {
            helpers.admitted_starts.insert(tool_use_id.to_owned());
            return ClaudeHelperStartAnswer::Admit;
        }
        helpers.held_starts.push_back(HeldStart {
            request_id: request_id.to_owned(),
            tool_use_id: tool_use_id.to_owned(),
        });
        ClaudeHelperStartAnswer::Hold
    }

    /// Takes the helpers one frame started and ended and the tool calls its results answered: a
    /// start's helper-tool call counts as running from here on through the routing, an admitted
    /// call answered with no helper started, such as one another hook denied, stops counting, and
    /// the held starts these free are answered, oldest first, each now admitted, by their request
    /// ids.
    pub(crate) fn observe_lifecycle(
        &mut self,
        session_id: &SessionId,
        emissions: &[SubagentLifecycleEmission],
        answered_call_ids: &[String],
    ) -> Vec<String> {
        if emissions.is_empty() && answered_call_ids.is_empty() {
            return Vec::new();
        }
        let Some(helpers) = self.sessions.get_mut(session_id) else {
            return Vec::new();
        };
        for emission in emissions {
            if emission.event_type == SubagentLifecycleEventType::Started
                && let Some(parent_tool_use_id) = &emission.parent_tool_call_id
            {
                helpers.admitted_starts.remove(parent_tool_use_id);
            }
        }
        for call_id in answered_call_ids {
            helpers.admitted_starts.remove(call_id);
        }
        helpers.admit_held_starts()
    }

    /// How many admitted calls on the session have yet to start a helper.
    #[cfg(test)]
    pub(crate) fn admitted_start_count(&self, session_id: &SessionId) -> usize {
        self.sessions
            .get(session_id)
            .map_or(0, |helpers| helpers.admitted_starts.len())
    }

    /// At the end of the lead's turn, an admitted start that never announced a helper never
    /// will: it is let go, and the held starts it frees are answered by their request ids.
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

/// A session limited to one helper at once over a routing band that holds the session's own
/// thread, whose helpers a test starts and ends.
#[cfg(test)]
pub(in crate::driver::claude::hooks) struct OneHelperAtOnce {
    /// The limit, holding only this session.
    pub(in crate::driver::claude::hooks) limit: Mutex<ClaudeHelperLimit>,
    band: Arc<Mutex<ClaudeSessionRoutingBand>>,
}

#[cfg(test)]
impl OneHelperAtOnce {
    /// The limit on the fixed test session, with no helper started.
    pub(in crate::driver::claude::hooks) fn new() -> Self {
        let mut band = ClaudeSessionRoutingBand::new();
        drop(band.router.register_session_thread("session".to_owned()));
        let band = Arc::new(Mutex::new(band));
        let mut limit = ClaudeHelperLimit::default();
        limit.limit_session(&fixed_session_id(), NonZeroUsize::MIN, Arc::clone(&band));
        Self {
            limit: Mutex::new(limit),
            band,
        }
    }

    /// Announces the helper `helper_id`, started by the call `call_id`, as running, and returns
    /// the held requests that frees.
    pub(in crate::driver::claude::hooks) fn start_helper(
        &self,
        helper_id: &str,
        call_id: &str,
    ) -> Vec<String> {
        drop(
            lock(&self.band)
                .router
                .register_child_thread(ChildThreadAnnouncement {
                    child_thread_id: helper_id.to_owned(),
                    declared_parent_thread_id: Some("session".to_owned()),
                    subagent_id: Some(helper_id.to_owned()),
                    waiting_call_id: None,
                }),
        );
        self.observe(SubagentLifecycleEventType::Started, helper_id, call_id)
    }

    /// Ends the running helper `helper_id`, started by the call `call_id`, and returns the held
    /// requests released, oldest first.
    pub(in crate::driver::claude::hooks) fn end_helper(
        &self,
        helper_id: &str,
        call_id: &str,
    ) -> Vec<String> {
        assert!(lock(&self.band).router.complete_child_thread(helper_id));
        self.observe(SubagentLifecycleEventType::Completed, helper_id, call_id)
    }

    fn observe(
        &self,
        event_type: SubagentLifecycleEventType,
        helper_id: &str,
        call_id: &str,
    ) -> Vec<String> {
        lock(&self.limit).observe_lifecycle(
            &fixed_session_id(),
            &[SubagentLifecycleEmission {
                event_type,
                subagent_id: helper_id.to_owned(),
                parent_tool_call_id: Some(call_id.to_owned()),
            }],
            &[],
        )
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_std::mutex_lock::lock;

    use super::{ClaudeHelperStartAnswer, OneHelperAtOnce};
    use crate::driver::claude::session::scripted::channel::ScriptedWrite;
    use crate::driver::claude::session::scripted::driver::create_params;
    use crate::driver::claude::session::scripted::{ScriptedSession, settle};
    use crate::driver::session_control::{CreateSessionParams, SubagentPolicy};
    use crate::driver::test_registry::fixed_session_id;

    // A session limited to one helper at once, with `r1` admitted and `r2` held behind it.
    fn one_admitted_one_held() -> OneHelperAtOnce {
        let one = OneHelperAtOnce::new();
        let session_id = fixed_session_id();
        assert_eq!(
            lock(&one.limit).answer_start(&session_id, "r1", "t1"),
            ClaudeHelperStartAnswer::Admit
        );
        assert_eq!(
            lock(&one.limit).answer_start(&session_id, "r2", "t2"),
            ClaudeHelperStartAnswer::Hold
        );
        one
    }

    // Killed by a running helper the routing holds left uncounted, which frees the held start
    // at its start or the turn's end while the helper still runs.
    #[test]
    fn a_held_start_waits_for_a_running_helper_to_finish() {
        let one = one_admitted_one_held();
        assert_eq!(one.start_helper("h1", "t1"), Vec::<String>::new());
        assert_eq!(
            lock(&one.limit).turn_ended(&fixed_session_id()),
            Vec::<String>::new()
        );

        assert_eq!(one.end_helper("h1", "t1"), ["r2"]);
    }

    #[test]
    fn a_turn_end_frees_an_admitted_start_that_never_announced() {
        let one = one_admitted_one_held();

        assert_eq!(lock(&one.limit).turn_ended(&fixed_session_id()), ["r2"]);
    }

    #[test]
    fn a_withdrawn_hold_is_never_admitted() {
        let one = one_admitted_one_held();
        let session_id = fixed_session_id();
        lock(&one.limit).withdraw_start(&session_id, "r2");

        assert_eq!(
            lock(&one.limit).turn_ended(&session_id),
            Vec::<String>::new()
        );
    }

    // The requests the session's process had answered, in order.
    fn answered(session: &ScriptedSession) -> Vec<String> {
        session
            .channel
            .writes()
            .into_iter()
            .filter_map(|write| match write {
                ScriptedWrite::Answer { request_id, .. } => Some(request_id),
                ScriptedWrite::Control(_) | ScriptedWrite::User(_) | ScriptedWrite::Terminate => {
                    None
                }
            })
            .collect()
    }

    // A foreground helper's call is answered only once the helper finished, so its result frees
    // the helper's slot though no `task_notification` came; a background helper's call is
    // answered at once and its helper runs on. Killed by the completion at the call's result
    // deleted (`r2` held for good), and by one that ignores the background (`r2` admitted early).
    #[rstest]
    #[case::foreground(false, &["r1", "r2"])]
    #[case::background(true, &["r1"])]
    #[tokio::test(start_paused = true)]
    async fn a_helpers_call_result_frees_its_slot_only_in_the_foreground(
        #[case] is_backgrounded: bool,
        #[case] answered_after: &[&str],
    ) {
        let session = ScriptedSession::created_with(|session_id| CreateSessionParams {
            subagent_policy: Some(SubagentPolicy::Enabled {
                helpers_at_once: Some(SafeInt::new(1).expect("1 is a safe integer")),
                definitions: Vec::new(),
            }),
            ..create_params(session_id)
        })
        .await;
        session.hold_lead_turn("lead");
        let helper_start = |tool_use_id: &str| {
            json!({
                "subtype": "hook_callback",
                "callback_id": "sidekicks-helper-limit",
                "input": {
                    "hook_event_name": "PreToolUse",
                    "tool_name": "Agent",
                    "tool_use_id": tool_use_id,
                },
            })
        };
        session.request("r1", &helper_start("call-1"));
        session.request("r2", &helper_start("call-2"));
        settle().await;
        assert_eq!(answered(&session), ["r1"]);

        session.frame(&json!({
            "type": "system",
            "subtype": "task_started",
            "task_id": "helper-1",
            "task_type": "local_agent",
            "tool_use_id": "call-1",
            "is_backgrounded": is_backgrounded,
        }));
        session.frame(&json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": "done"}],
            },
        }));
        settle().await;

        assert_eq!(answered(&session), answered_after);
    }

    // A helper a `SendMessage` call wakes runs on past the call's result, whether its foreground
    // start comes before or after the call, so its slot stays taken. Killed by the call's result
    // read as the woken helper's end (`r1` admitted while the helper runs).
    #[rstest]
    #[case::call_first(true)]
    #[case::start_first(false)]
    #[tokio::test(start_paused = true)]
    async fn a_helper_a_message_woke_keeps_its_slot_past_the_messages_result(
        #[case] is_call_first: bool,
    ) {
        let session = ScriptedSession::created_with(|session_id| CreateSessionParams {
            subagent_policy: Some(SubagentPolicy::Enabled {
                helpers_at_once: Some(SafeInt::new(1).expect("1 is a safe integer")),
                definitions: Vec::new(),
            }),
            ..create_params(session_id)
        })
        .await;
        session.hold_lead_turn("lead");
        let call = json!({
            "type": "assistant",
            "message": {
                "id": "message-1",
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "send-1", "name": "SendMessage", "input": {}},
                ],
            },
        });
        let start = json!({
            "type": "system",
            "subtype": "task_started",
            "task_id": "helper-1",
            "task_type": "local_agent",
            "tool_use_id": "send-1",
            "is_backgrounded": false,
        });
        if is_call_first {
            session.frame(&call);
            session.frame(&start);
        } else {
            session.frame(&start);
            session.frame(&call);
        }
        session.request(
            "r1",
            &json!({
                "subtype": "hook_callback",
                "callback_id": "sidekicks-helper-limit",
                "input": {
                    "hook_event_name": "PreToolUse",
                    "tool_name": "Agent",
                    "tool_use_id": "call-1",
                },
            }),
        );
        session.frame(&json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "send-1", "content": "sent"}],
            },
        }));
        settle().await;

        assert_eq!(answered(&session), Vec::<String>::new());
    }
}
