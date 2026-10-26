//! What each frame of a session's Codex threads becomes for the run engine: a turn's boundary and
//! end, its tool calls' rows (a command's end even after its turn ended or the session moved off
//! its conversation), the reply, reasoning and plan streamed as pieces, a command's live output, a
//! helper's own rows on its child run, the reviewer's flags and blocks, the provider's notices, a
//! model switch with its sentence, the live safety hold, and the tool boundary the run queue
//! releases its held messages at. The session's queue hands each frame over in arrival order and
//! every delivery is dispatched and awaited before the next, so rows land in frame order; what a
//! frame tells the rest of the driver comes back as its dispatch.

mod items;
mod notices;
mod reviews;
pub(crate) mod turns;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::provider::compaction_wait::PendingCompactionRegistry;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::delivery::rows::{CodexRowDelivery, CodexRowRun};
use crate::provider::driver::codex::run::routes::{CodexRunBinding, CodexRunRoutes};
use crate::provider::driver::codex::server_requests::CodexAskKind;
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::driver::codex::turn_evidence::CodexTurnStatus;
use crate::provider::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::provider::driver::diagnostics::OnceReportedDiagnostics;
use crate::provider::driver::run_control::RunToolBoundary;
use crate::provider::port::command_output_publisher::CommandOutputPublisher;
use crate::provider::port::registration::PortRegistration;
use crate::provider::port::reviewer_denial::ReviewerDenialPort;
use crate::provider::record_readers::read_non_empty_string;
use crate::provider::terminal_emission_gate::TerminalEmissionGate;
use crate::provider::thread_frame_router::ThreadFrameRoute;
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::turns::ProviderTurnEnd;
use crate::session::run::inbound::{InboundDelivery, InboundOutcome, RunInboundDispatch};

/// What the rest of the Codex driver does for a frame, which the frame delivery cannot do itself.
pub(crate) trait CodexFrameEffects: Send + Sync {
    /// Settles the card of an ask Codex resolved or let go of itself, on the session's account.
    fn withdraw_ask(
        &self,
        session_id: SessionId,
        provider_account_id: Option<&ProviderAccountId>,
        request_id: &str,
        ask_kind: CodexAskKind,
    );

    /// Drops the corrections and lets go of the questions waiting on a turn that ended.
    fn forget_turn_asks(&self, session_id: SessionId, turn_id: &str);

    /// Cuts a turn too long for the model's window out of the conversation `thread_id`.
    fn cut_oversized_turn(&self, session_id: SessionId, thread_id: &str, turn_id: &str);

    /// Receives each tool call of the session's own thread that ended while its turn runs.
    fn on_tool_boundary(&self, boundary: RunToolBoundary);

    /// Receives a plan Codex proposed on `run`, its whole `text`, from the plan item `item_id` of
    /// the turn `turn_id`.
    fn plan_proposed(&self, run: &CodexRowRun, text: &str, turn_id: &str, item_id: &str);
}

/// What the frame delivery reads and acts through.
pub(crate) struct CodexFrameDeliveryDependencies {
    /// The run engine, which opens each turn and counts its steps.
    pub(crate) engine: Arc<RunEngine>,
    /// The run engine's inbound dispatch, where every row and move goes.
    pub(crate) dispatch: Arc<RunInboundDispatch>,
    /// The driver's run routes.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// The approval service's intake of the reviewer's blocks.
    pub(crate) reviewer_denials: Arc<PortRegistration<Arc<dyn ReviewerDenialPort>>>,
    /// The running-commands stream's live output; absent, a command's output is dropped.
    pub(crate) command_output: Arc<PortRegistration<Arc<dyn CommandOutputPublisher>>>,
    /// The compaction waits, which a compaction's own turn ends.
    pub(crate) pending_compactions: PendingCompactionRegistry,
    /// What the rest of the driver does for a frame.
    pub(crate) effects: Arc<dyn CodexFrameEffects>,
}

/// One of the person's messages Codex took into a turn, by the id it was sent under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexTakenMessage {
    /// The id the message was sent under, Codex's `clientId`.
    pub(crate) client_message_id: String,
    /// The turn it went into.
    pub(crate) turn_id: String,
}

