//! The task frames Claude Code reports beside a turn, which may come after the turn that started
//! them ended: a helper's end moves its child run, a shell or Monitor task becomes a row of the
//! session's running commands on the run that started it, and a tool server's background call
//! stays open until its own notification closes it, its progress the status line under it; a
//! helper's such call is held the same way and traced at its notification, with no row. Also
//! the usage routing metered off a frame, recorded on the run whose thread spent it, and the move
//! of the session's bindings onto another account, made in its place among those frames.

mod exit_settle;
mod rest_settle;
mod resume;

pub(super) use self::exit_settle::ClaudeExitHolds;

use std::collections::HashSet;

use jiff::Timestamp;
use serde_json::value::RawValue;
use sidekicks_contracts::event::envelope::EventOccurredAt;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::tool_call_status::TOOL_CALL_STATUS_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::text_cut::cut_to_code_points;

use super::{ClaudeDeliveryStream, ClaudeSessionStream, report_engine_failure};
use crate::driver::claude::delivery::commands::ClaudeTaskFrame;
use crate::driver::claude::delivery::mcp_tasks::ClaudeHeldCallEnd;
use crate::driver::claude::delivery::messages::{
    ClaudeKeptTrace, ClaudeOpenToolCall, close_opened_call, record_claude_traces,
};
use crate::driver::claude::delivery::run_readings::{ClaudeRow, ClaudeRowDelivery};
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::frame_routing::ClaudeMeteredReading;
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::claude::session::conversation_home::ClaudeConversationHomeKeep;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::reorder_buffer::{ReorderBufferedEvent, ReorderPairingRole};
use crate::port::held_tool_calls::HeldToolCall;
use crate::port::tool_traces::is_recording_tool_traces;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner};
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// Why usage Claude Code reported is not recorded: no run holds the session's thread, no helper's
/// route names a binding and the session runs on no binding now.
#[derive(Debug, thiserror::Error)]
#[error("Claude Code reported usage while no run of the session could carry it")]
struct ClaudeUsageUnheld;

