//! The person's `Helpers at once` on Claude Code: the pre-tool hook on the helper and message tools
//! lets a new helper start, or a message wake a helper that had ended, while fewer than the limit
//! run, and holds the call unanswered until one of the session's running helpers finishes. A
//! session's helpers are those of its own process and of each one-turn copy of it, each process's
//! running ones the ones its own routing band holds, so the count has one source per process.

pub(crate) mod copy;

use std::collections::{HashMap, HashSet, VecDeque};
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

#[cfg(test)]
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::hooks::callbacks::answer_claude_request;
use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
#[cfg(test)]
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::state::ClaudeSessionRoutingBand;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::session_control::SubagentPolicy;
#[cfg(test)]
use crate::driver::test_registry::fixed_session_id;
#[cfg(test)]
use crate::thread_frame_router::ChildThreadAnnouncement;
use crate::thread_frame_router::{SubagentLifecycleEmission, SubagentLifecycleEventType};

/// One of a session's processes whose helpers count against the session's limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ClaudeCountedProcess {
    /// The session's own process.
    Session,
    /// A one-turn copy of the session, by the number the limit gave it.
    Copy(u64),
}

/// A process whose helpers count: the band whose router holds its running helpers, and the channel
/// its held starts are answered on, with the account it runs on.
#[derive(Clone)]
pub(crate) struct ClaudeHelperProcess {
    /// Whose router holds the process's running helpers.
    pub(crate) band: Arc<Mutex<ClaudeSessionRoutingBand>>,
    /// The process's channel.
    pub(crate) channel: Arc<dyn ClaudeProcessChannel>,
    /// The account the process runs on.
    pub(crate) account: ClaudeProcessAccount,
}

/// A held start the limit admitted, to be answered with a pass on the process that sent it.
pub(crate) struct ClaudeAdmittedStart {
    channel: Arc<dyn ClaudeProcessChannel>,
    account: ClaudeProcessAccount,
    /// The held callback's request id.
    pub(crate) request_id: String,
}

/// Answers each start in `admitted` with a pass on its own process, in order; an answer that
/// cannot be written stops that process, as [`answer_claude_request`] does.
pub(crate) async fn answer_admitted_starts(
    session_id: &SessionId,
    admitted: Vec<ClaudeAdmittedStart>,
) {
    for start in admitted {
        let provider_account_id = start
            .account
            .read()
            .expect("a session's process and its copies are each made on an account");
        answer_claude_request(
            &*start.channel,
            session_id,
            &provider_account_id,
            start.request_id,
            &ClaudeHookAnswer::Pass,
        )
        .await;
    }
}

// A held helper-tool callback: the process that sent it, its request id and its tool call id.
struct HeldStart {
    process: ClaudeCountedProcess,
    request_id: String,
    tool_use_id: String,
}

// One counted process, with the helper-tool calls let through whose helper has not announced
// itself yet, by tool call id.
struct CountedProcess {
    process: ClaudeHelperProcess,
    admitted_starts: HashSet<String>,
}

impl CountedProcess {
    // How many helpers it counts now: its admitted starts and its running helpers.
    fn count(&self) -> usize {
        self.admitted_starts.len() + lock(&self.process.band).router.running_subagent_count()
    }
}

// One session's helpers: its limit, each process counted, and the starts held, in arrival order.
struct ClaudeSessionHelpers {
    limit: NonZeroUsize,
    processes: HashMap<ClaudeCountedProcess, CountedProcess>,
    held_starts: VecDeque<HeldStart>,
}

impl ClaudeSessionHelpers {
    fn new(limit: NonZeroUsize) -> Self {
        Self {
            limit,
            processes: HashMap::new(),
            held_starts: VecDeque::new(),
        }
    }

    // How many more helpers may start now.
    fn room(&self) -> usize {
        let counted: usize = self.processes.values().map(CountedProcess::count).sum();
        self.limit.get().saturating_sub(counted)
    }

    // Admits held starts, oldest first, while the session has room.
    fn admit_held_starts(&mut self) -> Vec<ClaudeAdmittedStart> {
        let room = self.room().min(self.held_starts.len());
        let mut admitted = Vec::with_capacity(room);
        for held in self.held_starts.drain(..room) {
            let counted = self
                .processes
                .get_mut(&held.process)
                .expect("a process's held starts are dropped when it stops counting");
            counted.admitted_starts.insert(held.tool_use_id);
            admitted.push(ClaudeAdmittedStart {
                channel: Arc::clone(&counted.process.channel),
                account: counted.process.account.clone(),
                request_id: held.request_id,
            });
        }
        admitted
    }