/// One `userPromptSubmit` hook handler's run on one prompt, whatever its status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexPromptHookRun {
    /// The turn the prompt was for, where the frame named one.
    pub(crate) turn_id: Option<String>,
    /// The handler's id, the same on every prompt it runs for.
    pub(crate) run_id: String,
    /// Whether the handler blocked the prompt.
    pub(crate) is_blocked: bool,
    /// Whether the handler stopped the turn.
    pub(crate) is_stopped: bool,
    /// A blocking or stopping handler's words, each entry in order, else its status message.
    pub(crate) words: Vec<String>,
}

/// A run the frame moved, and the state it moved into.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CodexRunMove {
    /// The run.
    pub(crate) run_id: RunId,
    /// The state the move enters.
    pub(crate) to: RunStateChangeState,
}

/// A turn of the session's own conversation that ended, with its run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexTurnMove {
    /// The turn.
    pub(crate) turn_id: String,
    /// Its run.
    pub(crate) run_id: RunId,
    /// How the turn's run stood when the frame arrived.
    pub(crate) ending: CodexTurnEnding,
    /// The end the run engine records for a turn whose end moves no run: a paused or retried
    /// turn's; `None` for an end the run's own move or its interrupt records.
    pub(crate) turn_end: Option<ProviderTurnEnd>,
}

/// What one frame told the rest of the driver.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CodexFrameDispatch {
    /// The ask Codex resolved itself, by its request id, which the driver's request-resolved
    /// signal names.
    pub(crate) resolved_request_id: Option<String>,
    /// The person's messages Codex took into a turn.
    pub(crate) taken_messages: Vec<CodexTakenMessage>,
    /// The `userPromptSubmit` hook runs the frame reported.
    pub(crate) prompt_hook_runs: Vec<CodexPromptHookRun>,
    /// The runs the frame moved.
    pub(crate) run_moves: Vec<CodexRunMove>,
    /// The turns that ended.
    pub(crate) turns_ended: Vec<CodexTurnMove>,
}

/// How a turn's run stands when one of its frames arrives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexTurnEnding {
    /// The turn runs on its run.
    Live,
    /// An interrupt took it from its run.
    Interrupted,
    /// A pause interrupted it.
    Paused,
    /// A faster-model retry stopped it.
    Retried,
}

/// The run one turn's frames belong to, with its binding and how the turn stands.
struct CodexTurnRun {
    run_id: RunId,
    binding: CodexRunBinding,
    ending: CodexTurnEnding,
}

impl CodexTurnRun {
    fn row_run(&self) -> CodexRowRun {
        CodexRowRun {
            session_id: self.binding.session_id,
            run_id: self.run_id,
            agent_id: self.binding.agent_id,
            binding_id: self.binding.binding_id.clone(),
        }
    }
}

/// The run an item frame's rows go on, with the turn it belongs to.
struct CodexItemRun {
    turn_id: String,
    row: CodexRowRun,
}

/// Turns every frame the routing keeps for a session into its deliveries, for every session of
/// one Codex driver.
pub(crate) struct CodexFrameDelivery {
    pub(super) dependencies: CodexFrameDeliveryDependencies,
    /// The gate's run versions, counted for the whole driver so no two turns of a run share one.
    next_turn_epoch: AtomicU64,
    /// The diagnostics already logged, so a frame that keeps arriving is logged once.
    diagnostics: Mutex<OnceReportedDiagnostics>,
}

impl CodexFrameDelivery {
    /// The frame delivery over `dependencies`.
    pub(crate) fn new(dependencies: CodexFrameDeliveryDependencies) -> Self {
        Self {
            dependencies,
            next_turn_epoch: AtomicU64::new(1),
            diagnostics: Mutex::new(OnceReportedDiagnostics::default()),
        }
    }

