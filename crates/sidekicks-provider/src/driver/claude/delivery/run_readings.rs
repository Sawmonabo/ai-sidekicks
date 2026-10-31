//! What the stream reads off one session's process while it runs: the open turn's run and number,
//! its readings (the refusal, spent retries, a failed call's words, the step messages counted),
//! each run's start report, the rows held for their tool call's start, the blocks streaming, the
//! events each message was written as, the steers written `now` and not yet named taken, the
//! runs an interrupt stopped, the turn gate, the command and tool-server tasks running, and the
//! running turn's tokens received and task list. A turn's end settles its run's readings: a paused
//! run keeps them for its next turn, an interrupted one keeps them as the session's continuable
//! run, and any other run's go with it.

use std::collections::{HashMap, HashSet};

use sidekicks_contracts::event::declared_variants::RunAgentOutputPayload;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::transcript::whole_patch::stored_patch_files_body;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::commands::ClaudeCommandTasks;
use crate::driver::claude::delivery::mcp_tasks::ClaudeToolServerTasks;
use crate::driver::claude::delivery::messages::{
    ClaudeMessageBody, ClaudeMessageRow, ClaudeMessageRowKind, ClaudeOpenToolCall,
};
use crate::driver::claude::delivery::stream::daemon_ends::ClaudeDaemonEndedRun;
use crate::driver::claude::delivery::streamed_blocks::{
    ClaudeStreamedBlockKey, ClaudeStreamedBlocks,
};
use crate::driver::claude::delivery::turn_end::ClaudeTurnEnd;
use crate::driver::claude::delivery::turn_readings::ClaudeTurnReadings;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::state::CLAUDE_THREAD_FRAME_ROUTER_CONFIG;
use crate::driver::reorder_buffer::{NormalizedEventReorderBuffer, ReorderBufferedEvent};
use crate::run::delivery::{
    DeliveryBinding, DeliveryOperation, InboundDelivery, LateAppendableRow,
};
use crate::run::state_entry::{RunStateEntry, RunStateReport};
use crate::terminal_emission_gate::TerminalEmissionGate;

/// The id of an event a row was written as.
pub(crate) type ClaudeEventId = FreeFormText<EVENT_FIELD_MAX_LEN>;

/// What a row was read from, whose events a later choice names: its frame's own uuid, or the
/// streamed block it was a piece of.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ClaudeMessageKey {
    /// The frame's `uuid`.
    Uuid(String),
    /// The streamed block's key.
    Block(ClaudeStreamedBlockKey),
}

/// The turn the stream opened, on the run that holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeOpenTurn {
    /// The run.
    pub(crate) run_id: RunId,
    /// Its binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The turn's number within its run; `None` once the run had ended as the turn opened.
    pub(crate) turn_number: Option<SafeInt<1>>,
}

/// What a row is written as: a row that takes the stamp when late, or a reasoning update.
#[derive(Debug)]
pub(crate) enum ClaudeRow {
    /// A row the run engine stamps when it is late.
    Late(LateAppendableRow),
    /// An assistant's reasoning, whose text is the row's body.
    Thinking(RunAgentOutputPayload),
}

/// One row bound for the run engine on its run's binding, owned while the reorder buffer holds it.
#[derive(Debug)]
pub(crate) struct ClaudeRowDelivery {
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The tool call the row opens or continues, and whether it opens it.
    pub(crate) operation: Option<(String, bool)>,
    /// The row.
    pub(crate) row: ClaudeRow,
    /// The prose or patch the row carries, stored beside its payload.
    pub(crate) body: Option<String>,
    /// The message or streamed block the row came from, whose events a choice names later.
    pub(crate) message_key: Option<ClaudeMessageKey>,
}

impl ClaudeRowDelivery {
    /// One message row on `binding_id`, keyed by the message or block it came from.
    pub(crate) fn of_message(
        binding_id: &RuntimeBindingId,
        row: ClaudeMessageRow,
        message_key: Option<ClaudeMessageKey>,
    ) -> ReorderBufferedEvent<Self> {
        let operation = row
            .operation()
            .map(|operation| (operation.correlation_key.to_owned(), operation.is_opening));
        let ClaudeMessageRow {
            tool_call_id,
            pairing_role,
            row,
        } = row;
        let (row, body) = match row {
            ClaudeMessageRowKind::Thinking { payload, content } => {
                (ClaudeRow::Thinking(payload), Some(content))
            }
            ClaudeMessageRowKind::Session { row, body } => (
                ClaudeRow::Late(row),
                Some(match body {
                    ClaudeMessageBody::Text(text) => text,
                    ClaudeMessageBody::Patch(file) => {
                        stored_patch_files_body(std::slice::from_ref(&file))
                    }
                }),
            ),
        };
        ReorderBufferedEvent {
            tool_call_id,
            pairing_role,
            event: Self {
                binding_id: binding_id.clone(),
                operation,
                row,
                body,
                message_key,
            },
        }
    }
}

