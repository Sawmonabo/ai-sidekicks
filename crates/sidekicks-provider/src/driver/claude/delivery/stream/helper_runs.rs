//! A helper's child run: started when routing reads the helper's start, beneath the run of the
//! helper that launched it unless the daemon refused that run, else the lead run, bound by the
//! agent id its frames and requests carry once the run engine answers, and moved on the helper's
//! own `task_notification`, after which its route retires and its pause or hold is dropped. A
//! helper started again in the same process goes beneath the run that read the `SendMessage` call
//! its start names, else, for a start naming its newest own run's call, beneath that run's parent,
//! else beneath the run a first start would take; the same helper keeps its node, and an own run
//! that ended interrupted beneath that same run continues. A helper whose run the daemon refused is
//! bound to that ended run all the same, which absorbs its frames, and is stopped. A helper's new
//! own run clears a stop that is not final. A helper's start and end are also rows on the run its
//! start went beneath. The start is dispatched on the session's task before any later arrival, so
//! a request of the helper finds its run bound.

use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::subagent::{SubagentId, SubagentLifecyclePayload};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;

use super::{
    ClaudeDeliveryStream, ClaudeSessionStream, UNHELD_FRAME_REASON, bound, record_unmapped,
};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::commands::ClaudeTaskFrame;
use crate::driver::claude::delivery::system::read_claude_helper_end;
use crate::driver::claude::event_normalizer::ClaudeSubagentLifecycleSignal;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeChildRunRoute};
use crate::driver::run_control::HelperStopReason;
use crate::run::delivery::{
    ChildRunSubagent, DeliveryBinding, DeliveryOperation, InboundDelivery, InboundOutcome,
    LateAppendableRow,
};
use crate::run::state_entry::RunStateEntry;
use crate::thread_frame_router::{SubagentLifecycleEmission, SubagentLifecycleEventType};

