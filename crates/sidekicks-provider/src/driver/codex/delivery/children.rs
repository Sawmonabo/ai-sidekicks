//! A helper Codex starts is a child run beneath the run whose tool call spawned it: its start and
//! end are delivered as the child run and as the `subagent.started` / `subagent.completed` rows,
//! which name that tool call where Codex gave one, and its own rows, which arrive on its own
//! thread, are delivered on the child run between the two, in frame order.

use std::time::Duration;

use serde_json::value::RawValue;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::MessageContent;
use sidekicks_contracts::run::subagent::{SubagentId, SubagentLifecyclePayload};
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::driver::codex::delivery::memory::{CodexBoundChildRun, CodexChildRun, CodexSpawnCall};
use crate::driver::codex::delivery::reviewer::end_codex_review_turn;
use crate::driver::codex::delivery::rows::CodexRowRun;
use crate::driver::codex::event_normalizer::CODEX_ITEM_COMPLETED_METHOD;
use crate::driver::codex::session::establishment::helpers::bind_codex_helper_run;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::thread::view::{CodexThreadReading, request_thread_reading};
use crate::driver::codex::turn_evidence::{CodexTurnStatus, compose_codex_child_terminal};
use crate::driver::run_control::HelperStopReason;
use crate::record_readers::read_non_empty_string;
use crate::run::delivery::DeliveryOperation;
use crate::run::delivery::LateAppendableRow;
use crate::run::delivery::{ChildRunSubagent, DeliveryBinding, InboundDelivery, InboundOutcome};
use crate::run::state_entry::RunStateEntry;

/// What a helper's child run carries from Codex: its names and path, the ask it was spawned with,
/// and the model and effort it runs on, each `None` where Codex gives none or one the contract
/// refuses.
pub(crate) struct CodexHelperStart {
    /// Its nickname, `agentNickname` on the `thread/read` of its conversation.
    pub(crate) name: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// The role it was started in, `agentRole` on the same read.
    pub(crate) role: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// Its path in Codex's tree of helpers, `agentPath` on the spawn item; a v1 spawn names none.
    pub(crate) provider_path: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// The ask it was spawned with, `prompt` on a v1 spawn item, whole; a v2 spawn names none.
    pub(crate) ask: Option<MessageContent>,
    /// The model it runs on, the spawn item's `model`, else its conversation's.
    pub(crate) model_id: Option<ProviderToken>,
    /// The effort it runs at, the spawn item's `reasoningEffort`, as Codex words it.
    pub(crate) effort: Option<ProviderToken>,
}

impl CodexHelperStart {
    /// The start as the contract holds it; a value it refuses, one holding NUL or one over the cap,
    /// reads as none, never cut.
    pub(crate) fn new(
        name: Option<String>,
        role: Option<String>,
        provider_path: Option<String>,
        ask: Option<String>,
        model: Option<String>,
        reasoning_effort: Option<String>,
    ) -> Self {
        let handle = |text: Option<String>| text.and_then(|text| FreeFormText::new(text).ok());
        let token = |text: Option<String>| text.and_then(|text| ProviderToken::new(text).ok());
        Self {
            name: handle(name),
            role: handle(role),
            provider_path: handle(provider_path),
            ask: ask.and_then(|ask| MessageContent::new(ask).ok()),
            model_id: token(model),
            effort: token(reasoning_effort),
        }
    }
}

/// How long the `thread/read` of a helper's conversation waits: for a spawned helper's names
/// before its child run starts without them, and for whether a reviewer's block on it may be
/// allowed once.
const CODEX_HELPER_READ_TIMEOUT: Duration = Duration::from_secs(2);

