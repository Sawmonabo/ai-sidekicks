//! Codex's notices: a warning or a deprecation is the provider's own warning, a config warning is
//! the setting Codex ignored, and a model switch waits for the warning Codex sends next on its
//! thread, which is that switch's sentence and never a warning of its own. A switch replaced by a
//! second one before its warning, or still waiting when its turn ends, goes without a sentence.

use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::{
    AgentTurnReroutedPayload, ModelRerouteCause, ModelRerouteScope,
};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::session::controls::events::{
    ProviderWarningSource, SessionNotice, SessionNoticePostedPayload, SettingsIgnoredAtLineNotice,
    SettingsIgnoredKind,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::text_cut::cut_to_code_points;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::delivery::memory::CodexDeliveryMemory;
use crate::driver::codex::delivery::rows::{CodexRow, CodexRowDelivery, CodexRowRun, event_text};
use crate::record_readers::{read_count, read_non_empty_string};
use crate::run::delivery::LateAppendableRow;

/// Codex's one reroute reason, a cyber-safety check.
const CODEX_CYBER_REROUTE_REASON: &str = "highRiskCyberActivity";

/// The safety category a cyber-safety reroute names, as the provider's own word.
const CYBER_SAFETY_CATEGORY: &str = "cyber";

/// The frame a reroute row comes from.
const CODEX_MODEL_REROUTED_METHOD: &str = "model/rerouted";

/// What a `warning` frame became: its reroute's row with its sentence, the session's notice, or
/// nothing.
#[derive(Debug)]
pub(crate) enum CodexWarningReading {
    /// The sentence of the reroute waiting on its thread.
    Reroute(Box<CodexRowDelivery>),
    /// The session's provider warning.
    Notice(SessionNoticePostedPayload),
    /// A warning with no words.
    None,
}

/// The provider's own words fitted to a notice's or a row's text; `None` for words that are blank
/// or hold NUL.
pub(crate) fn provider_words(text: &str) -> Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> {
    FreeFormText::new(cut_to_code_points(text, PROVIDER_FAILURE_DETAIL_MAX_LEN).to_owned()).ok()
}

/// Holds a `model/rerouted` row on its thread for the warning that carries its sentence; answers
/// the row a second switch on the thread replaced, which goes without one.
pub(crate) fn hold_reroute(
    memory: &mut CodexDeliveryMemory,
    params: &Map<String, Value>,
    run: &CodexRowRun,
) -> Option<CodexRowDelivery> {
    let thread_id = read_non_empty_string(params, "threadId")?;
    let from_model = event_text(read_non_empty_string(params, "fromModel")?)?;
    let to_model = event_text(read_non_empty_string(params, "toModel")?)?;
    let is_cyber = params.get("reason").and_then(Value::as_str) == Some(CODEX_CYBER_REROUTE_REASON);
    let row = AgentTurnReroutedPayload {
        session_id: run.session_id,
        run_id: run.run_id,
        agent_id: Some(run.agent_id),
        from_model,
        to_model,
        scope: ModelRerouteScope::Turn,
        sentence: None,
        explanation: None,
        cause: ModelRerouteCause::Safety,
        safety_category: is_cyber
            .then(|| event_text(CYBER_SAFETY_CATEGORY))
            .flatten(),
        source_epoch: None,
        source_position: None,
    };
    memory.pending_reroute_by_thread_id.insert(
        thread_id.to_owned(),
        CodexRowDelivery {
            binding_id: run.binding_id.clone(),
            operation: None,
            row: CodexRow::Late(LateAppendableRow::AgentTurnRerouted(row)),
            body: None,
            method: CODEX_MODEL_REROUTED_METHOD,
        },
    )
}

/// Takes the reroute still waiting on a thread whose turn ended without its sentence.
pub(crate) fn release_reroute(
    memory: &mut CodexDeliveryMemory,
    thread_id: &str,
) -> Option<CodexRowDelivery> {
    memory.pending_reroute_by_thread_id.remove(thread_id)
}

/// Reads a `warning`: the sentence of the reroute waiting on its thread, else the session's.
pub(crate) fn read_codex_warning(
    memory: &mut CodexDeliveryMemory,
    session_id: SessionId,
    params: &Map<String, Value>,
) -> CodexWarningReading {
    let Some(message) = read_non_empty_string(params, "message").and_then(provider_words) else {
        return CodexWarningReading::None;
    };
    let reroute = read_non_empty_string(params, "threadId")
        .and_then(|thread_id| release_reroute(memory, thread_id));
    if let Some(mut reroute) = reroute
        && let CodexRow::Late(LateAppendableRow::AgentTurnRerouted(payload)) = &mut reroute.row
    {
        payload.sentence = Some(message);
        return CodexWarningReading::Reroute(Box::new(reroute));
    }
    CodexWarningReading::Notice(provider_warning(
        session_id,
        ProviderWarningSource::Warning,
        message,
        params,
    ))
}

/// Reads a `deprecationNotice` as the session's provider warning, or `None` with no words.
pub(crate) fn read_codex_deprecation_notice(
    session_id: SessionId,
    params: &Map<String, Value>,
) -> Option<SessionNoticePostedPayload> {
    let summary = read_non_empty_string(params, "summary").and_then(provider_words)?;
    Some(provider_warning(
        session_id,
        ProviderWarningSource::Deprecation,
        summary,
        params,
    ))
}

/// Reads a `configWarning` as the setting Codex ignored, by its file and first line; one that
/// names no file and line is a warning in Codex's own words. `None` when it carries no words
/// either.
pub(crate) fn read_codex_config_warning(
    session_id: SessionId,
    params: &Map<String, Value>,
) -> Option<SessionNoticePostedPayload> {
    let file = read_non_empty_string(params, "path")
        .and_then(|path| FilesystemPath::new(path.to_owned()).ok());
    let line = params
        .get("range")
        .and_then(|range| range.get("start"))
        .and_then(Value::as_object)
        .and_then(|start| read_count(start, "line"))
        .and_then(SafeInt::new);
    if let Some((file, line)) = file.zip(line) {
        return Some(SessionNoticePostedPayload::SettingsIgnoredAtLine(
            SettingsIgnoredAtLineNotice {
                session_id,
                kind: SettingsIgnoredKind::Value,
                provider: DESCRIPTOR.provider_id(),
                file,
                line,
                key: None,
            },
        ));
    }
    let summary = read_non_empty_string(params, "summary").and_then(provider_words)?;
    Some(provider_warning(
        session_id,
        ProviderWarningSource::Warning,
        summary,
        params,
    ))
}

// The session's provider warning in `text`, with the frame's `details` where it sent some.
fn provider_warning(
    session_id: SessionId,
    source: ProviderWarningSource,
    text: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    params: &Map<String, Value>,
) -> SessionNoticePostedPayload {
    SessionNoticePostedPayload::Notice(SessionNotice::ProviderWarning {
        session_id,
        source,
        text,
        details: read_non_empty_string(params, "details").and_then(provider_words),
    })
}
