//! A helper Codex starts is a child run beneath the run whose tool call spawned it: its start and
//! end are delivered as the child run and as the `subagent.started` / `subagent.completed` rows,
//! which name that tool call where Codex gave one, and its own rows, which arrive on its own
//! thread, are delivered on the child run between the two, in frame order.

use serde_json::value::RawValue;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::{SubagentId, SubagentLifecyclePayload};
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::driver::codex::delivery::memory::{CodexBoundChildRun, CodexChildRun, CodexSpawnCall};
use crate::driver::codex::delivery::reviewer::end_codex_review_turn;
use crate::driver::codex::delivery::rows::CodexRowRun;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::turn_evidence::{CodexTurnStatus, compose_codex_child_terminal};
use crate::record_readers::read_non_empty_string;
use crate::run::delivery::DeliveryOperation;
use crate::run::delivery::LateAppendableRow;
use crate::run::delivery::{DeliveryBinding, InboundDelivery, InboundOutcome};

/// What a thread is to the session's helpers.
pub(crate) enum ChildRunLookup {
    /// No helper of the session runs on it.
    NotAHelper,
    /// A helper whose start was absorbed, so no run owns its rows.
    Unstarted,
    /// A helper's child run, which owns its rows: started, or refused and ended, absorbing them.
    Bound {
        /// The child run its rows go on.
        run: CodexRowRun,
        /// The event of its `subagent.started` row, which a flag about its turns points at.
        start_row_event_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    },
}

impl CodexSessionRecord {
    /// Remembers a spawn call in flight on its thread, so the helper it starts names it.
    pub(crate) fn note_spawn_call(
        &mut self,
        thread_id: &str,
        tool_call_id: &str,
        run: &CodexRowRun,
    ) {
        self.delivery
            .spawn_calls_by_thread_id
            .entry(thread_id.to_owned())
            .or_default()
            .push(CodexSpawnCall {
                tool_call_id: tool_call_id.to_owned(),
                run: run.clone(),
            });
    }

    /// Forgets a spawn call that started no helper, because it failed or started one now.
    pub(crate) fn settle_spawn_call(&mut self, thread_id: &str, tool_call_id: &str) {
        let calls = &mut self.delivery.spawn_calls_by_thread_id;
        if let Some(waiting) = calls.get_mut(thread_id) {
            waiting.retain(|call| call.tool_call_id != tool_call_id);
            if waiting.is_empty() {
                calls.remove(thread_id);
            }
        }
    }

    /// What `thread_id` is to the session's helpers.
    pub(crate) fn child_run_on(&self, thread_id: &str) -> ChildRunLookup {
        let Some(child) = self.delivery.child_run_by_thread_id.get(thread_id) else {
            return ChildRunLookup::NotAHelper;
        };
        let Some(bound) = &child.bound else {
            return ChildRunLookup::Unstarted;
        };
        ChildRunLookup::Bound {
            run: CodexRowRun {
                session_id: self.session_id,
                run_id: bound.child_run_id,
                agent_id: child.agent_id,
                binding_id: child.binding_id.clone(),
            },
            start_row_event_id: bound.start_row_event_id.clone(),
        }
    }
}

impl CodexFrameDelivery {
    /// Starts the child run of a helper Codex announced on `child_thread_id`: beneath the run
    /// whose oldest unclaimed spawn call on the parent thread started it, else the parent helper's
    /// own child run, else the session's one live run. A helper whose parent run cannot be told,
    /// or beneath a helper that never started, is left unstarted, since no run can own it.
    pub(crate) async fn start_child(
        &self,
        record: &mut CodexSessionRecord,
        child_thread_id: &str,
        parent_thread_id: &str,
        subagent_id: &str,
    ) {
        // A helper id the transcript cannot hold names no helper a row could show.
        let Ok(subagent_id) = SubagentId::new(subagent_id.to_owned()) else {
            return;
        };
        let spawn_call = record
            .delivery
            .spawn_calls_by_thread_id
            .get(parent_thread_id)
            .and_then(|calls| calls.first())
            .cloned();
        if let Some(spawn_call) = &spawn_call {
            record.settle_spawn_call(parent_thread_id, &spawn_call.tool_call_id);
        }
        let parent_child = record
            .delivery
            .child_run_by_thread_id
            .get(parent_thread_id)
            .cloned();
        let (agent_id, binding_id, parent_run_id) = if let Some(spawn_call) = &spawn_call {
            (
                spawn_call.run.agent_id,
                spawn_call.run.binding_id.clone(),
                Some(spawn_call.run.run_id),
            )
        } else if let Some(parent) = parent_child {
            let parent_run_id = parent.bound.map(|bound| bound.child_run_id);
            (parent.agent_id, parent.binding_id, parent_run_id)
        } else {
            let Some((lead_run_id, lead)) = record.sole_active_run().and_then(|run_id| {
                Some((run_id, self.dependencies.run_routes.binding_for(run_id)?))
            }) else {
                return;
            };
            (lead.agent_id, lead.binding_id, Some(lead_run_id))
        };
        let mut child = CodexChildRun {
            bound: None,
            agent_id,
            binding_id,
            subagent_id,
            parent_tool_call_id: spawn_call.map(|call| call.tool_call_id),
        };
        if let Some(parent_run_id) = parent_run_id {
            child.bound = self
                .deliver_child_start(record, child_thread_id, &child, parent_run_id)
                .await;
        }
        record
            .delivery
            .child_run_by_thread_id
            .insert(child_thread_id.to_owned(), child);
    }

