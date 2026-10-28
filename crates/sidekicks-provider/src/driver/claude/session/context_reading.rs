//! A Claude Code session's context reading: `get_context_usage` read after the process's
//! `system/init`, after each turn's `result`, after each compaction, after a model switch and after
//! a bound change, never on a timer. Each read is published for the ring and the `Context` section
//! and, where it follows a run's turn, filed on that run as its context-window row; the read after
//! `system/init` follows no run and is only published. Between reads, each lead assistant message's
//! usage gives a mid-turn reading on the last read's window, which the next read replaces, and a
//! turn too long for the window files a row marked exceeded with no counts. A helper gets no row.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::context_window::ContextWindowSource;
use sidekicks_contracts::event::usage::UsageContextWindowUpdatedPayload;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::{
    SessionCompactionBound, SessionContextBreakdown, SessionContextCategory,
    SessionContextCategoryKind, SessionContextPart, SessionContextReading, SessionContextUsage,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::number::Percent;
use sidekicks_contracts::wire::text::{ComposedText, FreeFormText};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::claude::delivery::stream::ClaudeSessionStreams;
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::claude::session::arrivals::deliver_in_session_order;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::control::{
    ClaudeContextUsageDetail, ClaudeControlRequest,
};
use crate::driver::context_window::{BOTTOM_STOP_HEADROOM_PERCENT, share_percent};
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};
use crate::port::context_reading_publisher::ContextReadingPublisher;
use crate::port::inbound_dispatch::InboundDispatch;
use crate::run::delivery::{DeliveryBinding, InboundDelivery, LateAppendableRow};
use crate::usage_delta_accountant::UsageAxisCounts;

/// The rows of Claude Code's report that make the session's fixed start: what every turn loads
/// before its first message.
const CLAUDE_FIXED_START_ROWS: [&str; 6] = [
    "system_prompt",
    "system_tools",
    "mcp_tools",
    "custom_agents",
    "memory_files",
    "skills",
];

// The members of a `get_context_usage` reply the reading reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeContextReply {
    #[serde(default, deserialize_with = "read_lenient")]
    categories: Option<LenientList<ClaudeContextRow>>,
    #[serde(default)]
    total_tokens: Option<Box<RawValue>>,
    #[serde(default)]
    max_tokens: Option<Box<RawValue>>,
    #[serde(default)]
    raw_max_tokens: Option<Box<RawValue>>,
    #[serde(default)]
    auto_compact_threshold: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "read_lenient")]
    model: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    memory_files: Option<LenientList<ClaudeNamedPart>>,
    #[serde(default, deserialize_with = "read_lenient")]
    mcp_tools: Option<LenientList<ClaudeNamedPart>>,
    #[serde(default, deserialize_with = "read_lenient")]
    agents: Option<LenientList<ClaudeNamedPart>>,
    #[serde(default, deserialize_with = "read_lenient")]
    system_tools: Option<LenientList<ClaudeNamedPart>>,
    #[serde(default, deserialize_with = "read_lenient")]
    system_prompt_sections: Option<LenientList<ClaudeNamedPart>>,
    #[serde(default, deserialize_with = "read_lenient")]
    skills: Option<ClaudeSkillsRow>,
}

// One row of the report.
#[derive(Deserialize)]
struct ClaudeContextRow {
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
    #[serde(default)]
    tokens: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "read_lenient")]
    kind: Option<String>,
}

// One named part of a row: a memory file by its path, a tool by its name, an agent by its type.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeNamedPart {
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    path: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    agent_type: Option<String>,
    #[serde(default)]
    tokens: Option<Box<RawValue>>,
}

// The skills row's parts.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSkillsRow {
    #[serde(default, deserialize_with = "read_lenient")]
    skill_frontmatter: Option<LenientList<ClaudeNamedPart>>,
}

lenient_object!(
    ClaudeContextReply,
    ClaudeContextRow,
    ClaudeNamedPart,
    ClaudeSkillsRow
);

