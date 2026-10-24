//! What one Codex session's deliveries remember between frames: each turn's run epoch for the
//! session's terminal gate and the turn its run opened, the runs whose turn is starting, a turn's
//! last error, the reviewer's and the reroute's pending halves, the helpers' child runs, the prose
//! being streamed, and the reorder buffer rows pass.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use serde_json::Value;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::delivery::rows::{
    CodexProseRowType, CodexRowDelivery, CodexRowRun,
};
use crate::provider::driver::reorder_buffer::NormalizedEventReorderBuffer;
use crate::provider::driver::streamed_text::StreamedText;
use crate::session::run::engine::turns::StartedTurn;

/// How many tool rows may wait for their start at once. Codex sends an item's start before its end
/// on one ordered connection, so a held completion is a fault, reported when flushed.
const REORDER_MAX_BUFFERED_EVENTS: usize = 64;

/// How long a tool row waits for its start.
const REORDER_PAIRING_TIMEOUT: Duration = Duration::from_secs(5);

/// How many reviews a session remembers by id, oldest dropped first, so a repeat is dropped.
const CODEX_SEEN_REVIEW_MEMORY: usize = 64;

/// A turn's last error that Codex will not retry, which the turn's failure carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexTurnErrorReading {
    /// Codex's message, empty when it sent none.
    pub(crate) message: String,
    /// Codex's typed reason: a string arm, or the object arm's one key.
    pub(crate) error_kind: Option<String>,
}

/// Codex's typed reason for an error: a string arm, the object arm's one key, or `None`.
pub(crate) fn read_codex_error_kind(error: Option<&Value>) -> Option<String> {
    match error?.get("codexErrorInfo")? {
        Value::String(kind) => Some(kind.clone()),
        Value::Object(info) if info.len() == 1 => info.keys().next().cloned(),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => {
            None
        }
    }
}

/// A helper-spawning tool call in flight on a thread, with the run that made it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexSpawnCall {
    /// The call's item id.
    pub(crate) tool_call_id: String,
    /// The run that made it.
    pub(crate) run: CodexRowRun,
}

/// A helper's child run once started: its own id, the run it was started beneath, and the event
/// of its `subagent.started` row, `None` when that row was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "each member is an id, named for what it identifies"
)]
pub(crate) struct CodexStartedChildRun {
    /// The child run.
    pub(crate) child_run_id: RunId,
    /// The run it was started beneath.
    pub(crate) parent_run_id: RunId,
    /// The event of its `subagent.started` row.
    pub(crate) start_row_event_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
}

/// A helper Codex started, as its child run, and the spawn call and binding it came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexChildRun {
    /// The child run once started; `None` when its start was absorbed or refused, so no run owns
    /// the helper's rows.
    pub(crate) started: Option<CodexStartedChildRun>,
    /// The agent whose run the helper works for.
    pub(crate) agent_id: AgentId,
    /// The binding the helper's deliveries go on.
    pub(crate) binding_id: RuntimeBindingId,
    /// Codex's id for the helper.
    pub(crate) subagent_id: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
    /// The tool call that spawned it, where one did.
    pub(crate) parent_tool_call_id: Option<String>,
}

/// A command whose row is open, kept past its turn's end, since a command can outlive its turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexRunningCommand {
    /// The conversation it runs in, which may be one the session has since moved off.
    pub(crate) thread_id: String,
    /// The run and binding its row went out on.
    pub(crate) row: CodexRowRun,
    /// When it started, in Unix milliseconds.
    pub(crate) started_at_ms: u64,
}

/// An item whose prose is being streamed: the run its pieces go on and the row each is written as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexStreamedProse {
    /// The run.
    pub(crate) run: CodexRowRun,
    /// The row type.
    pub(crate) row_type: CodexProseRowType,
    /// The frame that opened it.
    pub(crate) method: &'static str,
}