    /// Ends the child run of a helper whose last turn ended, with the `subagent.completed` row,
    /// after the asks that turn still held and the pieces it still had waiting; `turn_params` is
    /// that turn's `turn/completed` params.
    pub(crate) async fn complete_child(
        &self,
        record: &mut CodexSessionRecord,
        child_thread_id: &str,
        turn_params: &RawValue,
    ) {
        let members: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(turn_params.get()).unwrap_or_default();
        let turn = members.get("turn").and_then(serde_json::Value::as_object);
        let turn_id = turn.and_then(|turn| read_non_empty_string(turn, "id"));
        if let Some(turn_id) = turn_id {
            self.withdraw_ended_turn_asks(record, child_thread_id, turn_id);
        }
        // Every other warning is answered by the review that follows it, so one still waiting as
        // a helper's turn ends interrupted is the one Codex's reviewer sent as it stopped the turn.
        let is_stopped_by_codex = turn
            .and_then(|turn| turn.get("status"))
            .and_then(serde_json::Value::as_str)
            .and_then(CodexTurnStatus::read)
            == Some(CodexTurnStatus::Interrupted);
        if let ChildRunLookup::Bound {
            run,
            start_row_event_id,
        } = record.child_run_on(child_thread_id)
        {
            if let Some(turn_id) = turn_id {
                for piece in record.delivery.streamed_text.end_turn(turn_id) {
                    self.admit_prose_piece(record, &piece.key, piece.text).await;
                }
            }
            let flag = end_codex_review_turn(
                &mut record.delivery,
                child_thread_id,
                start_row_event_id,
                turn_id,
                is_stopped_by_codex.then_some(run),
            );
            if let Some(flag) = flag {
                self.send_review_flag(record, flag).await;
            }
        }
        let Some(child) = record
            .delivery
            .child_run_by_thread_id
            .remove(child_thread_id)
        else {
            return;
        };
        let Some(bound) = child.bound.clone() else {
            return;
        };
        record
            .delivery
            .child_thread_id_by_run_id
            .remove(&bound.child_run_id);
        let completed = LateAppendableRow::AgentSubagentCompleted(subagent_row(
            record,
            &child,
            bound.parent_run_id,
            Some(bound.child_run_id),
        ));
        let row = InboundDelivery::SessionRow {
            binding: DeliveryBinding {
                binding_id: child.binding_id.clone(),
                operation: None,
            },
            row: completed,
            content: None,
        };
        self.send(record, row, "turn/completed").await;
        let change = compose_codex_child_terminal(
            bound.child_run_id,
            turn_params.get(),
            &mut self.lock_diagnostics(),
        );
        let end = InboundDelivery::RunLifecycle {
            binding: DeliveryBinding {
                binding_id: child.binding_id,
                operation: Some(DeliveryOperation {
                    correlation_key: child_thread_id,
                    is_opening: false,
                }),
            },
            change,
            turn_end: None,
            is_daemon_interrupt_end: false,
        };
        self.send(record, end, "turn/completed").await;
    }

    // The child run and its `subagent.started` row, which names the child run the engine started
    // first; the child's start once the run engine started or refused it, `None` when it absorbed
    // it. A refused helper keeps its ended run, which absorbs its rows, and its running turn is
    // interrupted, as each turn it starts after is.
    async fn deliver_child_start(
        &self,
        record: &mut CodexSessionRecord,
        child_thread_id: &str,
        child: &CodexChildRun,
        parent_run_id: RunId,
    ) -> Option<CodexBoundChildRun> {
        let start = InboundDelivery::ChildRun {
            binding: DeliveryBinding {
                binding_id: child.binding_id.clone(),
                operation: Some(DeliveryOperation {
                    correlation_key: child_thread_id,
                    is_opening: true,
                }),
            },
            parent_run_id,
        };
        let child_run_id = match self.send(record, start, "thread/started").await {
            Some(InboundOutcome::ChildRunStarted { run_id }) => Some(run_id),
            Some(InboundOutcome::ChildRunRefused { run_id, .. }) => {
                self.dependencies
                    .stopped_helpers
                    .stop_running(record, child_thread_id);
                Some(run_id)
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
            | None => None,
        };
        let started_row = InboundDelivery::SessionRow {
            binding: DeliveryBinding {
                binding_id: child.binding_id.clone(),
                operation: None,
            },
            row: LateAppendableRow::AgentSubagentStarted(subagent_row(
                record,
                child,
                parent_run_id,
                child_run_id,
            )),
            content: None,
        };
        let start_row_event_id = self
            .send(record, started_row, "thread/started")
            .await
            .and_then(|outcome| outcome.event_id().cloned());
        let child_run_id = child_run_id?;
        record
            .delivery
            .child_thread_id_by_run_id
            .insert(child_run_id, child_thread_id.to_owned());
        Some(CodexBoundChildRun {
            child_run_id,
            parent_run_id,
            start_row_event_id,
        })
    }
}

// A helper's `subagent.*` row, on the run it was started beneath, naming its own run
// `child_run_id` where the engine started one.
fn subagent_row(
    record: &CodexSessionRecord,
    child: &CodexChildRun,
    parent_run_id: RunId,
    child_run_id: Option<RunId>,
) -> SubagentLifecyclePayload {
    SubagentLifecyclePayload {
        session_id: record.session_id,
        run_id: parent_run_id,
        provider: DESCRIPTOR.provider_id(),
        subagent_id: child.subagent_id.clone(),
        child_run_id,
        parent_tool_call_id: child
            .parent_tool_call_id
            .clone()
            .and_then(|tool_call_id| ToolCallId::new(tool_call_id).ok()),
        source_epoch: None,
        source_position: None,
    }
}

#[cfg(test)]
mod tests;