/// One read of a session's context, composed: the reading the ring and the section read, and the
/// window figures its row carries.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClaudeContextRead {
    /// The reading.
    pub(crate) reading: SessionContextReading,
    /// The model Claude Code read it on.
    pub(crate) model: Option<String>,
}

// What one session's reads hold: the last read, and whether a read is under way with another
// asked for behind it, on the run the later ask follows.
#[derive(Default)]
struct ClaudeSessionReads {
    last: Option<ClaudeContextRead>,
    is_reading: bool,
    asked_again: Option<Option<ClaudeBoundRun>>,
}

/// Every live session's context reads, the latest of each, and where they go.
pub(crate) struct ClaudeContextReadings {
    publisher: Arc<PortRegistration<Arc<dyn ContextReadingPublisher>>>,
    dispatch: Arc<dyn InboundDispatch>,
    streams: Arc<ClaudeSessionStreams>,
    sessions: Mutex<HashMap<SessionId, ClaudeSessionReads>>,
}

impl ClaudeContextReadings {
    /// Readings published through `publisher` once registered, their rows filed through
    /// `dispatch` in each session's order on `streams`.
    pub(crate) fn new(
        publisher: Arc<PortRegistration<Arc<dyn ContextReadingPublisher>>>,
        dispatch: Arc<dyn InboundDispatch>,
        streams: Arc<ClaudeSessionStreams>,
    ) -> Self {
        Self {
            publisher,
            dispatch,
            streams,
            sessions: Mutex::default(),
        }
    }

    /// Reads `live`'s context from its process and files it on `run` where the read follows that
    /// run's turn; returns at once. A read asked while one is under way runs once that one ends,
    /// so a burst of asks costs two reads. A refused read is recorded.
    pub(crate) fn request_read(
        self: &Arc<Self>,
        live: &Arc<LiveClaudeSession>,
        run: Option<ClaudeBoundRun>,
    ) {
        {
            let mut sessions = lock(&self.sessions);
            let reads = sessions.entry(live.session_id).or_default();
            if reads.is_reading {
                reads.asked_again = Some(run);
                return;
            }
            reads.is_reading = true;
        }
        let readings = Arc::clone(self);
        let live = Arc::clone(live);
        tokio::spawn(async move {
            let mut run = run;
            loop {
                readings.read_once(&live, run).await;
                let mut sessions = lock(&readings.sessions);
                let Some(reads) = sessions.get_mut(&live.session_id) else {
                    return;
                };
                match reads.asked_again.take() {
                    Some(again) => run = again,
                    None => {
                        reads.is_reading = false;
                        return;
                    }
                }
            }
        });
    }

    /// The mid-turn reading the lead's assistant message with `counts` gives on the last read's
    /// window, published, with the row to file on `run_id`; `None` before any read or for a
    /// message that carries no input counts.
    pub(crate) fn read_mid_turn(
        &self,
        session_id: SessionId,
        run_id: RunId,
        counts: &UsageAxisCounts,
    ) -> Option<LateAppendableRow> {
        let used = [counts.input, counts.cache_write_input, counts.cached_input]
            .into_iter()
            .flatten()
            .reduce(u64::saturating_add)?;
        let last = lock(&self.sessions).get(&session_id)?.last.clone()?;
        let window = last.reading.window_tokens.get();
        let figure = |tokens: Option<u64>| SafeInt::<0>::new(tokens.unwrap_or(0));
        let reading = SessionContextReading {
            usage: Some(SessionContextUsage {
                used_tokens: SafeInt::new(used)?,
                used_percent: Percent::new(share_percent(used, window))?,
                breakdown: SessionContextBreakdown::Totals {
                    cached_input_tokens: figure(counts.cached_input)?,
                    input_tokens: figure(counts.input)?,
                    output_tokens: figure(counts.output)?,
                    reasoning_tokens: figure(counts.reasoning_output)?,
                },
            }),
            ..last.reading
        };
        if let Some(publisher) = self.publisher.port() {
            publisher.publish_context_reading(reading.clone());
        }
        Some(window_row(
            &ClaudeContextRead {
                reading,
                model: last.model,
            },
            Some(run_id),
        ))
    }

