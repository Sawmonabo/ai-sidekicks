//! Codex's rollout file read for price while its service's export is absent: each completed
//! response's `token_usage_record` of the file's own thread, once per `response_id`, at the model
//! of the `turn_context` carrying the record's turn and the tier of the file's own last settings
//! snapshot before it, a spawned helper's at its root thread's tier; running totals and
//! `token_count` lines are never read. A turn that settled with no record names the file as one
//! that cannot be read until the file yields a record, and the turn the file shows live is kept
//! with its start. Every record of the file's own thread is offered to the export's responses
//! first, stamped before the reading's start or not, so a response an export carried is passed
//! over by its own line. Only the payloads of the kinds read are parsed, and only a usage record
//! that does not read is counted as refused.

use std::collections::VecDeque;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use crate::bounded_queue::remember;
use crate::driver::codex::DESCRIPTOR;
use crate::pricing::receiver::records::RecordRefusal;
use crate::usage_delta_accountant::UsageAxisCounts;

#[cfg(test)]
mod tests;

/// The record kind a completed response's usage is written under.
const TOKEN_USAGE_RECORD_KIND: &str = "token_usage_record";

/// What a refused rollout record was read from, completing "a record in".
const ROLLOUT_FILE: &str = "a Codex rollout file";

/// How many turns' models, and how many turns that wrote a record, one file remembers; the file's
/// records name its newest turns, so the oldest is forgotten past it.
const TURNS_KEPT: usize = 64;

/// How many response ids one file remembers as read, so a repeated record is read once.
const RESPONSES_KEPT: usize = 1_024;

/// The thread a rollout file belongs to, as its first `session_meta` names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexRolloutThread {
    /// The file's own thread.
    pub(crate) thread_id: String,
    /// The thread it was spawned or forked from, which the walk to a session thread starts at.
    pub(crate) parent_thread_id: Option<String>,
    /// Whether a spawned helper wrote it, whose requests run at its root thread's tier.
    pub(crate) is_spawned_helper: bool,
}

/// The tier a rollout's request was sent at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexRolloutTier {
    /// The file's own last settings snapshot before the record; `None` where it names none, the
    /// standard rates.
    Snapshot(Option<String>),
    /// The root thread's tier live at the record, which the session's stored rows hold.
    RootThread,
}

/// One completed response a rollout file states, to be priced as one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexRolloutRequest {
    /// Codex's id of the response, the request's key.
    pub(crate) response_id: String,
    /// The model the turn ran at.
    pub(crate) model: String,
    /// The tier it was sent at.
    pub(crate) tier: CodexRolloutTier,
    /// Its own counts, input holding the cached and written share as Codex counts it.
    pub(crate) counts: UsageAxisCounts,
    /// When Codex wrote the record, in Unix milliseconds.
    pub(crate) at_ms: u64,
}

/// What one rollout file's lines told so far: its thread, its turns' models, its own settings
/// snapshot's tier, the turns that wrote a record, the responses read, whether a settled turn
/// left no record since the last one, and the turn live as its last line was read.
#[derive(Debug, Default)]
pub(crate) struct CodexRolloutFile {
    thread: Option<CodexRolloutThread>,
    turn_models: VecDeque<(String, String)>,
    tier: Option<String>,
    is_own_settings_seen: bool,
    recorded_turns: VecDeque<String>,
    read_responses: VecDeque<String>,
    is_unreadable: bool,
    // The turn begun last and not ended, with its start's stamp where its line carries one.
    live_turn: Option<(String, Option<u64>)>,
}

// The members of a rollout line the reader reads: when it was written, its kind and what it
// holds, left unparsed until its kind is one the reader reads.
#[derive(Deserialize)]
struct RolloutLine {
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct SessionMetaPayload {
    id: Option<String>,
    parent_thread_id: Option<String>,
    forked_from_id: Option<String>,
    source: Option<Value>,
}

#[derive(Deserialize)]
struct TurnContextPayload {
    turn_id: Option<String>,
    model: Option<String>,
}

#[derive(Deserialize)]
struct UsageRecordPayload {
    thread_id: Option<String>,
    turn_id: Option<String>,
    response_id: Option<String>,
    usage: Option<RecordUsage>,
}

// A response's own usage, as Codex's `TokenUsage` writes it.
#[derive(Deserialize)]
struct RecordUsage {
    #[serde(rename = "input_tokens")]
    input: u64,
    #[serde(rename = "cached_input_tokens")]
    cached_input: u64,
    #[serde(default, rename = "cache_write_input_tokens")]
    cache_write_input: u64,
    #[serde(rename = "output_tokens")]
    output: u64,
    #[serde(rename = "reasoning_output_tokens")]
    reasoning_output: u64,
    #[serde(rename = "total_tokens")]
    total: u64,
}

// The members of the events the reader reads: a settings snapshot, a turn's start and its end.
#[derive(Deserialize)]
struct EventPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    thread_id: Option<String>,
    thread_settings: Option<SettingsSnapshot>,
    turn_id: Option<String>,
    error: Option<Value>,
}