/// One session's delivery memory; replaced with the session record on every establishment.
pub(crate) struct CodexDeliveryMemory {
    /// Each routed turn's epoch, the gate's run version; it leaves with the turn's terminal.
    pub(crate) turn_epoch_by_turn_id: HashMap<String, u64>,
    /// Each turn the run engine opened, with its number and the event that started it, which a
    /// flag about the whole turn points at. Each leaves with its turn's terminal.
    pub(crate) started_turn_by_turn_id: HashMap<String, StartedTurn>,
    /// Runs whose `turn/start` is on the wire, oldest first: Codex accepts them in send order.
    pub(crate) starting_turn_run_ids: VecDeque<RunId>,
    /// The last error per turn Codex will not retry, by turn id.
    pub(crate) final_error_by_turn_id: HashMap<String, CodexTurnErrorReading>,
    /// Turns Codex retried after an error, so a final error on one means its retries ran out.
    pub(crate) retried_turn_ids: HashSet<String>,
    /// Runs whose turn a faster-model retry stopped, by that turn's id: its end is the retry's,
    /// never the run's, and the run's binding stays for the turn the retry sends.
    pub(crate) retried_run_id_by_turn_id: HashMap<String, RunId>,
    /// The event of each tool call's start once written, by item id, which a reviewer flag about
    /// the call points at; each leaves with its item's end.
    pub(crate) tool_row_event_id_by_item_id: HashMap<String, FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The run each tool call's rows went on, by item id, which a review of the call blocks; each
    /// leaves with its item's end.
    pub(crate) tool_row_run_by_item_id: HashMap<String, CodexRowRun>,
    /// Turns whose reply has started, by turn id; each leaves with its turn's terminal.
    pub(crate) reply_started_turn_ids: HashSet<String>,
    /// A reviewer warning waiting for the next review on its thread, by thread id.
    pub(crate) guardian_warning_by_thread_id: HashMap<String, String>,
    /// The reviews already handled, oldest first and at most 64, so a repeat is dropped.
    pub(crate) seen_review_ids: VecDeque<String>,
    /// A reroute row waiting for its sentence, by thread id.
    pub(crate) pending_reroute_by_thread_id: HashMap<String, CodexRowDelivery>,
    /// Helpers' child runs, by the helper's thread id.
    pub(crate) child_run_by_thread_id: HashMap<String, CodexChildRun>,
    /// Each started child run's helper thread, by the child's run id.
    pub(crate) child_thread_id_by_run_id: HashMap<RunId, String>,
    /// Each helper-spawning tool call in flight, by its thread; oldest first.
    pub(crate) spawn_calls_by_thread_id: HashMap<String, Vec<CodexSpawnCall>>,
    /// When each tool item started, in Unix milliseconds, by turn id then item id, for its row's
    /// duration.
    pub(crate) item_started_at_ms_by_turn_id: HashMap<String, HashMap<String, u64>>,
    /// Each command whose row is open, by item id; it leaves on the command's own end.
    pub(crate) running_command_by_item_id: HashMap<String, CodexRunningCommand>,
    /// The files each change item in flight touches, by item id, which its approval names.
    pub(crate) changed_paths_by_item_id: HashMap<String, Vec<String>>,
    /// The turn Codex started by itself whose run is opening; `None` when none opens.
    pub(crate) self_started_turn_opening: Option<String>,
    /// Turns Codex started by itself whose run did not open: no run takes them.
    pub(crate) unowned_turn_ids: HashSet<String>,
    /// Every turn Codex started by itself, until its terminal: a turn sent while one whose run
    /// opened still runs would fold into it.
    pub(crate) self_started_turn_ids: HashSet<String>,
    /// The turns Codex holds for a safety check, by turn id, with the run each hold shows on;
    /// each leaves as its hold is lifted.
    pub(crate) safety_hold_run_by_turn_id: HashMap<String, CodexRowRun>,
    /// The tool rows waiting for their start.
    pub(crate) reorder_buffer: NormalizedEventReorderBuffer<CodexRowDelivery>,
    /// The replies, reasoning and plans being streamed, by item id, sent as stored pieces.
    pub(crate) streamed_text: StreamedText,
    /// What each streamed item's pieces go out as, by item id.
    pub(crate) streamed_prose_by_item_id: HashMap<String, CodexStreamedProse>,
}