    /// Forgets a session whose process is gone.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        lock(&self.sessions).remove(&session_id);
    }

    // Publishes `read` and keeps it as the session's last, which later mid-turn readings are made
    // on.
    fn hold_read(&self, session_id: SessionId, read: ClaudeContextRead) {
        if let Some(publisher) = self.publisher.port() {
            publisher.publish_context_reading(read.reading.clone());
        }
        // A session forgotten while its read was under way is not held again.
        if let Some(reads) = lock(&self.sessions).get_mut(&session_id) {
            reads.last = Some(read);
        }
    }

    async fn read_once(&self, live: &LiveClaudeSession, run: Option<ClaudeBoundRun>) {
        let request = ClaudeControlRequest::GetContextUsage {
            detail: ClaudeContextUsageDetail::Summary,
        };
        let reply = match live.channel.send_control_request(request).await {
            Ok(answer) => answer.response,
            Err(error) => {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    live.session_id,
                    "the context read",
                    &error,
                );
                return;
            }
        };
        let Some(read) = compose_claude_context_read(live.session_id, reply.as_deref()) else {
            return;
        };
        self.hold_read(live.session_id, read.clone());
        let Some(run) = run else {
            return;
        };
        let delivery = InboundDelivery::SessionRow {
            binding: DeliveryBinding {
                binding_id: run.binding_id,
                operation: None,
            },
            row: window_row(&read, Some(run.run_id)),
            content: None,
        };
        // A refused row is reported by the dispatch.
        let _filed =
            deliver_in_session_order(&*self.dispatch, &self.streams, live.session_id, delivery)
                .await;
    }
}

/// The row a turn too long for the window files on `run_id`: exceeded, with no counts.
pub(crate) fn claude_exceeded_window_row(
    session_id: SessionId,
    run_id: RunId,
) -> LateAppendableRow {
    LateAppendableRow::UsageContextWindowUpdated(UsageContextWindowUpdatedPayload {
        session_id,
        run_id: Some(run_id),
        window_used_tokens: None,
        window_max_tokens: None,
        window_source: ContextWindowSource::ProviderReported,
        exceeded: true,
        model_id: None,
        subagent_id: None,
        source_epoch: None,
        source_position: None,
    })
}

/// `session_id`'s context reading from a `get_context_usage` `reply`: the used tokens against the
/// window (`maxTokens`, else `rawMaxTokens`), the top stop where Claude Code compacts, the bottom
/// stop the fixed start plus a tenth of the window, and the report's rows; `None` for a reply
/// that names no window.
pub(crate) fn compose_claude_context_read(
    session_id: SessionId,
    reply: Option<&RawValue>,
) -> Option<ClaudeContextRead> {
    let reply = <ClaudeContextReply as Lenient>::read(&mut serde_json::Deserializer::from_str(
        reply?.get(),
    ))
    .ok()
    .flatten()?;
    let window = count(reply.max_tokens.as_deref()).or(count(reply.raw_max_tokens.as_deref()))?;
    let window_tokens = SafeInt::<1>::new(window)?;
    // With no compaction point Claude Code does not compact, so the slider reaches the window.
    let top_stop = count(reply.auto_compact_threshold.as_deref())
        .map_or(100.0, |threshold| share_percent(threshold, window));
    let top_stop_percent = Percent::new(top_stop)?;
    let rows = reply
        .categories
        .as_ref()
        .map_or(&[][..], |rows| &rows.0[..]);
    let fixed_start = rows
        .iter()
        .filter(|row| {
            row.id
                .as_deref()
                .is_some_and(|id| CLAUDE_FIXED_START_ROWS.contains(&id))
        })
        .filter_map(|row| count(row.tokens.as_deref()))
        .reduce(u64::saturating_add);
    let bottom_stop_percent = fixed_start.and_then(|fixed_start| {
        Percent::new(
            (share_percent(fixed_start, window) + BOTTOM_STOP_HEADROOM_PERCENT)
                .ceil()
                .min(top_stop),
        )
    });
    let usage = count(reply.total_tokens.as_deref()).and_then(|used| {
        Some(SessionContextUsage {
            used_tokens: SafeInt::new(used)?,
            used_percent: Percent::new(share_percent(used, window))?,
            breakdown: SessionContextBreakdown::Buckets {
                categories: rows
                    .iter()
                    .filter_map(|row| context_category(row, &reply))
                    .collect(),
            },
        })
    });
    Some(ClaudeContextRead {
        reading: SessionContextReading {
            session_id,
            window_tokens,
            compaction: SessionCompactionBound {
                bound_percent: top_stop_percent,
                top_stop_percent,
                bottom_stop_percent,
                session_override: false,
            },
            usage,
        },
        model: reply.model.filter(|model| !model.is_empty()),
    })
}