impl ClaudeDeliveryStream {
    // A helper's start gets a child run beneath the run of the helper that launched it, else the
    // lead run holding the turn as the frame was read, and both its rows go on that run, naming the
    // helper's child run. A resume goes beneath the run that read its `SendMessage` call, else,
    // when it names the call of the helper's newest own start, beneath that start's parent while
    // it runs, and continues an own run that ended interrupted beneath the same run. `signal` is
    // the lifecycle signal the frame itself carries.
    pub(super) async fn deliver_helper_lifecycle(
        &self,
        session: &ClaudeSessionStream,
        lead_at_read: Option<ClaudeBoundRun>,
        signal: Option<&ClaudeSubagentLifecycleSignal>,
        emission: SubagentLifecycleEmission,
    ) {
        // A helper id the transcript cannot hold names no helper a row or a node could show.
        let Ok(subagent_id) = SubagentId::new(emission.subagent_id.clone()) else {
            return;
        };
        let routes = &self.dependencies.routes;
        let turn_lead = lead_at_read.or_else(|| routes.lead_run_on(session.session_id));
        let parent_task_id = signal.and_then(|signal| signal.parent_task_id.as_deref());
        let parent_tool_call_id = emission.parent_tool_call_id.as_deref();
        let resume = (emission.event_type == SubagentLifecycleEventType::Started)
            .then(|| {
                session.lock().helper_resumes.resume_of(
                    routes,
                    &emission.subagent_id,
                    parent_tool_call_id,
                )
            })
            .flatten();
        // A resume hangs under the run its call names; any other start under its launcher's bound
        // run, and a launcher whose route retired, was never seen or holds a run the daemon
        // refused falls to the lead; an end goes on the run its start went beneath.
        let carrier = match emission.event_type {
            SubagentLifecycleEventType::Started => resume
                .as_ref()
                .and_then(|resume| resume.carrier.clone())
                .or_else(|| parent_task_id.and_then(|parent| self.helper_run(session, parent)))
                .or_else(|| turn_lead.clone()),
            SubagentLifecycleEventType::Completed => self
                .helper_parent_run(session, &emission.subagent_id)
                .or_else(|| turn_lead.clone()),
        };
        let Some(carrier) = carrier else {
            record_unmapped(
                session,
                &session.unheld_reports,
                lifecycle_wire_type(emission.event_type),
                UNHELD_FRAME_REASON,
            );
            return;
        };
        // A helper's start can be its turn's first frame, which opens the lead's turn before its
        // rows; a background helper's start or end after its turn ended opens none.
        if let Some(turn_lead) = &turn_lead {
            self.open_turn(session, turn_lead).await;
        }
        let tool_call_id =
            parent_tool_call_id.and_then(|call| ToolCallId::new(call.to_owned()).ok());
        let mut child_run_id = None;
        if emission.event_type == SubagentLifecycleEventType::Started {
            let interrupted_run = resume
                .as_ref()
                .and_then(|resume| resume.interrupted_run_beneath(carrier.run_id));
            let continued = match interrupted_run {
                Some(run_id) => self.continue_helper_run(session, &carrier, run_id).await,
                None => None,
            };
            let (run_id, refusal) = if let Some(run_id) = continued {
                (Some(run_id), None)
            } else {
                let child = InboundDelivery::ChildRun {
                    binding: DeliveryBinding {
                        binding_id: carrier.binding_id.clone(),
                        operation: parent_tool_call_id.map(|correlation_key| DeliveryOperation {
                            correlation_key,
                            is_opening: false,
                        }),
                    },
                    parent_run_id: carrier.run_id,
                    subagent: ChildRunSubagent {
                        subagent_id: subagent_id.clone(),
                        // Kept as Claude Code gave it, even for a launcher no route knows.
                        parent_subagent_id: parent_task_id
                            .and_then(|parent| SubagentId::new(parent.to_owned()).ok()),
                        name: None,
                        // A role the contract cannot hold reads as absent.
                        role: signal
                            .and_then(|signal| signal.subagent_type.as_deref())
                            .and_then(|role| FreeFormText::new(role.to_owned()).ok()),
                        provider_path: None,
                        start_call_id: tool_call_id.clone(),
                    },
                };
                match self.send(session, child, Some("system/task_started")).await {
                    Some(InboundOutcome::ChildRunStarted { run_id }) => (Some(run_id), None),
                    Some(InboundOutcome::ChildRunRefused { run_id, reason }) => {
                        (Some(run_id), Some(reason))
                    }
                    Some(
                        InboundOutcome::TurnOpened
                        | InboundOutcome::Transitioned { .. }
                        | InboundOutcome::Published
                        | InboundOutcome::AskAdmitted
                        | InboundOutcome::Appended { .. }
                        | InboundOutcome::AppendedStamped { .. }
                        | InboundOutcome::Absorbed { .. },
                    )
                    | None => (None, None),
                }
            };
            if let Some(run_id) = run_id {
                child_run_id = Some(run_id);
                routes.bind_child_run(
                    run_id,
                    ClaudeChildRunRoute {
                        session_id: session.session_id,
                        agent_id: emission.subagent_id.clone(),
                        parent_run_id: carrier.run_id,
                        binding_id: carrier.binding_id.clone(),
                        is_refused: refusal.is_some(),
                    },
                );
                // Its new own run clears a stop that is not final; refused again, it is stopped
                // again below.
                lock(&self.dependencies.pauses)
                    .release_helper(session.session_id, &emission.subagent_id);
                session.lock().helper_resumes.record_start(
                    &emission.subagent_id,
                    parent_tool_call_id,
                    run_id,
                    carrier.clone(),
                );
            }
            // A refused helper still runs in Claude Code: its next tool use is denied, so it
            // reports and finishes while the lead's turn goes on.
            if let Some(refusal) = refusal {
                lock(&self.dependencies.pauses).stop_helper(
                    session.session_id,
                    &emission.subagent_id,
                    HelperStopReason::SetupRefused { refusal },
                );
            }
        }
        // A helper's end names the child run its start was given.
        let child_run_id = child_run_id
            .or_else(|| routes.child_run_for(session.session_id, &emission.subagent_id));
        let payload = SubagentLifecyclePayload {
            session_id: session.session_id,
            run_id: carrier.run_id,
            provider: DESCRIPTOR.provider_id(),
            subagent_id,
            child_run_id,
            parent_tool_call_id: tool_call_id,
            source_epoch: None,
            source_position: None,
        };
        let row = match emission.event_type {
            SubagentLifecycleEventType::Started => LateAppendableRow::AgentSubagentStarted(payload),
            SubagentLifecycleEventType::Completed => {
                LateAppendableRow::AgentSubagentCompleted(payload)
            }
        };
        self.send_row(
            session,
            &carrier,
            row,
            lifecycle_wire_type(emission.event_type),
        )
        .await;
    }