impl ClaudeRow {
    /// The run engine's delivery the row goes out as on `binding_id`, carrying `body` and
    /// borrowing the key of `operation`.
    pub(crate) fn into_inbound(
        self,
        binding_id: RuntimeBindingId,
        operation: Option<&(String, bool)>,
        body: Option<String>,
    ) -> InboundDelivery<'_> {
        let binding = DeliveryBinding {
            binding_id,
            operation: operation.map(|(correlation_key, is_opening)| DeliveryOperation {
                correlation_key,
                is_opening: *is_opening,
            }),
        };
        match self {
            Self::Thinking(payload) => InboundDelivery::ThinkingUpdate {
                binding,
                payload,
                content: body.unwrap_or_default(),
            },
            Self::Late(row) => InboundDelivery::SessionRow {
                binding,
                row,
                content: body,
            },
        }
    }
}

/// What the stream holds for one session while its process runs. Its lock is never held across
/// an await.
pub(crate) struct ClaudeStreamSession {
    /// The tool calls the lead started and has not answered.
    pub(crate) open_tool_calls: HashMap<String, ClaudeOpenToolCall>,
    /// The rows held for their tool call's start.
    pub(crate) buffer: NormalizedEventReorderBuffer<ClaudeRowDelivery>,
    /// The turn the stream opened, until its end.
    pub(crate) turn: Option<ClaudeOpenTurn>,
    /// The runs whose start report was delivered.
    pub(crate) initialized_runs: HashSet<RunId>,
    /// The words Claude Code sent the model for each failed or denied call of the turn.
    pub(crate) failed_call_words: HashMap<String, String>,
    /// The refusal no other model took, which ends the turn refused.
    pub(crate) refusal: Option<RunFailureCause>,
    /// Whether Claude Code spent its own retries during the turn.
    pub(crate) is_retries_spent: bool,
    /// The runs whose turn the driver's own interrupt is stopping.
    pub(crate) interrupted_runs: HashSet<RunId>,
    /// The newest run whose turn ended interrupted, kept for its next turn, and whether it holds
    /// the session's turn into the one Claude Code starts with the steers it kept.
    pub(crate) continuable_run: Option<(RunId, bool)>,
    /// The events each message of the open turn was written as, by its uuid or its block's key.
    pub(crate) event_ids_by_message_key: HashMap<ClaudeMessageKey, Vec<ClaudeEventId>>,
    /// The lead's messages of the open turn already counted as a step, by message id.
    pub(crate) counted_step_messages: HashSet<String>,
    /// The text and thinking the process is streaming.
    pub(crate) streamed_blocks: ClaudeStreamedBlocks,
    /// The steers written `now` that no `result` has yet named taken.
    pub(crate) now_steers: HashSet<String>,
    /// The run the reader kept holding the turn as it read the turn's end, a steer of it waiting.
    pub(crate) reader_carried_run: Option<RunId>,
    /// The runs whose end the daemon writes itself.
    pub(crate) daemon_ended: HashMap<RunId, ClaudeDaemonEndedRun>,
    /// The end of each run that completed with a steer waiting and went on into the next turn.
    pub(crate) carried_ends: HashMap<RunId, ClaudeTurnEndDelivery>,
    /// The session's terminal gate.
    pub(crate) gate: TerminalEmissionGate,
    /// The shell and Monitor tasks running, and the lines of the calls that start them.
    pub(crate) command_tasks: ClaudeCommandTasks,
    /// The tool servers' background calls held open until their tasks end.
    pub(crate) tool_server_tasks: ClaudeToolServerTasks,
    /// What the working line reads about the lead's running turn.
    pub(crate) turn_readings: ClaudeTurnReadings,
}

/// A turn's end as the stream delivers it on its run's binding: held while the daemon's own end
/// of the run is not certain, or kept for a run carried into Claude Code's next turn, delivered
/// after all should every steer that carried it be taken back before that turn opens.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClaudeTurnEndDelivery {
    /// The run's binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The turn's end as it composed.
    pub(crate) end: ClaudeTurnEnd,
    /// The turn's number; `None` when the run had ended as the turn opened.
    pub(crate) turn_number: Option<SafeInt<1>>,
}