    // Puts `process` in the count afresh, dropping any starts an earlier one under its key held.
    fn count(&mut self, key: ClaudeCountedProcess, process: ClaudeHelperProcess) {
        self.held_starts.retain(|held| held.process != key);
        self.processes.insert(
            key,
            CountedProcess {
                process,
                admitted_starts: HashSet::new(),
            },
        );
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

/// Every session's helper limit, the processes it counts and the starts it holds.
#[derive(Default)]
pub(crate) struct ClaudeHelperLimit {
    sessions: HashMap<SessionId, ClaudeSessionHelpers>,
    next_copy: u64,
}

impl ClaudeHelperLimit {
    /// The limit `subagent_policy` sets on helpers running at once; `None` where it sets none,
    /// which is no limit.
    pub(crate) fn limit_of(subagent_policy: Option<&SubagentPolicy>) -> Option<NonZeroUsize> {
        let Some(SubagentPolicy::Enabled {
            helpers_at_once: Some(helpers_at_once),
            ..
        }) = subagent_policy
        else {
            return None;
        };
        Some(
            usize::try_from(helpers_at_once.get())
                .ok()
                .and_then(NonZeroUsize::new)
                .unwrap_or(NonZeroUsize::MAX),
        )
    }

    /// Counts the session's own `process` under `limit`, which becomes the session's: any starts
    /// an earlier own process held are let go with it, while a copy counted meanwhile keeps its
    /// helpers and held starts. Answers the held starts a larger limit admits.
    pub(crate) fn limit_session(
        &mut self,
        session_id: &SessionId,
        limit: NonZeroUsize,
        process: ClaudeHelperProcess,
    ) -> Vec<ClaudeAdmittedStart> {
        let helpers = self
            .sessions
            .entry(*session_id)
            .or_insert_with(|| ClaudeSessionHelpers::new(limit));
        helpers.limit = limit;
        helpers.count(ClaudeCountedProcess::Session, process);
        helpers.admit_held_starts()
    }

    /// Counts `process`, a one-turn copy of the session, with the session's own helpers, under
    /// the session's limit, or `limit` where the session has none counted yet. Answers the key its
    /// starts and its end are named by.
    pub(crate) fn count_copy(
        &mut self,
        session_id: &SessionId,
        limit: NonZeroUsize,
        process: ClaudeHelperProcess,
    ) -> ClaudeCountedProcess {
        let key = ClaudeCountedProcess::Copy(self.next_copy);
        self.next_copy += 1;
        self.sessions
            .entry(*session_id)
            .or_insert_with(|| ClaudeSessionHelpers::new(limit))
            .count(key, process);
        key
    }

    /// Answers a new helper's start, or the wake of an ended one by a message, either named by
    /// its tool call `tool_use_id` and sent by `process`: admitted while the session runs fewer
    /// than its limit, or where the process is not counted, under no limit.
    pub(crate) fn answer_start(
        &mut self,
        session_id: &SessionId,
        process: ClaudeCountedProcess,
        request_id: &str,
        tool_use_id: &str,
    ) -> ClaudeHelperStartAnswer {
        let Some(helpers) = self.sessions.get_mut(session_id) else {
            return ClaudeHelperStartAnswer::Admit;
        };
        let has_room = helpers.room() > 0;
        let Some(counted) = helpers.processes.get_mut(&process) else {
            return ClaudeHelperStartAnswer::Admit;
        };
        if has_room {
            counted.admitted_starts.insert(tool_use_id.to_owned());
            return ClaudeHelperStartAnswer::Admit;
        }
        helpers.held_starts.push_back(HeldStart {
            process,
            request_id: request_id.to_owned(),
            tool_use_id: tool_use_id.to_owned(),
        });
        ClaudeHelperStartAnswer::Hold
    }

    /// Takes the helpers one frame of `process` started and ended and the tool calls its results
    /// answered: a start's helper-tool call counts as running from here on through the routing,
    /// an admitted call answered with no helper started, such as one another hook denied, stops
    /// counting, and the held starts these free on any of the session's processes are answered,
    /// oldest first, each now admitted.
    pub(crate) fn observe_lifecycle(
        &mut self,
        session_id: &SessionId,
        process: ClaudeCountedProcess,
        emissions: &[SubagentLifecycleEmission],
        answered_call_ids: &[String],
    ) -> Vec<ClaudeAdmittedStart> {
        if emissions.is_empty() && answered_call_ids.is_empty() {
            return Vec::new();
        }
        let Some(helpers) = self.sessions.get_mut(session_id) else {
            return Vec::new();
        };
        let Some(counted) = helpers.processes.get_mut(&process) else {
            return Vec::new();
        };
        for emission in emissions {
            if emission.event_type == SubagentLifecycleEventType::Started
                && let Some(parent_tool_use_id) = &emission.parent_tool_call_id
            {
                counted.admitted_starts.remove(parent_tool_use_id);
            }
        }
        for call_id in answered_call_ids {
            counted.admitted_starts.remove(call_id);
        }
        helpers.admit_held_starts()
    }

    /// How many admitted calls on the session's own process have yet to start a helper.
    #[cfg(test)]
    pub(crate) fn admitted_start_count(&self, session_id: &SessionId) -> usize {
        self.sessions
            .get(session_id)
            .and_then(|helpers| helpers.processes.get(&ClaudeCountedProcess::Session))
            .map_or(0, |counted| counted.admitted_starts.len())
    }

    /// At the end of the lead's turn on the session's own process, an admitted start there that
    /// never announced a helper never will: it is let go, and the held starts it frees are
    /// answered.
    pub(crate) fn turn_ended(&mut self, session_id: &SessionId) -> Vec<ClaudeAdmittedStart> {
        let Some(helpers) = self.sessions.get_mut(session_id) else {
            return Vec::new();
        };
        let Some(own) = helpers.processes.get_mut(&ClaudeCountedProcess::Session) else {
            return Vec::new();
        };
        own.admitted_starts.clear();
        helpers.admit_held_starts()
    }

    /// Drops a held start `process` withdrew, and answers the tool call it held, `None` where the
    /// request held no start.
    pub(crate) fn withdraw_start(
        &mut self,
        session_id: &SessionId,
        process: ClaudeCountedProcess,
        request_id: &str,
    ) -> Option<String> {
        let helpers = self.sessions.get_mut(session_id)?;
        let index = helpers
            .held_starts
            .iter()
            .position(|held| held.process == process && held.request_id == request_id)?;
        helpers
            .held_starts
            .remove(index)
            .map(|held| held.tool_use_id)
    }

    /// Stops counting `process`, which is gone with its helpers: its held starts are dropped, and
    /// the held starts of the session's other processes the room it leaves admits are answered. A
    /// session left counting no process is forgotten.
    pub(crate) fn forget_process(
        &mut self,
        session_id: &SessionId,
        process: ClaudeCountedProcess,
    ) -> Vec<ClaudeAdmittedStart> {
        let Some(helpers) = self.sessions.get_mut(session_id) else {
            return Vec::new();
        };
        helpers.processes.remove(&process);
        helpers.held_starts.retain(|held| held.process != process);
        if helpers.processes.is_empty() {
            self.sessions.remove(session_id);
            return Vec::new();
        }
        helpers.admit_held_starts()
    }
}

/// A session limited to one helper at once over a routing band that holds the session's own
/// thread, whose helpers a test starts and ends.
#[cfg(test)]
pub(in crate::driver::claude::hooks) struct OneHelperAtOnce {
    /// The limit, holding only this session.
    pub(in crate::driver::claude::hooks) limit: Mutex<ClaudeHelperLimit>,
    band: Arc<Mutex<ClaudeSessionRoutingBand>>,
    // The session's own process, which its held starts are answered on.
    channel: Arc<ScriptedChannel>,
}

/// A counted process over `band`, answered on `channel`, on a test account.
#[cfg(test)]
fn test_process(
    band: Arc<Mutex<ClaudeSessionRoutingBand>>,
    channel: Arc<ScriptedChannel>,
) -> ClaudeHelperProcess {
    ClaudeHelperProcess {
        band,
        channel,
        account: ClaudeProcessAccount::new(Some(
            ProviderAccountId::new("account-1".to_owned()).expect("an account id"),
        )),
    }
}

#[cfg(test)]
impl OneHelperAtOnce {
    /// The limit on the fixed test session, with no helper started.
    pub(in crate::driver::claude::hooks) fn new() -> Self {
        let mut band = ClaudeSessionRoutingBand::new();
        drop(band.router.register_session_thread("session".to_owned()));
        let band = Arc::new(Mutex::new(band));
        let channel = Arc::new(ScriptedChannel::default());
        let mut limit = ClaudeHelperLimit::default();
        let admitted = limit.limit_session(
            &fixed_session_id(),
            NonZeroUsize::MIN,
            test_process(Arc::clone(&band), Arc::clone(&channel)),
        );
        assert!(admitted.is_empty(), "a new session holds no start");
        Self {
            limit: Mutex::new(limit),
            band,
            channel,
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
        request_ids(self.observe(SubagentLifecycleEventType::Started, helper_id, call_id))
    }

    /// Ends the running helper `helper_id`, started by the call `call_id`, and returns the held
    /// requests released, oldest first.
    pub(in crate::driver::claude::hooks) fn end_helper(
        &self,
        helper_id: &str,
        call_id: &str,
    ) -> Vec<String> {
        request_ids(self.end_helper_admitting(helper_id, call_id))
    }

    // Ends the running helper `helper_id` and returns the held starts released, to be answered.
    fn end_helper_admitting(&self, helper_id: &str, call_id: &str) -> Vec<ClaudeAdmittedStart> {
        assert!(lock(&self.band).router.complete_child_thread(helper_id));
        self.observe(SubagentLifecycleEventType::Completed, helper_id, call_id)
    }

    fn observe(
        &self,
        event_type: SubagentLifecycleEventType,
        helper_id: &str,
        call_id: &str,
    ) -> Vec<ClaudeAdmittedStart> {
        lock(&self.limit).observe_lifecycle(
            &fixed_session_id(),
            ClaudeCountedProcess::Session,
            &[SubagentLifecycleEmission {
                event_type,
                subagent_id: helper_id.to_owned(),
                parent_tool_call_id: Some(call_id.to_owned()),
            }],
            &[],
        )
    }
}

// The request ids of the held starts `admitted` let go, in order.
#[cfg(test)]
fn request_ids(admitted: Vec<ClaudeAdmittedStart>) -> Vec<String> {
    admitted.into_iter().map(|start| start.request_id).collect()
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;
    use std::sync::{Arc, Mutex};

    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_std::mutex_lock::lock;

    use super::{
        ClaudeCountedProcess, ClaudeHelperStartAnswer, OneHelperAtOnce, answer_admitted_starts,
        request_ids, test_process,
    };
    use crate::driver::claude::session::scripted::channel::{ScriptedChannel, ScriptedWrite};
    use crate::driver::claude::session::scripted::driver::create_params;
    use crate::driver::claude::session::scripted::{ScriptedSession, settle};
    use crate::driver::claude::session::state::ClaudeSessionRoutingBand;
    use crate::driver::session_control::{CreateSessionParams, SubagentPolicy};
    use crate::driver::test_registry::fixed_session_id;

    // A session limited to one helper at once, with `r1` admitted and `r2` held behind it.
    fn one_admitted_one_held() -> OneHelperAtOnce {
        let one = OneHelperAtOnce::new();
        let session_id = fixed_session_id();
        let own = ClaudeCountedProcess::Session;
        assert_eq!(
            lock(&one.limit).answer_start(&session_id, own, "r1", "t1"),
            ClaudeHelperStartAnswer::Admit
        );
        assert_eq!(
            lock(&one.limit).answer_start(&session_id, own, "r2", "t2"),
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
            request_ids(lock(&one.limit).turn_ended(&fixed_session_id())),
            Vec::<String>::new()
        );

        assert_eq!(one.end_helper("h1", "t1"), ["r2"]);
    }

    // A one-turn copy's helpers count with its session's own: with the one slot taken by the
    // session's running helper, the copy's start is held, and once that helper finishes it is
    // answered on the copy's own process. Killed by a copy counted apart from its session (its
    // start admitted at once), by a held copy start never let go, and by its release answered on
    // the session's process.
    #[tokio::test]
    async fn a_helper_start_on_a_copy_waits_for_its_sessions_running_helper() {
        let one = OneHelperAtOnce::new();
        let session_id = fixed_session_id();
        assert_eq!(
            lock(&one.limit).answer_start(&session_id, ClaudeCountedProcess::Session, "r1", "t1"),
            ClaudeHelperStartAnswer::Admit
        );
        assert_eq!(one.start_helper("h1", "t1"), Vec::<String>::new());
        let copy_channel = Arc::new(ScriptedChannel::default());
        let copy_band = Arc::new(Mutex::new(ClaudeSessionRoutingBand::new()));
        let copy = lock(&one.limit).count_copy(
            &session_id,
            NonZeroUsize::MAX,
            test_process(copy_band, Arc::clone(&copy_channel)),
        );
        assert_eq!(
            lock(&one.limit).answer_start(&session_id, copy, "c1", "ct1"),
            ClaudeHelperStartAnswer::Hold
        );

        let admitted = one.end_helper_admitting("h1", "t1");
        answer_admitted_starts(&session_id, admitted).await;

        let answered_on = |channel: &ScriptedChannel| -> Vec<String> {
            (channel.answers().into_iter())
                .map(|(request_id, _)| request_id)
                .collect()
        };
        assert_eq!(answered_on(&copy_channel), ["c1"]);
        assert_eq!(answered_on(&one.channel), Vec::<String>::new());
    }

    #[test]
    fn a_turn_end_frees_an_admitted_start_that_never_announced() {
        let one = one_admitted_one_held();

        assert_eq!(
            request_ids(lock(&one.limit).turn_ended(&fixed_session_id())),
            ["r2"]
        );
    }

    #[test]
    fn a_withdrawn_hold_is_never_admitted() {
        let one = one_admitted_one_held();
        let session_id = fixed_session_id();
        assert_eq!(
            lock(&one.limit).withdraw_start(&session_id, ClaudeCountedProcess::Session, "r2"),
            Some("t2".to_owned())
        );

        assert_eq!(
            request_ids(lock(&one.limit).turn_ended(&session_id)),
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
