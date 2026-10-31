//! The task frames Claude Code reports beside a turn, which may come after the turn that started
//! them ended: a helper's end moves its child run, a shell or Monitor task becomes a row of the
//! session's running commands on the run that started it, and a tool server's background call
//! stays open until its own notification closes it. Also the usage routing metered off a frame,
//! recorded on the run whose thread spent it.

use sidekicks_contracts::run::subagent::SubagentId;
use tokio::time::Instant;

use super::{ClaudeDeliveryStream, ClaudeSessionStream, report_engine_failure};
use crate::driver::claude::delivery::commands::ClaudeTaskFrame;
use crate::driver::claude::delivery::mcp_tasks::{ClaudeHeldCallEnd, ClaudeHeldCallRun};
use crate::driver::claude::delivery::messages::{
    ClaudeMessageBody, ClaudeToolCallClose, close_claude_tool_call,
};
use crate::driver::claude::delivery::run_readings::ClaudeRowDelivery;
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::frame_routing::ClaudeMeteredReading;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeRunRoute};
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner};

/// Why usage Claude Code reported is not recorded: no run holds the session's thread and no
/// helper's route names a binding.
#[derive(Debug, thiserror::Error)]
#[error("Claude Code reported usage while no run of the session could carry it")]
struct ClaudeUsageUnheld;

impl ClaudeDeliveryStream {
    /// Takes one task frame of `kind`, read once off `text`: a helper's end moves its child run,
    /// and the frame's command or tool-server task is read on the run that started it, the
    /// helper's child run where a helper started it and `lead` otherwise.
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "only the task frames reach this read, and only a start or an end moves a hold"
    )]
    pub(super) async fn take_task_frame(
        &self,
        session: &ClaudeSessionStream,
        kind: &ClaudeWireFrameKind,
        text: &str,
        lead: Option<ClaudeBoundRun>,
    ) {
        let Some(task) = ClaudeTaskFrame::read(text) else {
            return;
        };
        if *kind == ClaudeWireFrameKind::SystemTaskNotification {
            self.end_helper(session, &task).await;
        }
        let run = self.task_run(session, &task, lead);
        let held_end = {
            let mut readings = session.lock();
            match kind {
                ClaudeWireFrameKind::SystemTaskStarted => {
                    readings
                        .tool_server_tasks
                        .observe_start(&task, run.clone().map(held_call_run));
                    None
                }
                ClaudeWireFrameKind::SystemTaskNotification => {
                    readings.tool_server_tasks.release(&task)
                }
                _ => None,
            }
        };
        if let Some(held_end) = held_end {
            self.close_held_call(session, held_end).await;
        }
        let fact = session.lock().command_tasks.read_frame(
            kind,
            &task,
            session.session_id,
            run.map(|run| run.run_id),
        );
        if let (Some(fact), Some(sets)) = (fact, self.dependencies.command_output.port()) {
            fact.publish(&**sets);
        }
    }

    /// Records each metered reading on the run whose thread spent it: the session's own on
    /// `lead`'s binding, a helper's as the helper's, which the record counts toward the helper's
    /// own run, on its child route's binding, else the lead's. A reading no binding can carry is
    /// recorded as a diagnostic.
    pub(super) async fn record_metered(
        &self,
        session: &ClaudeSessionStream,
        lead: Option<&ClaudeBoundRun>,
        metered: Vec<ClaudeMeteredReading>,
    ) {
        let Some(sink) = self.dependencies.usage.port() else {
            return;
        };
        let routes = &self.dependencies.routes;
        let lead_binding = || {
            lead.cloned()
                .or_else(|| routes.lead_run_on(session.session_id))
                .map(|lead| lead.binding_id)
        };
        for reading in metered {
            let (binding_id, owner) = match reading.subagent_id {
                Some(agent_id) => {
                    let child_binding = routes
                        .child_run_for(session.session_id, &agent_id)
                        .and_then(|child_run_id| match routes.route_of(child_run_id) {
                            Some(ClaudeRunRoute::Child(route)) => Some(route.binding_id),
                            Some(ClaudeRunRoute::Lead { .. } | ClaudeRunRoute::Apart) | None => {
                                None
                            }
                        });
                    let owner = SubagentId::new(agent_id)
                        .map_or(MeteredUsageOwner::Run, MeteredUsageOwner::Helper);
                    (child_binding.or_else(lead_binding), owner)
                }
                None => (lead_binding(), MeteredUsageOwner::Run),
            };
            let Some(binding_id) = binding_id else {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    session.session_id,
                    "metered usage",
                    &ClaudeUsageUnheld,
                );
                continue;
            };
            let metered = MeteredUsage {
                session_id: session.session_id,
                binding_id,
                owner,
                delta: reading.delta,
            };
            if let Err(error) = sink.record_metered(metered).await {
                report_engine_failure(session, "metered usage", &*error);
            }
        }
    }

    // The run a task belongs to: the child run of the helper that started it, else `lead`, else
    // the run holding the session's turn now.
    fn task_run(
        &self,
        session: &ClaudeSessionStream,
        task: &ClaudeTaskFrame,
        lead: Option<ClaudeBoundRun>,
    ) -> Option<ClaudeBoundRun> {
        let routes = &self.dependencies.routes;
        let helper_run = task
            .parent_task_id()
            .and_then(|parent_task_id| routes.child_run_for(session.session_id, parent_task_id))
            .and_then(|child_run_id| match routes.route_of(child_run_id) {
                Some(ClaudeRunRoute::Child(route)) => Some(ClaudeBoundRun {
                    run_id: child_run_id,
                    binding_id: route.binding_id,
                }),
                Some(ClaudeRunRoute::Lead { .. } | ClaudeRunRoute::Apart) | None => None,
            });
        helper_run
            .or(lead)
            .or_else(|| routes.lead_run_on(session.session_id))
    }

    // Closes a tool server's background call with its task's summary and files.
    async fn close_held_call(&self, session: &ClaudeSessionStream, held_end: ClaudeHeldCallEnd) {
        let ClaudeHeldCallEnd {
            tool_use_id,
            run,
            is_error,
            text,
        } = held_end;
        let row = close_claude_tool_call(
            &mut session.lock().open_tool_calls,
            &tool_use_id,
            ClaudeToolCallClose {
                session_id: session.session_id,
                run_id: run.run_id,
                is_error,
                body: ClaudeMessageBody::Text(text),
            },
            Instant::now(),
        );
        let rows = row
            .map(|row| ClaudeRowDelivery::of_message(&run.binding_id, row, None))
            .into_iter()
            .collect();
        self.admit_rows(session, rows, "system/task_notification")
            .await;
    }
}

fn held_call_run(run: ClaudeBoundRun) -> ClaudeHeldCallRun {
    ClaudeHeldCallRun {
        run_id: run.run_id,
        binding_id: run.binding_id,
    }
}
