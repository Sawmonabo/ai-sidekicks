//! Claude Code's requests as its export states them: each `api_request` log record and each
//! `claude_code.llm_request` span read into one request's facts, and each interaction span's
//! sequence. Every other record and span is passed over unread.

use opentelemetry_proto::tonic::common::v1::KeyValue;
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs};
use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, Span};
use serde_json::Map;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::capabilities::without_larger_window_mark;
use crate::pricing::receiver::records::{RecordRefusal, is_text, read_count, read_text};
use crate::usage_delta_accountant::UsageAxisCounts;

/// The name a refusal gives the export it read.
pub(crate) const CLAUDE_EXPORT: &str = "Claude Code's export";

/// The wire type of a request's log record.
const API_REQUEST_WIRE_TYPE: &str = "claude_code.api_request";

/// The name of a request's span.
const LLM_REQUEST_SPAN: &str = "claude_code.llm_request";

/// The name of the span each prompt opens, whose children are its requests.
const INTERACTION_SPAN: &str = "claude_code.interaction";

const EVENT_NAME_KEY: &str = "event.name";
const API_REQUEST_EVENT: &str = "api_request";
const SESSION_KEY: &str = "session.id";
const REQUEST_KEY: &str = "request_id";
const MODEL_KEY: &str = "model";
const SPEED_KEY: &str = "speed";
const AGENT_KEY: &str = "agent_id";
const CONTEXT_KEY: &str = "llm_request.context";
const STANDALONE_CONTEXT: &str = "standalone";
const DURATION_KEY: &str = "duration_ms";
const INPUT_KEY: &str = "input_tokens";
const OUTPUT_KEY: &str = "output_tokens";
const CACHE_READ_KEY: &str = "cache_read_tokens";
const CACHE_WRITE_KEY: &str = "cache_creation_tokens";
const CACHE_WRITE_EXTENDED_KEY: &str = "cache_creation_1h_tokens";
const SEQUENCE_KEY: &str = "interaction.sequence";

// The speed word Claude Code's export names its standard rates by.
const NORMAL_SPEED: &str = "normal";

const NANOS_PER_MILLI: u64 = 1_000_000;

/// What states a request in the export.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeRequestSource {
    /// Its `api_request` log record, which every request Claude Code's own figure counts has.
    Record,
    /// Its `claude_code.llm_request` span alone.
    Span,
}

impl ClaudeRequestSource {
    /// The wire type a refusal of a request from this source names.
    pub(crate) fn wire_type(self) -> &'static str {
        match self {
            Self::Record => API_REQUEST_WIRE_TYPE,
            Self::Span => LLM_REQUEST_SPAN,
        }
    }
}

/// One request as one record or span of Claude Code's export states it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeExportedRequest {
    /// What stated it.
    pub(crate) source: ClaudeRequestSource,
    /// The Claude Code session it names, which its process must hold.
    pub(crate) session_id: String,
    /// The API's id of the request, which its record and its span share.
    pub(crate) request_id: String,
    /// The model it ran on, without the larger-window mark.
    pub(crate) model_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// Its speed word, `None` for the standard rates.
    pub(crate) speed: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    /// The helper that sent it, `None` for the session's own thread.
    pub(crate) agent_id: Option<String>,
    /// Whether it ran outside any prompt's interaction.
    pub(crate) is_standalone: bool,
    /// Its counts: uncached input, cache reads and writes, and output.
    pub(crate) counts: UsageAxisCounts,
    /// The part of its cache write at the one-hour lifetime; `None` where the export splits none.
    pub(crate) cache_write_extended_tokens: Option<u64>,
    /// When it began, in Unix milliseconds.
    pub(crate) started_at_ms: u64,
    /// When it ended, in Unix milliseconds.
    pub(crate) ended_at_ms: u64,
    /// The trace of the interaction it ran in.
    pub(crate) trace_id: Vec<u8>,
}

impl ClaudeExportedRequest {
    /// Logs the request's one line read for price, which carries only its named fields.
    pub(crate) fn log_read_for_price(&self) {
        let counts = &self.counts;
        tracing::info!(
            source = ?self.source,
            request_id = self.request_id.as_str(),
            model = self.model_id.as_str(),
            speed = self.speed.as_ref().map(BoundedText::as_str),
            agent_id = self.agent_id.as_deref(),
            input_tokens = counts.input,
            cached_input_tokens = counts.cached_input,
            cache_write_input_tokens = counts.cache_write_input,
            output_tokens = counts.output,
            "claude code request read for price"
        );
    }
}

/// One interaction's place among its process's prompts, by its trace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeInteraction {
    /// The interaction's trace, which its requests' spans share.
    pub(crate) trace_id: Vec<u8>,
    /// Its 1-based place among the process's interactions.
    pub(crate) sequence: u64,
}

/// The requests `resource_logs`' `api_request` records state; a record that names no request,
/// model or session, or carries a count it cannot read, is refused whole and logged under
/// `provider_account_id`.
pub(crate) fn read_claude_record_requests(
    resource_logs: &ResourceLogs,
    provider_account_id: Option<&ProviderAccountId>,
) -> Vec<ClaudeExportedRequest> {
    let resource = resource_logs
        .resource
        .as_ref()
        .map_or(&[][..], |resource| &resource.attributes[..]);
    resource_logs
        .scope_logs
        .iter()
        .flat_map(|scope_logs| &scope_logs.log_records)
        .filter(|record| is_text(&record.attributes, EVENT_NAME_KEY, API_REQUEST_EVENT))
        .filter_map(|record| {
            read_record(record, resource)
                .map_err(|refusal| report(&refusal, provider_account_id, API_REQUEST_WIRE_TYPE))
                .ok()
        })
        .collect()
}

