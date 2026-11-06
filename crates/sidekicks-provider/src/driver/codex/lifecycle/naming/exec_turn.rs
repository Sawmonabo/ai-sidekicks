//! How a one-turn `codex exec --json` ended, read from the event lines it printed. Exec prints
//! `thread.started` first, naming only its thread; `turn.completed` carries `usage`, the thread's
//! running total from the last `thread/tokenUsage/updated`, so a one-turn exec's turn, and zeros
//! where no usage came; `turn.failed` carries none, and no event names the model. Read at Codex's
//! `rust-v0.166.0`: `codex-rs/exec/src/exec_events.rs` and
//! `codex-rs/exec/src/event_processor_with_jsonl_output.rs` (`usage_from_last_total`).

use serde::Deserialize;

use crate::usage_delta_accountant::UsageAxisCounts;

/// The event type exec prints first, naming its thread.
const THREAD_STARTED_EVENT: &str = "thread.started";

/// The event type of a turn that completed, with its counts.
const TURN_COMPLETED_EVENT: &str = "turn.completed";

/// The event type of a turn that failed.
const TURN_FAILED_EVENT: &str = "turn.failed";

/// How the turn of a one-turn `codex exec --json` ended.
pub(crate) enum ExecTurnEnd {
    /// The turn completed on `thread_id`, its thread's running total `counts`.
    Completed {
        /// The thread exec started.
        thread_id: String,
        /// The thread's running total, the one turn's counts.
        counts: UsageAxisCounts,
    },
    /// The turn failed, stating no counts.
    Failed,
}

// One event line `codex exec --json` writes.
#[derive(Deserialize)]
struct ExecEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    usage: Option<ExecUsage>,
}

// A turn's counts as `codex exec` writes them, its input holding the cached input.
#[derive(Deserialize)]
#[expect(
    clippy::struct_field_names,
    reason = "each count is named as Codex names it"
)]
struct ExecUsage {
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    cache_write_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    reasoning_output_tokens: Option<u64>,
}

impl From<ExecUsage> for UsageAxisCounts {
    // Codex totals a turn as its input and output, the cache inside the input.
    fn from(usage: ExecUsage) -> Self {
        Self {
            input: usage.input_tokens,
            cached_input: usage.cached_input_tokens,
            cache_write_input: usage.cache_write_input_tokens,
            output: usage.output_tokens,
            reasoning_output: usage.reasoning_output_tokens,
            total: usage
                .input_tokens
                .zip(usage.output_tokens)
                .and_then(|(input, output)| input.checked_add(output)),
        }
    }
}

/// The turn's end in what `codex exec --json` printed: `turn.completed` on the thread the
/// `thread.started` before it named, or `turn.failed`; `None` where it printed no end, a
/// `turn.completed` before any thread's start among them. A line that is no event is passed over.
pub(crate) fn read_exec_turn(printed: &str) -> Option<ExecTurnEnd> {
    let mut thread_id = None;
    for line in printed.lines() {
        let Ok(event) = serde_json::from_str::<ExecEvent>(line) else {
            continue;
        };
        match event.event_type.as_str() {
            THREAD_STARTED_EVENT => thread_id = event.thread_id,
            TURN_COMPLETED_EVENT => {
                let Some(thread_id) = thread_id.take() else {
                    continue;
                };
                let counts = event.usage.map(UsageAxisCounts::from).unwrap_or_default();
                return Some(ExecTurnEnd::Completed { thread_id, counts });
            }
            TURN_FAILED_EVENT => return Some(ExecTurnEnd::Failed),
            _ => {}
        }
    }
    None
}