    /// Delivers one frame the routing kept for the session `record` holds, with the router's
    /// `route` for it, while the turn bookkeeping still holds the turn's route; `gate` is the
    /// session's terminal gate, which outlives its records. Never fails: each delivery's failure
    /// is reported where it happens.
    pub(crate) async fn deliver(
        &self,
        record: &mut CodexSessionRecord,
        gate: &mut TerminalEmissionGate,
        method: &str,
        params: &RawValue,
        route: ThreadFrameRoute,
    ) -> CodexFrameDispatch {
        // A frame whose params are no object reads as one with no members, as each reader skips
        // what it lacks.
        let members: Map<String, Value> = serde_json::from_str(params.get()).unwrap_or_default();
        let mut dispatch = CodexFrameDispatch::default();
        match method {
            "turn/started" => {
                self.deliver_turn_started(record, &members).await;
            }
            "turn/completed" => {
                let frame = turns::TurnCompletedFrame {
                    params: params.get(),
                    members: &members,
                    route,
                };
                self.deliver_turn_completed(record, gate, frame, &mut dispatch)
                    .await;
            }
            "item/started" => self.deliver_item_started(record, &members).await,
            "item/completed" => {
                self.deliver_item_completed(record, &members, &mut dispatch)
                    .await;
            }
            "item/agentMessage/delta"
            | "item/plan/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/summaryPartAdded"
            | "item/reasoning/textDelta" => self.deliver_prose_delta(record, method, &members),
            "item/commandExecution/outputDelta" => self.deliver_command_output(record, &members),
            "error" => self.deliver_turn_error(record, &members).await,
            "guardianWarning"
            | "item/autoApprovalReview/completed"
            | "autoApprovalReview/strictReviewRequired" => {
                self.deliver_reviewer_frame(record, method, &members).await;
            }
            "hook/completed" => turns::read_prompt_hook_run(&members, &mut dispatch),
            "serverRequest/resolved" => {
                dispatch.resolved_request_id = self.forget_resolved_request(record, &members);
            }
            "model/safetyBuffering/updated" => {
                self.deliver_safety_buffering(record, &members).await;
            }
            _ => self.deliver_notice(record, method, &members).await,
        }
        dispatch
    }

    /// Sends the streamed pieces whose interval has passed by `now` and the tool rows whose wait
    /// for their start ran out, for the session's one timer at `record.delivery.next_deadline()`.
    pub(crate) async fn deliver_due(
        &self,
        record: &mut CodexSessionRecord,
        now: tokio::time::Instant,
    ) {
        let pieces = record.delivery.streamed_text.due(now);
        for piece in pieces {
            self.admit_prose_piece(record, &piece.key, piece.text).await;
        }
        let expired = record.delivery.reorder_buffer.flush_expired(now);
        self.send_rows(record, expired).await;
    }

    // The next run version of the session's terminal gate.
    fn mint_turn_epoch(&self) -> u64 {
        self.next_turn_epoch.fetch_add(1, Ordering::Relaxed)
    }

    pub(super) fn lock_diagnostics(&self) -> MutexGuard<'_, OnceReportedDiagnostics> {
        self.diagnostics
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Hands one delivery to the run engine, reporting its failure; `None` when it failed.
    pub(crate) async fn send(
        &self,
        record: &CodexSessionRecord,
        delivery: InboundDelivery<'_>,
        method: &str,
    ) -> Option<InboundOutcome> {
        let origin = DeliveryOrigin {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: record.provider_account_id.clone(),
            raw_wire_type: Some(method),
        };
        // Boxed per delivery, so the engine's dispatch never sits inside every frame's future.
        Box::pin(dispatch_delivery(
            &self.dependencies.dispatch,
            origin,
            delivery,
        ))
        .await
    }

    // Sends one row, keeping the event and run of a tool call's start, which a reviewer flag and
    // block point at.
    async fn send_row(
        &self,
        record: &mut CodexSessionRecord,
        row: CodexRowDelivery,
    ) -> Option<FreeFormText<EVENT_FIELD_MAX_LEN>> {
        let tool_call_id = row.invoked_tool_call_id().map(str::to_owned);
        let CodexRowDelivery {
            binding_id,
            operation,
            row,
            body,
            method,
        } = row;
        let event_id = self
            .send(
                record,
                row.into_inbound(binding_id, operation.as_ref(), body),
                method,
            )
            .await
            .and_then(|outcome| outcome.event_id().cloned());
        if let Some(tool_call_id) = tool_call_id
            && let Some(event_id) = &event_id
        {
            record
                .delivery
                .tool_row_event_id_by_item_id
                .insert(tool_call_id, event_id.clone());
        }
        event_id
    }