/// The requests `resource_spans`' `claude_code.llm_request` spans state and the sequence of each
/// interaction span; a request span refused as a record is, logged under `provider_account_id`.
pub(crate) fn read_claude_span_requests(
    resource_spans: &ResourceSpans,
    provider_account_id: Option<&ProviderAccountId>,
) -> (Vec<ClaudeExportedRequest>, Vec<ClaudeInteraction>) {
    let resource = resource_spans
        .resource
        .as_ref()
        .map_or(&[][..], |resource| &resource.attributes[..]);
    let mut requests = Vec::new();
    let mut interactions = Vec::new();
    for span in resource_spans
        .scope_spans
        .iter()
        .flat_map(|scope_spans| &scope_spans.spans)
    {
        match span.name.as_str() {
            LLM_REQUEST_SPAN => match read_span(span, resource) {
                Ok(request) => requests.push(request),
                Err(refusal) => report(&refusal, provider_account_id, LLM_REQUEST_SPAN),
            },
            INTERACTION_SPAN => {
                if let Ok(Some(sequence)) = read_count(&span.attributes, SEQUENCE_KEY) {
                    interactions.push(ClaudeInteraction {
                        trace_id: span.trace_id.clone(),
                        sequence,
                    });
                }
            }
            _ => {}
        }
    }
    (requests, interactions)
}

// Reports `refusal` as Claude Code's, for a record of `wire_type`.
fn report(
    refusal: &RecordRefusal,
    provider_account_id: Option<&ProviderAccountId>,
    wire_type: &str,
) {
    refusal.report(
        DESCRIPTOR.provider_id(),
        provider_account_id,
        CLAUDE_EXPORT,
        wire_type,
        Map::new(),
    );
}

// `record` as a request, its session read from `resource` where the record names none.
fn read_record(
    record: &LogRecord,
    resource: &[KeyValue],
) -> Result<ClaudeExportedRequest, RecordRefusal> {
    let stamped_ns = match record.time_unix_nano {
        0 => record.observed_time_unix_nano,
        stamped => stamped,
    };
    let ended_at_ms = stamped_ns / NANOS_PER_MILLI;
    let duration_ms = read_count(&record.attributes, DURATION_KEY)?.unwrap_or(0);
    read_request(
        &record.attributes,
        resource,
        ClaudeRequestSource::Record,
        (ended_at_ms.saturating_sub(duration_ms), ended_at_ms),
        Vec::new(),
    )
}

// `span` as a request, its session read from `resource` where the span names none.
fn read_span(span: &Span, resource: &[KeyValue]) -> Result<ClaudeExportedRequest, RecordRefusal> {
    read_request(
        &span.attributes,
        resource,
        ClaudeRequestSource::Span,
        (
            span.start_time_unix_nano / NANOS_PER_MILLI,
            span.end_time_unix_nano / NANOS_PER_MILLI,
        ),
        span.trace_id.clone(),
    )
}

// The request `attributes` state from `source`, over `(started, ended)` in Unix milliseconds.
fn read_request(
    attributes: &[KeyValue],
    resource: &[KeyValue],
    source: ClaudeRequestSource,
    (started_at_ms, ended_at_ms): (u64, u64),
    trace_id: Vec<u8>,
) -> Result<ClaudeExportedRequest, RecordRefusal> {
    let session_id = match read_text(attributes, SESSION_KEY)? {
        Some(session_id) => Some(session_id),
        None => read_text(resource, SESSION_KEY)?,
    }
    .filter(|session_id| !session_id.is_empty())
    .ok_or(RecordRefusal {
        field: SESSION_KEY,
        reason: "it names no session",
    })?;
    let request_id = read_text(attributes, REQUEST_KEY)?
        .filter(|request_id| !request_id.is_empty())
        .ok_or(RecordRefusal {
            field: REQUEST_KEY,
            reason: "it names no request",
        })?;
    let model_id = read_text(attributes, MODEL_KEY)?
        .and_then(|model| FreeFormText::new(without_larger_window_mark(model).to_owned()).ok())
        .ok_or(RecordRefusal {
            field: MODEL_KEY,
            reason: "it names no model the reader can hold",
        })?;
    let speed = read_text(attributes, SPEED_KEY)?
        .filter(|speed| *speed != NORMAL_SPEED)
        .map(|speed| {
            BoundedText::new(speed.to_owned()).ok_or(RecordRefusal {
                field: SPEED_KEY,
                reason: "its speed word is past its bound",
            })
        })
        .transpose()?;
    let agent_id = read_text(attributes, AGENT_KEY)?
        .filter(|agent_id| !agent_id.is_empty())
        .map(str::to_owned);
    let is_standalone = read_text(attributes, CONTEXT_KEY)? == Some(STANDALONE_CONTEXT);
    let counts = UsageAxisCounts {
        input: read_count(attributes, INPUT_KEY)?,
        cached_input: read_count(attributes, CACHE_READ_KEY)?,
        cache_write_input: read_count(attributes, CACHE_WRITE_KEY)?,
        output: read_count(attributes, OUTPUT_KEY)?,
        reasoning_output: None,
        total: None,
    };
    let cache_write_extended_tokens = match source {
        ClaudeRequestSource::Record => read_count(attributes, CACHE_WRITE_EXTENDED_KEY)?,
        ClaudeRequestSource::Span => None,
    };
    Ok(ClaudeExportedRequest {
        source,
        session_id: session_id.to_owned(),
        request_id: request_id.to_owned(),
        model_id,
        speed,
        agent_id,
        is_standalone,
        counts,
        cache_write_extended_tokens,
        started_at_ms,
        ended_at_ms,
        trace_id,
    })
}