impl ClaudeDeliveryStream {
    /// Takes one task frame of `kind`, `frame_kind` on the wire, read once off `text`: a helper's
    /// end moves its child run, the frame's command or tool-server task is read on the run that
    /// started it, the helper's child run where a helper started it and `lead` otherwise, a held
    /// call's end closes it, traced with its notification while `Record traces` is on, and its
    /// progress becomes its status line, a call a resume rebuilt is kept by its restored start or
    /// ended by the first list that leaves it out, and a helper's held call is dropped by a list
    /// that leaves its task out.
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "only the task frames reach this read, and a move changes no held call"
    )]
    pub(super) async fn take_task_frame(
        &self,
        session: &ClaudeSessionStream,
        kind: &ClaudeWireFrameKind,
        frame_kind: &str,
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
        let is_tracing = is_recording_tool_traces(&self.dependencies.tool_traces);
        let (ends, progress, helper_trace) = {
            let mut guard = session.lock();
            let readings = &mut *guard;
            let held = &mut readings.tool_server_tasks;
            match kind {
                ClaudeWireFrameKind::SystemTaskStarted => {
                    held.observe_start(&task, &mut readings.open_tool_calls);
                    readings.helper_tool_calls.observe_start(&task);
                    if let Some(task_id) = task.task_id() {
                        readings.restored_calls.confirm(task_id);
                    }
                    (Vec::new(), None, None)
                }
                ClaudeWireFrameKind::SystemTaskNotification => {
                    // The notification is the held call's result as Claude Code sent it.
                    let end = held.release(&task).map(|mut end| {
                        if is_tracing {
                            end.notification = read_traced_ending(session, text);
                        }
                        end
                    });
                    let helper_trace = readings
                        .helper_tool_calls
                        .release(&task)
                        .filter(|_| is_tracing)
                        .and_then(|call| {
                            let result = read_traced_ending(session, text)?;
                            Some(call.into_trace(session.session_id, result))
                        });
                    (end.into_iter().collect(), None, helper_trace)
                }
                ClaudeWireFrameKind::SystemBackgroundTasksChanged => {
                    // The first list after a resume ends the rebuilt calls it leaves out as ended
                    // with the process, before the list settles any other call it leaves out.
                    let unrestored = task
                        .listed_task_ids()
                        .map(|listed| readings.restored_calls.take_unlisted(listed))
                        .unwrap_or_default();
                    let mut ends = held.end_unrestored(unrestored.iter().map(String::as_str));
                    ends.extend(held.settle_unlisted(&task, &readings.restored_calls));
                    readings.helper_tool_calls.drop_unlisted(&task);
                    (ends, None, None)
                }
                ClaudeWireFrameKind::SystemTaskProgress => {
                    (Vec::new(), held.progress_call(&task), None)
                }
                _ => (Vec::new(), None, None),
            }
        };
        self.close_held_calls(session, ends, frame_kind).await;
        record_claude_traces(&self.dependencies.tool_traces, helper_trace).await;
        if let (Some((tool_use_id, summary)), Some(statuses)) =
            (progress, self.dependencies.tool_call_statuses.port())
        {
            if let (Ok(tool_call_id), Ok(status)) = (
                ToolCallId::new(tool_use_id.clone()),
                FreeFormText::<TOOL_CALL_STATUS_MAX_LEN>::new(
                    cut_to_code_points(&summary, TOOL_CALL_STATUS_MAX_LEN).to_owned(),
                ),
            ) {
                statuses.publish_tool_call_status(session.session_id, tool_call_id, status);
            } else {
                tracing::warn!(
                    session_id = %session.session_id,
                    tool_use_id = %tool_use_id,
                    "a Claude Code background call's id or progress line is not one a status \
                     line can carry, so the line is not published"
                );
            }
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
                        .child_route_for(session.session_id, &agent_id)
                        .map(|(_, route)| route.binding_id);
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
            .and_then(|parent_task_id| routes.child_route_for(session.session_id, parent_task_id))
            .map(|(run_id, route)| ClaudeBoundRun {
                run_id,
                binding_id: route.binding_id,
            });
        helper_run
            .or(lead)
            .or_else(|| routes.lead_run_on(session.session_id))
    }

    /// Closes each held call in `ends`, read off a frame of `wire`, through the reorder buffer.
    /// Each close is appended after its run and unpaired, since its stand-in result already
    /// answered the call's opening; a call that holds its arguments and ended with its task's
    /// notification, or the ending Claude Code saved, is traced with that as its result.
    pub(super) async fn close_held_calls(
        &self,
        session: &ClaudeSessionStream,
        mut ends: Vec<ClaudeHeldCallEnd>,
        wire: &str,
    ) {
        if ends.is_empty() {
            return;
        }
        let traces: Vec<ClaudeKeptTrace> = ends
            .iter_mut()
            .filter_map(|end| {
                let notification = end.notification.take()?;
                end.opened
                    .take_trace(session.session_id, &end.tool_use_id, || notification)
            })
            .collect();
        let rows = ends
            .into_iter()
            .filter_map(|end| self.held_call_close(session.session_id, end))
            .map(|event| ReorderBufferedEvent {
                tool_call_id: None,
                pairing_role: ReorderPairingRole::Unpaired,
                event,
            })
            .collect();
        self.admit_rows(session, rows, wire).await;
        record_claude_traces(&self.dependencies.tool_traces, traces).await;
    }

    // The close of `session_id`'s held call `end`, on the run its opening recorded and that run's
    // binding, with its task's body, its status line cleared; none, logged, for a call id no row
    // can carry.
    fn held_call_close(
        &self,
        session_id: SessionId,
        end: ClaudeHeldCallEnd,
    ) -> Option<ClaudeRowDelivery> {
        let ClaudeHeldCallEnd {
            tool_use_id,
            opened,
            outcome,
            text,
            ..
        } = end;
        if let (Some(statuses), Ok(tool_call_id)) = (
            self.dependencies.tool_call_statuses.port(),
            ToolCallId::new(tool_use_id.clone()),
        ) {
            statuses.clear_tool_call_status(session_id, tool_call_id);
        }
        let binding_id = opened.run().binding_id.clone();
        let Some(row) =
            close_opened_call(opened, &tool_use_id, session_id, outcome, Timestamp::now())
        else {
            tracing::warn!(
                %session_id,
                tool_use_id = %tool_use_id,
                "a Claude Code background call's id is not one a row can carry, so its close is \
                 not recorded"
            );
            return None;
        };
        Some(ClaudeRowDelivery {
            binding_id,
            operation: None,
            row: ClaudeRow::AfterRun(row),
            body: text,
            message_key: None,
        })
    }
}

// A held call's ending as Claude Code wrote it, its task notification or its saved ending, as
// the call's traced result; `None`, logged, for text that is not one JSON value, which leaves the
// call untraced.
fn read_traced_ending(session: &ClaudeSessionStream, text: &str) -> Option<Box<RawValue>> {
    RawValue::from_string(text.to_owned())
        .inspect_err(|error| {
            tracing::warn!(
                session_id = %session.session_id,
                error = error as &(dyn std::error::Error + 'static),
                "a Claude Code background call's ending is not one JSON value, so its call is not \
                 traced"
            );
        })
        .ok()
}

// The opening of the session log's held call `call`, on its run and binding, timed from its
// stored time, else from now.
fn rebuilt_opening(call: &HeldToolCall) -> ClaudeOpenToolCall {
    ClaudeOpenToolCall::new(
        call.tool_name.clone(),
        ClaudeBoundRun {
            run_id: call.run_id,
            binding_id: call.binding_id.clone(),
        },
        call.invoked_at
            .as_ref()
            .and_then(EventOccurredAt::timestamp)
            .unwrap_or_else(Timestamp::now),
    )
}