    // A helper's child run moves on its own `task_notification`, read with why the daemon stopped
    // the helper, then its route retires. The end is the daemon's own where the person stopped the
    // helper from the console or a pause or an interrupt holds it, so an end landing on a run
    // already interrupted is no late event.
    pub(super) async fn end_helper(&self, session: &ClaudeSessionStream, task: &ClaudeTaskFrame) {
        let routes = &self.dependencies.routes;
        let Some((child_run_id, route)) = task
            .task_id()
            .and_then(|task_id| routes.child_route_for(session.session_id, task_id))
        else {
            return;
        };
        let (stop, is_held) = {
            let pauses = lock(&self.dependencies.pauses);
            (
                pauses.helper_stop_reason(&session.session_id, &route.agent_id),
                pauses.is_helper_held(&session.session_id, &route.agent_id),
            )
        };
        let is_daemon_interrupt_end = matches!(stop, Some(HelperStopReason::StopAll)) || is_held;
        let Some(change) = read_claude_helper_end(task, child_run_id, stop.as_ref()) else {
            return;
        };
        // A refused run ended failed at its setup, whatever Claude Code reports of the helper.
        let is_interrupted =
            !route.is_refused && matches!(change.entry, RunStateEntry::Interrupted { .. });
        let delivery = InboundDelivery::RunLifecycle {
            binding: bound(&ClaudeBoundRun {
                run_id: child_run_id,
                binding_id: route.binding_id,
            }),
            change,
            turn_end: None,
            is_daemon_interrupt_end,
        };
        self.send(session, delivery, Some("system/task_notification"))
            .await;
        session
            .lock()
            .helper_resumes
            .record_end(&route.agent_id, child_run_id, is_interrupted);
        // A pause or an interrupt's hold ends with the run, so the helper's next own run is not
        // held unreported; an ended helper holds no call, so none is answered.
        lock(&self.dependencies.pauses).resume_helper(&session.session_id, &route.agent_id, None);
        routes.retire_child_run(child_run_id);
    }

    // The child run of the helper `agent_id` with its binding, while it is bound and the daemon did
    // not refuse it.
    pub(super) fn helper_run(
        &self,
        session: &ClaudeSessionStream,
        agent_id: &str,
    ) -> Option<ClaudeBoundRun> {
        self.dependencies
            .routes
            .child_route_for(session.session_id, agent_id)
            .filter(|(_, route)| !route.is_refused)
            .map(|(run_id, route)| ClaudeBoundRun {
                run_id,
                binding_id: route.binding_id,
            })
    }

    // The run the helper `agent_id` was started beneath, while its child run is bound.
    fn helper_parent_run(
        &self,
        session: &ClaudeSessionStream,
        agent_id: &str,
    ) -> Option<ClaudeBoundRun> {
        let (_, route) = self
            .dependencies
            .routes
            .child_route_for(session.session_id, agent_id)?;
        Some(ClaudeBoundRun {
            run_id: route.parent_run_id,
            binding_id: route.binding_id,
        })
    }
}

fn lifecycle_wire_type(event_type: SubagentLifecycleEventType) -> &'static str {
    match event_type {
        SubagentLifecycleEventType::Started => "system/task_started",
        SubagentLifecycleEventType::Completed => "system/task_notification",
    }
}