// One row of the report as a bucket, with the parts the report names for it.
fn context_category(
    row: &ClaudeContextRow,
    reply: &ClaudeContextReply,
) -> Option<SessionContextCategory> {
    let kind = match row.kind.as_deref()? {
        "used" => SessionContextCategoryKind::Used,
        "deferred" => SessionContextCategoryKind::Deferred,
        "buffer" => SessionContextCategoryKind::Buffer,
        "free" => SessionContextCategoryKind::Free,
        _ => return None,
    };
    let parts = match row.id.as_deref() {
        Some("system_prompt") => reply.system_prompt_sections.as_ref(),
        Some("system_tools") => reply.system_tools.as_ref(),
        Some("mcp_tools") => reply.mcp_tools.as_ref(),
        Some("custom_agents") => reply.agents.as_ref(),
        Some("memory_files") => reply.memory_files.as_ref(),
        Some("skills") => reply
            .skills
            .as_ref()
            .and_then(|skills| skills.skill_frontmatter.as_ref()),
        Some(_) | None => None,
    }
    .map(|parts| parts.0.iter().filter_map(context_part).collect());
    Some(SessionContextCategory {
        name: ComposedText::new(row.name.clone()?)?,
        tokens: SafeInt::new(count(row.tokens.as_deref())?)?,
        kind,
        parts,
    })
}

fn context_part(part: &ClaudeNamedPart) -> Option<SessionContextPart> {
    let name = part
        .name
        .clone()
        .or_else(|| part.path.clone())
        .or_else(|| part.agent_type.clone())?;
    Some(SessionContextPart {
        name: ComposedText::new(name)?,
        tokens: SafeInt::new(count(part.tokens.as_deref())?)?,
    })
}

// The context-window row of `read`, on `run_id`.
fn window_row(read: &ClaudeContextRead, run_id: Option<RunId>) -> LateAppendableRow {
    let reading = &read.reading;
    let window_max_tokens = SafeInt::<0>::new(reading.window_tokens.get());
    let window_used_tokens = reading
        .usage
        .as_ref()
        .map(|usage| usage.used_tokens)
        .filter(|_| window_max_tokens.is_some());
    LateAppendableRow::UsageContextWindowUpdated(UsageContextWindowUpdatedPayload {
        session_id: reading.session_id,
        run_id,
        window_used_tokens,
        window_max_tokens: window_max_tokens.filter(|_| window_used_tokens.is_some()),
        window_source: ContextWindowSource::ProviderReported,
        exceeded: false,
        model_id: read
            .model
            .clone()
            .and_then(|model| FreeFormText::new(model).ok()),
        subagent_id: None,
        source_epoch: None,
        source_position: None,
    })
}

// A member's whole count; anything else reads as absent.
fn count(member: Option<&RawValue>) -> Option<u64> {
    member.and_then(|member| serde_json::from_str::<u64>(member.get()).ok())
}

#[cfg(test)]
mod tests;
