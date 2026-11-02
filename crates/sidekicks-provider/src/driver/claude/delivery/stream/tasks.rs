//! The task frames Claude Code reports beside a turn, which may come after the turn that started
//! them ended: a helper's end moves its child run, a shell or Monitor task becomes a row of the
//! session's running commands on the run that started it, and a tool server's background call
//! stays open until its own notification closes it. Also the usage routing metered off a frame,
//! recorded on the run whose thread spent it, and the move of the session's bindings onto another
//! account, made in its place among those frames.

use std::collections::HashSet;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::subagent::SubagentId;
use tokio::time::Instant;

use super::{ClaudeDeliveryStream, ClaudeSessionStream, report_engine_failure};
use crate::driver::claude::delivery::commands::ClaudeTaskFrame;
use crate::driver::claude::delivery::mcp_tasks::ClaudeHeldCallEnd;
use crate::driver::claude::delivery::messages::close_opened_call;
use crate::driver::claude::delivery::run_readings::{ClaudeRow, ClaudeRowDelivery};
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::frame_routing::ClaudeMeteredReading;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeRunRoute};
use crate::driver::claude::session::conversation_home::ClaudeConversationHomeKeep;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::reorder_buffer::{ReorderBufferedEvent, ReorderPairingRole};
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner};
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// Why usage Claude Code reported is not recorded: no run holds the session's thread, no helper's
/// route names a binding and the session runs on no binding now.
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
            let mut guard = session.lock();
            let readings = &mut *guard;
            match kind {
                ClaudeWireFrameKind::SystemTaskStarted => {
                    readings
                        .tool_server_tasks
                        .observe_start(&task, &mut readings.open_tool_calls);
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
        let fact =
            session
                .lock()
                .command_tasks
                .read_frame(kind, &task, session.session_id, run.as_ref());
        if let (Some(fact), Some(sets)) = (fact, self.dependencies.command_output.port()) {
            fact.publish(&**sets);
        }
    }

    /// Records each metered reading on the run whose thread spent it: the session's own on
    /// `lead`'s binding, a helper's as the helper's, which the record counts toward the helper's
    /// own run, on its child route's binding, else the lead's. A reading no route names goes on the
    /// binding the session runs on now; one no binding can carry is recorded as a diagnostic.
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
                .or_else(|| {
                    self.dependencies
                        .command_output
                        .port()
                        .and_then(|sets| sets.binding_now(&session.session_id))
                })
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

    /// Moves the session's stream, the binding its lead runs on, every lead run's binding on the
    /// session and every live helper's onto `provider_account_id`'s account through `bindings`,
    /// each binding once, in the place the process acknowledged the switch, so each reading
    /// metered and each report read after it is the new account's and each before it the old
    /// one's. Each binding names `conversation_home` first where one is given, so none rests on
    /// the new account without the home that holds its conversation; a binding whose home or move
    /// is not written is logged, left where it is, and the others are still moved.
    pub(super) async fn move_account(
        &self,
        session: &ClaudeSessionStream,
        provider_account_id: &ProviderAccountId,
        lead_binding_id: RuntimeBindingId,
        bindings: &dyn RuntimeBindingWriter,
        conversation_home: Option<&ClaudeConversationHomeKeep>,
    ) {
        session.move_account(provider_account_id.clone());
        let routes = &self.dependencies.routes;
        let mut moved = HashSet::new();
        let binding_ids = std::iter::once(lead_binding_id).chain(
            routes
                .bound_runs_on(session.session_id)
                .into_iter()
                .chain(routes.child_runs_on(session.session_id))
                .map(|run| run.binding_id),
        );
        for binding_id in binding_ids {
            if !moved.insert(binding_id.clone()) {
                continue;
            }
            if let Some(home) = conversation_home
                && let Err(error) = home.keep_in(bindings, binding_id.clone()).await
            {
                tracing::warn!(
                    session_id = %session.session_id,
                    error = &*error as &(dyn std::error::Error + 'static),
                    "a Claude Code session's binding could not name the home that holds its \
                     conversation, so it stays on the account it was on"
                );
                continue;
            }
            if let Err(error) = bindings
                .move_account(binding_id, provider_account_id.clone())
                .await
            {
                tracing::warn!(
                    session_id = %session.session_id,
                    error = &*error as &(dyn std::error::Error + 'static),
                    "a Claude Code session's binding could not move onto the account its process \
                     switched to"
                );
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

    // Closes a tool server's background call on the run its opening recorded, on that run's
    // binding, with its task's body; unpaired, since its stand-in result already answered the
    // call's opening.
    async fn close_held_call(&self, session: &ClaudeSessionStream, held_end: ClaudeHeldCallEnd) {
        let ClaudeHeldCallEnd {
            tool_use_id,
            opened,
            outcome,
            text,
        } = held_end;
        let ClaudeBoundRun { run_id, binding_id } = opened.run().clone();
        let Some(row) = close_opened_call(
            opened,
            &tool_use_id,
            session.session_id,
            run_id,
            outcome,
            Instant::now(),
        ) else {
            return;
        };
        let rows = vec![ReorderBufferedEvent {
            tool_call_id: None,
            pairing_role: ReorderPairingRole::Unpaired,
            event: ClaudeRowDelivery {
                binding_id,
                operation: None,
                row: ClaudeRow::Late(row),
                body: text,
                message_key: None,
            },
        }];
        self.admit_rows(session, rows, "system/task_notification")
            .await;
    }
}