#[derive(Deserialize)]
struct SettingsSnapshot {
    service_tier: Option<String>,
}

impl CodexRolloutFile {
    /// The file's thread, once its first `session_meta` was read.
    pub(crate) fn thread(&self) -> Option<&CodexRolloutThread> {
        self.thread.as_ref()
    }

    /// Whether a turn that settled since the reading's start left no record since the file's last
    /// one.
    pub(crate) fn is_unreadable(&self) -> bool {
        self.is_unreadable
    }

    /// Whether a turn the file shows begun at or before `at_ms`, in Unix milliseconds, has not
    /// ended yet; one whose start carries no stamp counts as begun.
    pub(crate) fn has_turn_live_from(&self, at_ms: u64) -> bool {
        self.live_turn.as_ref().is_some_and(|(_turn, started_ms)| {
            started_ms.is_none_or(|started_ms| started_ms <= at_ms)
        })
    }

    /// Reads one line of the file, answering the request it states where it is a record of the
    /// file's own thread not read before, that `is_exported` does not take as a response an export
    /// carried (asked with its thread, counts and stamp), stamped at or after `since_ms`. A record
    /// that cannot be read, or whose turn no `turn_context` names, is refused and logged.
    pub(crate) fn read_line(
        &mut self,
        line: &[u8],
        since_ms: u64,
        is_exported: &mut dyn FnMut(&str, &UsageAxisCounts, u64) -> bool,
    ) -> Option<CodexRolloutRequest> {
        // A line cut short as Codex writes it is read whole by the next pass.
        let line = serde_json::from_slice::<RolloutLine>(line).ok()?;
        let at_ms = line.timestamp.as_deref().and_then(read_unix_ms);
        let payload = line.payload?;
        match line.kind.as_deref()? {
            "session_meta" => {
                if self.thread.is_none() {
                    self.thread = read_payload(&payload).and_then(read_thread);
                }
                None
            }
            "turn_context" => {
                if let Some(TurnContextPayload {
                    turn_id: Some(turn_id),
                    model: Some(model),
                }) = read_payload(&payload)
                {
                    remember(&mut self.turn_models, (turn_id, model), TURNS_KEPT);
                }
                None
            }
            TOKEN_USAGE_RECORD_KIND => self.read_record(&payload, at_ms, since_ms, is_exported),
            "event_msg" => {
                if let Some(event) = read_payload::<EventPayload>(&payload) {
                    self.read_event(event, at_ms, since_ms);
                }
                None
            }
            _ => None,
        }
    }

    // A record's request, where it is the file's own thread's, read once, no exported response's
    // and stamped at or after `since_ms`.
    fn read_record(
        &mut self,
        payload: &RawValue,
        at_ms: Option<u64>,
        since_ms: u64,
        is_exported: &mut dyn FnMut(&str, &UsageAxisCounts, u64) -> bool,
    ) -> Option<CodexRolloutRequest> {
        let thread = self.thread.as_ref()?;
        let Some(UsageRecordPayload {
            thread_id: Some(thread_id),
            turn_id: Some(turn_id),
            response_id: Some(response_id),
            usage: Some(usage),
        }) = read_payload(payload)
        else {
            refuse_record(
                &RecordRefusal {
                    field: "payload",
                    reason: "it lacks its thread, turn, response or usage, or a count is bad",
                },
                &thread.thread_id,
                None,
            );
            return None;
        };
        // A copied ancestor's record keeps its own thread.
        if thread_id != thread.thread_id {
            return None;
        }
        self.is_unreadable = false;
        remember(&mut self.recorded_turns, turn_id.clone(), TURNS_KEPT);
        if self.read_responses.contains(&response_id) {
            return None;
        }
        remember(
            &mut self.read_responses,
            response_id.clone(),
            RESPONSES_KEPT,
        );
        let Some(at_ms) = at_ms else {
            refuse_record(
                &RecordRefusal {
                    field: "timestamp",
                    reason: "its line carries no time",
                },
                &thread_id,
                Some(&response_id),
            );
            return None;
        };
        let counts = UsageAxisCounts {
            input: Some(usage.input),
            cached_input: Some(usage.cached_input),
            cache_write_input: Some(usage.cache_write_input),
            output: Some(usage.output),
            reasoning_output: Some(usage.reasoning_output),
            total: Some(usage.total),
        };
        if is_exported(&thread_id, &counts, at_ms) {
            tracing::debug!(
                conversation_id = thread_id.as_str(),
                "a codex rollout record an export carried is passed over"
            );
            return None;
        }
        if at_ms < since_ms {
            return None;
        }
        let Some(model) = self
            .turn_models
            .iter()
            .rev()
            .find(|(turn, _model)| *turn == turn_id)
            .map(|(_turn, model)| model.clone())
        else {
            refuse_record(
                &RecordRefusal {
                    field: "turn_id",
                    reason: "no turn context in its file names its turn",
                },
                &thread_id,
                Some(&response_id),
            );
            return None;
        };
        let tier = if thread.is_spawned_helper {
            CodexRolloutTier::RootThread
        } else {
            CodexRolloutTier::Snapshot(self.tier.clone())
        };
        Some(CodexRolloutRequest {
            response_id,
            model,
            tier,
            counts,
            at_ms,
        })
    }