/// Reads a spawned or restored helper's conversation for its names and model, or a blocked one's
/// for whether it takes direct input, waiting at most [`CODEX_HELPER_READ_TIMEOUT`]; a read that
/// fails or finds no thread is logged and answers `None`.
pub(crate) async fn read_codex_helper_thread(
    record: &CodexSessionRecord,
    helper_thread_id: &str,
) -> Option<CodexThreadReading> {
    let read = match record.service.connection() {
        Ok(connection) => {
            request_thread_reading(&connection, helper_thread_id, CODEX_HELPER_READ_TIMEOUT).await
        }
        Err(error) => Err(error),
    };
    let error = match read {
        Ok(Some(reading)) => return Some(reading),
        Ok(None) => None,
        Err(error) => Some(error),
    };
    tracing::warn!(
        session_id = %record.session_id,
        helper_thread_id,
        error = error.as_ref().map(|error| error as &(dyn std::error::Error + 'static)),
        "codex's helper thread read failed"
    );
    None
}

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
    /// Starts the child run of a helper Codex spawned on `child_thread_id` by the call
    /// `spawn_call_id`: beneath the run whose noted spawn call on the parent thread has that id,
    /// else the parent helper's own child run, else the session's one live run, as `helper_start`
    /// names it, and routes its run to its conversation, which an interrupt of the run
    /// reaches. Its rows name `spawn_call_id` as their call whichever run it starts beneath. A
    /// helper whose parent run cannot be told, or beneath a helper that never started, is left
    /// unstarted, since no run can own it.
    pub(crate) async fn start_child(
        &self,
        record: &mut CodexSessionRecord,
        child_thread_id: &str,
        parent_thread_id: &str,
        subagent_id: &str,
        spawn_call_id: Option<&str>,
        helper_start: CodexHelperStart,
    ) {
        // A helper id the transcript cannot hold names no helper a row could show.
        let Ok(subagent_id) = SubagentId::new(subagent_id.to_owned()) else {
            return;
        };
        let spawn_call = spawn_call_id.and_then(|spawn_call_id| {
            record
                .delivery
                .spawn_calls_by_thread_id
                .get(parent_thread_id)?
                .iter()
                .find(|call| call.tool_call_id == spawn_call_id)
                .cloned()
        });
        if let Some(spawn_call) = &spawn_call {
            record.settle_spawn_call(parent_thread_id, &spawn_call.tool_call_id);
        }
        let parent_child = record
            .delivery
            .child_run_by_thread_id
            .get(parent_thread_id)
            .cloned();
        // The helper running on the parent thread is this helper's parent, whichever run it is
        // started beneath.
        let parent_subagent_id = parent_child
            .as_ref()
            .map(|parent| parent.subagent_id.clone());
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
            parent_tool_call_id: spawn_call_id.map(str::to_owned),
        };
        if let Some(parent_run_id) = parent_run_id {
            child.bound = self
                .deliver_child_start(
                    record,
                    child_thread_id,
                    &child,
                    parent_run_id,
                    parent_subagent_id,
                    helper_start,
                )
                .await;
        }
        bind_codex_helper_run(
            record,
            &self.dependencies.run_routes,
            child_thread_id.to_owned(),
            child,
        );
    }

    /// Ends the child run of a helper whose last turn ended, with the `subagent.completed` row,
    /// after the asks that turn still held and the pieces it still had waiting; `turn_params` is
    /// that turn's `turn/completed` params and `turn_members` the same params read as an object. A
    /// helper stopped at its token limit ends stopped for it unless its turn failed, and an end
    /// after the daemon's interrupt of the helper's run says it is that interrupt's; the run's
    /// helper route goes with it.
    pub(crate) async fn complete_child(
        &self,
        record: &mut CodexSessionRecord,
        child_thread_id: &str,
        turn_params: &RawValue,
        turn_members: &serde_json::Map<String, serde_json::Value>,
    ) {
        let turn = turn_members
            .get("turn")
            .and_then(serde_json::Value::as_object);
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
        let helper_route = self
            .dependencies
            .run_routes
            .retire_helper_run(bound.child_run_id);
        let is_stopped_at_token_limit = self
            .dependencies
            .stopped_helpers
            .is_stopped_at_token_limit(child_thread_id);
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
        let mut change = compose_codex_child_terminal(
            bound.child_run_id,
            turn_params.get(),
            &mut self.lock_diagnostics(),
        );
        // The limit's stop interrupts the helper's turn, which may still finish first; a failure
        // keeps its own words.
        if is_stopped_at_token_limit
            && matches!(
                change.entry,
                RunStateEntry::Completed { .. } | RunStateEntry::Interrupted { .. }
            )
        {
            change.entry = RunStateEntry::Stopped {
                intended_close: None,
                trigger: Some(StopTrigger::TokenLimit),
            };
        }
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
            is_daemon_interrupt_end: helper_route
                .is_some_and(|route| route.is_interrupted_by_daemon),
        };
        self.send(record, end, "turn/completed").await;
    }

    // The child run, naming the helper as `helper_start` names it and its parent helper
    // `parent_subagent_id`, and its `subagent.started` row, which names the child run the engine
    // started first; the child's start once the run engine started or refused it, `None` when it
    // absorbed it. A refused helper keeps its ended run, which absorbs its rows, and its
    // running turn is interrupted, as each turn it starts after is, and its tool calls are denied
    // with the refusal's sentence.
    async fn deliver_child_start(
        &self,
        record: &mut CodexSessionRecord,
        child_thread_id: &str,
        child: &CodexChildRun,
        parent_run_id: RunId,
        parent_subagent_id: Option<SubagentId>,
        helper_start: CodexHelperStart,
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
            // Codex names no start call: the spawn call stays the `subagent.started` row's.
            subagent: ChildRunSubagent {
                subagent_id: child.subagent_id.clone(),
                parent_subagent_id,
                name: helper_start.name,
                role: helper_start.role,
                provider_path: helper_start.provider_path,
                ask: helper_start.ask,
                model_id: helper_start.model_id,
                effort: helper_start.effort,
                start_call_id: None,
            },
        };
        let child_run_id = match self.send(record, start, CODEX_ITEM_COMPLETED_METHOD).await {
            Some(InboundOutcome::ChildRunStarted { run_id }) => Some(run_id),
            Some(InboundOutcome::ChildRunRefused { run_id, reason }) => {
                self.dependencies.stopped_helpers.stop_running(
                    record,
                    child_thread_id,
                    HelperStopReason::SetupRefused { refusal: reason },
                );
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
            .send(record, started_row, CODEX_ITEM_COMPLETED_METHOD)
            .await
            .and_then(|outcome| outcome.event_id().cloned());
        Some(CodexBoundChildRun {
            child_run_id: child_run_id?,
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