#[cfg(test)]
pub(super) mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::run::control::{RunFailureCategory, StopTrigger};
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_std::mutex_lock::lock;

    use super::super::tests::result;
    use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudePauseAnswer};
    use crate::driver::claude::session::scripted::held_calls::{helper_started, init};
    use crate::driver::claude::session::scripted::{
        SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
    };
    use crate::driver::run_control::HelperStopReason;
    use crate::port::run_host::test_host::RecordedDelivery;
    use crate::run::delivery::{LateAppendableRow, RunSetupRefusal};
    use crate::run::state_entry::RunStateEntry;

    /// A helper's `task_started`, launched by the helper `parent` where one is named, started as
    /// `role` where one is named.
    pub(in super::super) fn nested_start(
        task_id: &str,
        call_id: &str,
        parent: Option<&str>,
        role: Option<&str>,
    ) -> Value {
        let mut frame = helper_started(task_id, "local_agent", call_id);
        if let Some(parent) = parent {
            frame["parent_task_id"] = json!(parent);
        }
        if let Some(role) = role {
            frame["subagent_type"] = json!(role);
        }
        frame
    }

    /// One child run delivery as a test reads it.
    #[derive(Debug, PartialEq)]
    pub(in super::super) struct ChildRunRead {
        /// The helper's agent id.
        pub(in super::super) helper: String,
        /// The run it starts beneath.
        pub(in super::super) parent_run_id: Option<RunId>,
        /// The helper that launched it.
        pub(in super::super) launcher: Option<String>,
        /// What it was started as.
        pub(in super::super) role: Option<String>,
        /// The call that started it.
        pub(in super::super) start_call: Option<String>,
    }

    /// Each child run delivery, in order.
    pub(in super::super) fn child_runs(deliveries: &[RecordedDelivery]) -> Vec<ChildRunRead> {
        deliveries
            .iter()
            .filter(|delivery| delivery.kind == "childRun")
            .map(|delivery| {
                let subagent = delivery
                    .subagent
                    .clone()
                    .expect("a child run delivery names its helper");
                ChildRunRead {
                    helper: subagent.subagent_id.as_str().to_owned(),
                    parent_run_id: delivery.parent_run_id,
                    launcher: subagent
                        .parent_subagent_id
                        .map(|parent| parent.as_str().to_owned()),
                    role: subagent.role.map(|role| role.as_str().to_owned()),
                    start_call: subagent.start_call_id.map(|call| call.as_str().to_owned()),
                }
            })
            .collect()
    }

    /// Each lifecycle row of the helper `agent_id` as (is a start, the run it sits on, its child
    /// run).
    pub(in super::super) fn lifecycle_rows(
        deliveries: &[RecordedDelivery],
        agent_id: &str,
    ) -> Vec<(bool, RunId, Option<RunId>)> {
        deliveries
            .iter()
            .filter_map(|delivery| {
                if let Some(LateAppendableRow::AgentSubagentStarted(payload)) = &delivery.row {
                    Some((true, payload))
                } else if let Some(LateAppendableRow::AgentSubagentCompleted(payload)) =
                    &delivery.row
                {
                    Some((false, payload))
                } else {
                    None
                }
            })
            .filter(|(_, payload)| payload.subagent_id.as_str() == agent_id)
            .map(|(is_start, payload)| (is_start, payload.run_id, payload.child_run_id))
            .collect()
    }

    // A nested helper hangs under its launcher's run, a helper whose launcher no route knows under
    // the lead with that launcher's id kept, and both of the nested helper's rows sit on its
    // start's run. Killed by every start hanging under the lead, by dropping the launcher's id, by
    // taking the router's filtered parent (the unknown launcher's id reads as none), by dropping
    // the role, by leaving the nested helper's start or end row on the lead (the end tried on the
    // turn's lead first), and by an unknown launcher not falling back to the lead.
    #[tokio::test(start_paused = true)]
    async fn a_nested_helper_hangs_under_its_launchers_run_and_an_unknown_one_under_the_lead() {
        let session = ScriptedSession::new().await;
        let lead_run = session.hold_lead_turn("lead");

        session.frame(&init());
        session.frame(&nested_start("p", "call-p", None, Some("Explore")));
        session.frame(&nested_start("c", "call-c", Some("p"), Some("Plan")));
        session.frame(&nested_start("g", "call-g", Some("ghost"), None));
        settle().await;
        let routes = &session.start.routes;
        let parent_run = routes
            .child_run_for(session.session_id, "p")
            .expect("the launcher has its child run");
        let nested_run = routes
            .child_run_for(session.session_id, "c")
            .expect("the nested helper has its child run");
        session.frame(&json!({
            "type": "system",
            "subtype": "task_notification",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "task_id": "c",
            "tool_use_id": "call-c",
            "status": "completed",
            "summary": "Planned",
        }));
        settle().await;

        let deliveries = session.engine.deliveries();
        assert_eq!(
            child_runs(&deliveries),
            [
                ChildRunRead {
                    helper: "p".to_owned(),
                    parent_run_id: Some(lead_run),
                    launcher: None,
                    role: Some("Explore".to_owned()),
                    start_call: Some("call-p".to_owned()),
                },
                ChildRunRead {
                    helper: "c".to_owned(),
                    parent_run_id: Some(parent_run),
                    launcher: Some("p".to_owned()),
                    role: Some("Plan".to_owned()),
                    start_call: Some("call-c".to_owned()),
                },
                ChildRunRead {
                    helper: "g".to_owned(),
                    parent_run_id: Some(lead_run),
                    launcher: Some("ghost".to_owned()),
                    role: None,
                    start_call: Some("call-g".to_owned()),
                },
            ]
        );
        assert_eq!(
            lifecycle_rows(&deliveries, "c"),
            [
                (true, parent_run, Some(nested_run)),
                (false, parent_run, Some(nested_run)),
            ]
        );
    }

    // A helper launched by one whose run the daemon refused hangs under the lead, the refused
    // launcher's id kept, so it gets a run of its own. Killed by the refused launcher's ended run
    // carrying the start (it hangs under that run).
    #[tokio::test(start_paused = true)]
    async fn a_helper_launched_by_a_refused_one_hangs_under_the_lead() {
        let session = ScriptedSession::new().await;
        let lead_run = session.hold_lead_turn("lead");
        session.frame(&init());
        session.engine.refuse_next_child_run(earlier_refusal());
        session.frame(&nested_start("p", "call-p", None, None));
        session.frame(&nested_start("c", "call-c", Some("p"), None));
        settle().await;

        let nested = child_runs(&session.engine.deliveries())
            .into_iter()
            .find(|read| read.helper == "c")
            .expect("the nested helper's start is delivered");
        assert_eq!(nested.parent_run_id, Some(lead_run));
        assert_eq!(nested.launcher.as_deref(), Some("p"));
    }

    // A background helper that launches a helper after the lead's turn ended still carries it: the
    // nested start hangs under the launcher's run on the lead's binding, and opens no turn. Killed
    // by dropping the start as unmapped once no lead holds the turn, by opening the turn on the run
    // the start hangs under, and by trying the launcher only while a lead holds the turn.
    #[tokio::test(start_paused = true)]
    async fn a_background_helpers_nested_start_after_the_turn_ended_hangs_under_it() {
        let session = ScriptedSession::new().await;
        session.hold_lead_turn("lead");

        session.frame(&init());
        session.frame(&helper_started("p", "local_agent", "call-p"));
        settle().await;
        let parent_run = session
            .start
            .routes
            .child_run_for(session.session_id, "p")
            .expect("the launcher has its child run");
        session.frame(&result(&json!({})));
        settle().await;
        let before_nested_start = session.engine.deliveries().len();
        session.frame(&nested_start("c2", "call-c2", Some("p"), None));
        settle().await;

        let deliveries = session.engine.deliveries();
        let after_turn = &deliveries[before_nested_start..];
        let nested_child_run = after_turn
            .iter()
            .find(|delivery| delivery.kind == "childRun")
            .expect("the nested start gets its child run");
        assert_eq!(nested_child_run.parent_run_id, Some(parent_run));
        assert_eq!(nested_child_run.binding_id, Some(binding_id("lead")));
        assert!(
            lifecycle_rows(after_turn, "c2")
                .iter()
                .any(|&(is_start, run_id, _)| is_start && run_id == parent_run),
            "the nested start's row sits on its launcher's run"
        );
        assert!(
            after_turn
                .iter()
                .all(|delivery| delivery.kind != "turnBoundary"),
            "a start after the turn ended opens no turn"
        );
    }

    /// The `task_notification` that ends the helper `task_id` with `status`.
    pub(in super::super) fn helper_ended(task_id: &str, status: &str, summary: &str) -> Value {
        json!({
            "type": "system",
            "subtype": "task_notification",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "task_id": task_id,
            "tool_use_id": "call-1",
            "status": status,
            "summary": summary,
        })
    }

    // How the daemon answers the helper `agent_id`'s next pre-tool callback.
    fn helper_tool_answer(session: &ScriptedSession, agent_id: &str) -> ClaudePauseAnswer {
        lock(&session.parts.run_controls.pauses).answer_before_tool(
            &session.session_id,
            Some(agent_id),
            "helper-tool",
        )
    }

    // Whether the helper `agent_id`'s next tool use is denied with words holding `words`.
    fn is_denied_with(session: &ScriptedSession, agent_id: &str, words: &str) -> bool {
        matches!(
            helper_tool_answer(session, agent_id),
            ClaudePauseAnswer::Answer(ClaudeHookAnswer::Deny { reason }) if reason.contains(words)
        )
    }

    // A helper's end reads by why the daemon stopped it: a stop from the console is final, a token
    // limit stops it with that trigger even when it finished, and Claude Code's own stop reads as
    // an interruption. The end is the daemon's own where the console stopped the helper, its pause
    // already dropped, or an interrupt holds it. Killed by reading every `stopped` as final, by
    // reading the console's stop as an interruption, by leaving a token-limited finish completed,
    // by dropping the trigger, by answering the console's stop with another reason's sentence, by
    // marking the end of neither the console's stop nor a held helper as the daemon's, and by
    // marking every end so.
    #[rstest]
    #[case::stop_all(
    Some(HelperStopReason::StopAll),
    false,
    "stopped",
    RunStateEntry::Stopped { intended_close: None, trigger: None },
    true
)]
    #[case::token_limit_stopped(
    Some(HelperStopReason::TokenLimit),
    false,
    "stopped",
    RunStateEntry::Stopped { intended_close: None, trigger: Some(StopTrigger::TokenLimit) },
    false
)]
    #[case::token_limit_completed(
    Some(HelperStopReason::TokenLimit),
    false,
    "completed",
    RunStateEntry::Stopped { intended_close: None, trigger: Some(StopTrigger::TokenLimit) },
    false
)]
    #[case::held(
    None,
    true,
    "stopped",
    RunStateEntry::Interrupted { intended_close: None, trigger: None },
    true
)]
    #[case::own_stop(
    None,
    false,
    "stopped",
    RunStateEntry::Interrupted { intended_close: None, trigger: None },
    false
)]
    #[case::own_finish(
    None,
    false,
    "completed",
    RunStateEntry::Completed { intended_close: None },
    false
)]
    #[tokio::test(start_paused = true)]
    async fn a_helpers_end_reads_by_why_it_was_stopped(
        #[case] stop: Option<HelperStopReason>,
        #[case] is_held: bool,
        #[case] status: &str,
        #[case] expected: RunStateEntry,
        #[case] is_daemon_interrupt_end: bool,
    ) {
        let session = ScriptedSession::new().await;
        session.hold_lead_turn("lead");
        session.frame(&init());
        session.frame(&helper_started("helper", "local_agent", "call-1"));
        settle().await;
        let child_run = session
            .start
            .routes
            .child_run_for(session.session_id, "helper")
            .expect("the helper has its child run");
        let is_stop_all = stop == Some(HelperStopReason::StopAll);
        if let Some(stop) = stop {
            lock(&session.parts.run_controls.pauses).stop_helper(
                session.session_id,
                "helper",
                stop,
            );
        }
        if is_held {
            lock(&session.parts.run_controls.pauses)
                .hold_interrupted_helper(&session.session_id, "helper");
        }

        session.frame(&helper_ended("helper", status, "Reported"));
        settle().await;

        assert_eq!(session.engine.moves_of_run(child_run), [expected]);
        assert_eq!(
            session.engine.daemon_interrupt_ends_of_run(child_run),
            [is_daemon_interrupt_end]
        );
        if is_stop_all {
            assert!(is_denied_with(&session, "helper", "will not be resumed"));
        }
    }

    // A failed helper keeps its own words and category while its lead completes. Killed by taking
    // the child's end from the lead's.
    #[tokio::test(start_paused = true)]
    async fn a_failed_helper_keeps_its_words_while_the_lead_completes() {
        let session = ScriptedSession::new().await;
        let lead_run = session.hold_lead_turn("lead");
        session.frame(&init());
        session.frame(&helper_started("helper", "local_agent", "call-1"));
        settle().await;
        let child_run = session
            .start
            .routes
            .child_run_for(session.session_id, "helper")
            .expect("the helper has its child run");

        session.frame(&helper_ended("helper", "failed", "the build broke"));
        session.frame(&result(&json!({})));
        settle().await;

        let moves = session.engine.run_moves();
        let child_moves: Vec<_> = moves
            .iter()
            .filter(|change| change.run_id == child_run)
            .collect();
        assert!(
            matches!(
                child_moves.as_slice(),
                [change] if change.failure_category == Some(RunFailureCategory::ProviderFailure)
                    && matches!(
                        &change.entry,
                        RunStateEntry::Failed { provider_failure_detail: Some(words), .. }
                            if words.as_str() == "the build broke"
                    )
            ),
            "{child_moves:?}"
        );
        assert_eq!(
            session.engine.moves_of_run(lead_run),
            [RunStateEntry::Completed {
                intended_close: None
            }]
        );
    }

    // A helper's new own run clears a stop that is not final, a stop from the console holds, and a
    // helper refused again is stopped again for that refusal. Killed by never clearing the stop
    // (the token limit's case is denied), by clearing the console's stop, and by clearing after the
    // refusal's stop (the refused-again case passes).
    #[rstest]
    #[case::token_limit(HelperStopReason::TokenLimit, false, None)]
    #[case::setup_refused(
    HelperStopReason::SetupRefused { refusal: earlier_refusal() },
    false,
    None
)]
    #[case::stop_all(HelperStopReason::StopAll, false, Some("will not be resumed"))]
    #[case::refused_again(HelperStopReason::TokenLimit, true, Some("/gone/again.git"))]
    #[tokio::test(start_paused = true)]
    async fn a_new_own_run_clears_a_stop_that_is_not_final(
        #[case] stop: HelperStopReason,
        #[case] is_refused_again: bool,
        #[case] denial: Option<&str>,
    ) {
        let session = ScriptedSession::new().await;
        session.hold_lead_turn("lead");
        session.frame(&init());
        session.frame(&helper_started("helper", "local_agent", "call-1"));
        session.frame(&helper_ended("helper", "completed", "Reported"));
        settle().await;
        lock(&session.parts.run_controls.pauses).stop_helper(session.session_id, "helper", stop);
        if is_refused_again {
            session.engine.refuse_next_child_run(RunSetupRefusal {
                cause: "the writable root '/gone/again.git' could not be resolved".to_owned(),
                is_posture_rejection: false,
            });
        }

        session.frame(&helper_started("helper", "local_agent", "call-2"));
        settle().await;

        match denial {
            Some(words) => assert!(is_denied_with(&session, "helper", words)),
            None => assert_eq!(
                helper_tool_answer(&session, "helper"),
                ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass)
            ),
        }
    }

    // An interrupt's hold ends with the helper's run, so the first tool call of its next own run
    // passes rather than being held with no `paused` reported. Killed by the hold kept past the end
    // (the call is held).
    #[tokio::test(start_paused = true)]
    async fn an_interrupted_helpers_hold_ends_with_its_run() {
        let session = ScriptedSession::new().await;
        session.hold_lead_turn("lead");
        session.frame(&init());
        session.frame(&helper_started("helper", "local_agent", "call-1"));
        settle().await;
        lock(&session.parts.run_controls.pauses)
            .hold_interrupted_helper(&session.session_id, "helper");

        session.frame(&helper_ended("helper", "stopped", "Interrupted"));
        session.frame(&helper_started("helper", "local_agent", "call-2"));
        settle().await;

        assert_eq!(
            helper_tool_answer(&session, "helper"),
            ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass)
        );
    }

    // The refusal a helper's earlier run was stopped for.
    fn earlier_refusal() -> RunSetupRefusal {
        RunSetupRefusal {
            cause: "the writable root '/gone/repo.git' could not be resolved".to_owned(),
            is_posture_rejection: false,
        }
    }
}