    // Takes the file's own settings snapshot's tier and its live turn, and marks the file
    // unreadable at a turn that settled from `since_ms` on with no record, once the file's own
    // snapshot was seen.
    fn read_event(&mut self, event: EventPayload, at_ms: Option<u64>, since_ms: u64) {
        let (Some(thread), Some(kind)) = (&self.thread, event.kind.as_deref()) else {
            return;
        };
        match kind {
            "thread_settings_applied" => {
                if event.thread_id.as_ref() == Some(&thread.thread_id) {
                    self.tier = event
                        .thread_settings
                        .and_then(|settings| settings.service_tier);
                    self.is_own_settings_seen = true;
                }
            }
            // Codex writes a turn's start and end under their older names and reads either.
            "task_started" | "turn_started" => {
                if let Some(turn_id) = event.turn_id
                    && self
                        .live_turn
                        .as_ref()
                        .is_none_or(|(live, _started_ms)| *live != turn_id)
                {
                    self.live_turn = Some((turn_id, at_ms));
                }
            }
            "turn_aborted" => {
                let is_live_ended = self.live_turn.as_ref().is_some_and(|(live, _started_ms)| {
                    event.turn_id.as_ref().is_none_or(|turn_id| turn_id == live)
                });
                if is_live_ended {
                    self.live_turn = None;
                }
            }
            "task_complete" | "turn_complete" => {
                if self.live_turn.as_ref().map(|(live, _started_ms)| live) == event.turn_id.as_ref()
                {
                    self.live_turn = None;
                }
                let is_since_start = at_ms.is_some_and(|at_ms| at_ms >= since_ms);
                if let Some(turn_id) = event.turn_id
                    && is_since_start
                    && self.is_own_settings_seen
                    && event.error.is_none()
                    && !self.recorded_turns.contains(&turn_id)
                {
                    self.is_unreadable = true;
                }
            }
            _ => {}
        }
    }
}

// `payload` read as one of the kinds the reader reads; `None` where it does not read so.
fn read_payload<Payload: DeserializeOwned>(payload: &RawValue) -> Option<Payload> {
    serde_json::from_str(payload.get()).ok()
}

// The thread a `session_meta` names, with the thread it came from and whether a spawned helper
// wrote it; `None` where it names no thread.
fn read_thread(meta: SessionMetaPayload) -> Option<CodexRolloutThread> {
    let spawn = meta
        .source
        .as_ref()
        .and_then(|source| source.get("subagent"))
        .and_then(|subagent| subagent.get("thread_spawn"));
    let spawned_from = spawn
        .and_then(|spawn| spawn.get("parent_thread_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some(CodexRolloutThread {
        thread_id: meta.id?,
        parent_thread_id: meta
            .parent_thread_id
            .or(spawned_from)
            .or(meta.forked_from_id),
        is_spawned_helper: spawn.is_some(),
    })
}

// A rollout line's stamp, `YYYY-MM-DDTHH:MM:SS.sssZ`, in Unix milliseconds.
fn read_unix_ms(stamp: &str) -> Option<u64> {
    let timestamp = stamp.parse::<jiff::Timestamp>().ok()?;
    u64::try_from(timestamp.as_millisecond()).ok()
}

// Reports `refusal` of a usage record of `thread_id`, naming its response where read, never a
// count it carries.
fn refuse_record(refusal: &RecordRefusal, thread_id: &str, response_id: Option<&str>) {
    let mut details = Map::new();
    details.insert("threadId".to_owned(), json!(thread_id));
    if let Some(response_id) = response_id {
        details.insert("responseId".to_owned(), json!(response_id));
    }
    refusal.report(
        DESCRIPTOR.provider_id(),
        None,
        ROLLOUT_FILE,
        TOKEN_USAGE_RECORD_KIND,
        details,
    );
}