impl ClaudeStreamSession {
    /// Empty readings for a process running on `provider_account_id`'s home.
    pub(crate) fn new(provider_account_id: ProviderAccountId) -> Self {
        Self {
            open_tool_calls: HashMap::new(),
            buffer: NormalizedEventReorderBuffer::new(
                DESCRIPTOR.provider_id(),
                CLAUDE_THREAD_FRAME_ROUTER_CONFIG.max_pending_hold_frames,
                CLAUDE_THREAD_FRAME_ROUTER_CONFIG.pending_registration_timeout,
            ),
            turn: None,
            initialized_runs: HashSet::new(),
            failed_call_words: HashMap::new(),
            refusal: None,
            is_retries_spent: false,
            interrupted_runs: HashSet::new(),
            continuable_run: None,
            event_ids_by_message_key: HashMap::new(),
            counted_step_messages: HashSet::new(),
            streamed_blocks: ClaudeStreamedBlocks::new(provider_account_id),
            now_steers: HashSet::new(),
            reader_carried_run: None,
            daemon_ended: HashMap::new(),
            carried_ends: HashMap::new(),
            gate: TerminalEmissionGate::new(),
            command_tasks: ClaudeCommandTasks::default(),
            tool_server_tasks: ClaudeToolServerTasks::default(),
            turn_readings: ClaudeTurnReadings::default(),
        }
    }

    /// Settles what a turn's end leaves of `run_id`: nothing for a run left paused, the session's
    /// continuable run for an interrupted one, carried into Claude Code's next turn when
    /// `is_carried`, and any other run's readings forgotten.
    pub(crate) fn settle_ended_run(
        &mut self,
        routes: &ClaudeRunRoutes,
        run_id: RunId,
        ended: ClaudeEndedAs,
        is_carried: bool,
    ) {
        match ended {
            ClaudeEndedAs::Paused => {}
            ClaudeEndedAs::Interrupted => {
                if let Some((previous, _)) = self.continuable_run
                    && previous != run_id
                {
                    self.forget_ended_run(routes, previous);
                }
                self.open_tool_calls.clear();
                self.continuable_run = Some((run_id, is_carried));
            }
            ClaudeEndedAs::Ended => self.forget_ended_run(routes, run_id),
        }
    }

    /// Takes the continuable run as a turn of `run_id` opens, forgetting it when the turn is
    /// another run's; answers whether this turn is the one Claude Code started with the steers the
    /// run kept, which continues it.
    pub(crate) fn take_continuable_run(&mut self, routes: &ClaudeRunRoutes, run_id: RunId) -> bool {
        match self.continuable_run.take() {
            Some((continuable, is_carried)) if continuable == run_id => is_carried,
            Some((continuable, _)) => {
                self.forget_ended_run(routes, continuable);
                false
            }
            None => false,
        }
    }

    // An ended run's route and start report, and the tool calls its turn left open, which can no
    // longer complete.
    fn forget_ended_run(&mut self, routes: &ClaudeRunRoutes, run_id: RunId) {
        routes.forget_run(run_id);
        self.initialized_runs.remove(&run_id);
        self.open_tool_calls.clear();
    }
}

/// How a turn's end left its run, which decides what of its readings stay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeEndedAs {
    /// Paused: its next turn reads on.
    Paused,
    /// Interrupted: continuable by a send or the turn Claude Code starts with the kept steers.
    Interrupted,
    /// Any other end.
    Ended,
}

impl ClaudeEndedAs {
    /// How `change` leaves its run; a turn end that moves no run leaves it paused, as only a turn
    /// Claude Code started on a paused run moves none.
    pub(crate) fn of(change: Option<&RunStateReport>) -> Self {
        match change.map(|change| &change.entry) {
            None | Some(RunStateEntry::Paused | RunStateEntry::Pausing) => Self::Paused,
            Some(RunStateEntry::Interrupted { .. }) => Self::Interrupted,
            Some(
                RunStateEntry::Starting
                | RunStateEntry::Running { .. }
                | RunStateEntry::WaitingForApproval
                | RunStateEntry::WaitingForInput
                | RunStateEntry::Completed { .. }
                | RunStateEntry::Stopped { .. }
                | RunStateEntry::Failed { .. },
            ) => Self::Ended,
        }
    }
}