impl CodexDeliveryMemory {
    /// A fresh delivery memory for one session record.
    pub(crate) fn new() -> Self {
        Self {
            turn_epoch_by_turn_id: HashMap::new(),
            started_turn_by_turn_id: HashMap::new(),
            starting_turn_run_ids: VecDeque::new(),
            final_error_by_turn_id: HashMap::new(),
            retried_turn_ids: HashSet::new(),
            retried_run_id_by_turn_id: HashMap::new(),
            tool_row_event_id_by_item_id: HashMap::new(),
            tool_row_run_by_item_id: HashMap::new(),
            reply_started_turn_ids: HashSet::new(),
            guardian_warning_by_thread_id: HashMap::new(),
            seen_review_ids: VecDeque::new(),
            pending_reroute_by_thread_id: HashMap::new(),
            child_run_by_thread_id: HashMap::new(),
            child_thread_id_by_run_id: HashMap::new(),
            spawn_calls_by_thread_id: HashMap::new(),
            item_started_at_ms_by_turn_id: HashMap::new(),
            running_command_by_item_id: HashMap::new(),
            changed_paths_by_item_id: HashMap::new(),
            self_started_turn_opening: None,
            unowned_turn_ids: HashSet::new(),
            self_started_turn_ids: HashSet::new(),
            safety_hold_run_by_turn_id: HashMap::new(),
            reorder_buffer: NormalizedEventReorderBuffer::new(
                DESCRIPTOR.provider_id(),
                REORDER_MAX_BUFFERED_EVENTS,
                REORDER_PAIRING_TIMEOUT,
            ),
            streamed_text: StreamedText::default(),
            streamed_prose_by_item_id: HashMap::new(),
        }
    }

    /// When the session's one timer next fires: the earliest of a streamed piece's interval and a
    /// held tool row's wait for its start; `None` when nothing waits.
    pub(crate) fn next_deadline(&self) -> Option<tokio::time::Instant> {
        [
            self.streamed_text.next_deadline(),
            self.reorder_buffer.next_release(),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// A turn's run epoch, given once, at the turn's first frame. `mint_epoch` counts across every
    /// record of the session, since its terminal gate outlives a resume.
    pub(crate) fn assign_turn_epoch(
        &mut self,
        turn_id: &str,
        mint_epoch: impl FnOnce() -> u64,
    ) -> u64 {
        *self
            .turn_epoch_by_turn_id
            .entry(turn_id.to_owned())
            .or_insert_with(mint_epoch)
    }

    /// Forgets what the memory held for a turn once its terminal was handled.
    pub(crate) fn forget_turn(&mut self, turn_id: &str) {
        self.turn_epoch_by_turn_id.remove(turn_id);
        self.started_turn_by_turn_id.remove(turn_id);
        self.final_error_by_turn_id.remove(turn_id);
        self.retried_turn_ids.remove(turn_id);
        self.retried_run_id_by_turn_id.remove(turn_id);
        self.reply_started_turn_ids.remove(turn_id);
        self.item_started_at_ms_by_turn_id.remove(turn_id);
        self.unowned_turn_ids.remove(turn_id);
        self.self_started_turn_ids.remove(turn_id);
    }

    /// Whether a turn's start is for no run to take: its run is opening as the session's own, or
    /// its opening failed.
    pub(crate) fn is_turn_taken_by_no_run(&self, turn_id: &str) -> bool {
        self.self_started_turn_opening.as_deref() == Some(turn_id)
            || self.unowned_turn_ids.contains(turn_id)
    }

    /// Records a review as handled; `false` when it already was, so the repeat is dropped.
    pub(crate) fn remember_review(&mut self, review_id: &str) -> bool {
        if self.seen_review_ids.iter().any(|seen| seen == review_id) {
            return false;
        }
        if self.seen_review_ids.len() == CODEX_SEEN_REVIEW_MEMORY {
            self.seen_review_ids.pop_front();
        }
        self.seen_review_ids.push_back(review_id.to_owned());
        true
    }
}