    async fn send_rows(&self, record: &mut CodexSessionRecord, rows: Vec<CodexRowDelivery>) {
        for row in rows {
            self.send_row(record, row).await;
        }
    }

    // A live turn's run, else the run an interrupt, a pause or a retry took the turn from, whose
    // last frames still belong to it; `None` when no run holds it or its run ended.
    fn turn_run_for(&self, record: &CodexSessionRecord, turn_id: &str) -> Option<CodexTurnRun> {
        let (run_id, ending) = find_turn_run_id(record, turn_id)?;
        let binding = self.dependencies.run_routes.binding_for(run_id)?;
        Some(CodexTurnRun {
            run_id,
            binding,
            ending,
        })
    }

    // The run a turn-scoped frame of the session's own thread belongs to, as rows name it.
    fn row_run_for(
        &self,
        record: &CodexSessionRecord,
        members: &Map<String, Value>,
        method: &str,
    ) -> Option<CodexItemRun> {
        if read_non_empty_string(members, "threadId") != Some(record.thread_id.as_str()) {
            return None;
        }
        let turn_id = read_non_empty_string(members, "turnId");
        let Some((turn_id, turn_run)) =
            turn_id.and_then(|turn_id| Some((turn_id, self.turn_run_for(record, turn_id)?)))
        else {
            report_unattributed(method, turn_id);
            return None;
        };
        Some(CodexItemRun {
            turn_id: turn_id.to_owned(),
            row: turn_run.row_run(),
        })
    }
}

/// The run holding the turn `turn_id` and how: its live run, else the run an interrupt, a pause or
/// a retry took the turn from, whose last frames still belong to it; `None` when no run holds it.
/// A pause marks its turn before its interrupt goes and the mark leaves only once the turn's end
/// was applied, so a marked turn reads paused even while it is still live, its end read by its
/// status as `read_turn_ending` says.
pub(crate) fn find_turn_run_id(
    record: &CodexSessionRecord,
    turn_id: &str,
) -> Option<(RunId, CodexTurnEnding)> {
    let is_pausing = record
        .paused_run_id_by_interrupted_turn_id
        .contains_key(turn_id);
    record
        .active_turn_run(turn_id)
        .filter(|_| !is_pausing)
        .map(|run_id| (run_id, CodexTurnEnding::Live))
        .or_else(|| {
            record
                .interrupted_turn_run(turn_id)
                .map(|run_id| (run_id, CodexTurnEnding::Interrupted))
        })
        .or_else(|| {
            record
                .paused_run_id_by_interrupted_turn_id
                .get(turn_id)
                .map(|run_id| (*run_id, CodexTurnEnding::Paused))
        })
        .or_else(|| {
            record
                .delivery
                .retried_run_id_by_turn_id
                .get(turn_id)
                .map(|run_id| (*run_id, CodexTurnEnding::Retried))
        })
}

// How the turn `turn_id`, which `find_turn_run_id` found standing `ending`, ended, by the status
// its `turn/completed` reports. The daemon marks a turn before its interrupt goes, so a marked
// turn that ends `interrupted` is the daemon's stop, never Codex's own: paused under a pause's
// mark, else interrupted. A pause-marked turn that failed by itself ends as a live turn does, so
// its failure surfaces, and so does one ending with a status Codex does not send; one that
// completed by itself is the step that landed, so it reads paused.
fn read_turn_ending(
    record: &CodexSessionRecord,
    turn_id: &str,
    ending: CodexTurnEnding,
    status: Option<CodexTurnStatus>,
) -> CodexTurnEnding {
    match (ending, status) {
        (CodexTurnEnding::Paused, Some(CodexTurnStatus::Failed) | None) => CodexTurnEnding::Live,
        (CodexTurnEnding::Live, Some(CodexTurnStatus::Interrupted))
            if record.interrupting_turn_ids.contains(turn_id) =>
        {
            CodexTurnEnding::Interrupted
        }
        (ending, _) => ending,
    }
}

/// Reports a frame whose run no live route, interrupt or starting turn names.
fn report_unattributed(method: &str, turn_id: Option<&str>) {
    CodexTransportDiagnostic::UnattributedTurnFrame {
        method: method.to_owned(),
        turn_id: turn_id.map(str::to_owned),
    }
    .report();
}
