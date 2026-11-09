//! Reading a throwaway copy's one turn: its reply, its usage metered against the copy's own base,
//! and how the turn ended.

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_ipc::redaction::scrub_credentials;

use crate::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_THREAD_TOKEN_USAGE_METHOD, CODEX_TURN_COMPLETED_METHOD,
};
use crate::driver::codex::token_usage::read_codex_token_usage;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::usage_delta_accountant::{MeteredUsageDelta, UsageDeltaAccountant};

/// The item type of the copy's reply.
const CODEX_AGENT_MESSAGE_ITEM_TYPE: &str = "agentMessage";

/// Why a copy's turn gave no answer when Codex named no error.
const NO_ANSWER_DETAIL: &str = "The copy's turn ended with no answer.";

// The members of a copy's frame the copy reads.
#[derive(Deserialize)]
struct CopyFrame {
    item: Option<CopyItem>,
    turn: Option<CopyTurn>,
}

#[derive(Deserialize)]
struct CopyItem {
    #[serde(rename = "type")]
    item_type: Option<String>,
    text: Option<String>,
}

/// How a copy's turn ended, as its frame read.
#[derive(Deserialize)]
pub(crate) struct CopyTurn {
    status: Option<String>,
    /// Codex's error, where the turn failed with one.
    pub(crate) error: Option<Value>,
}

impl CopyTurn {
    /// Whether `turn` completed.
    pub(crate) fn is_completed(turn: Option<&Self>) -> bool {
        turn.is_some_and(|turn| {
            turn.status.as_deref().and_then(CodexTurnStatus::read)
                == Some(CodexTurnStatus::Completed)
        })
    }
}

/// What one frame of a copy's turn says.
pub(crate) enum CopyFrameReading {
    /// The copy's reply.
    Reply(String),
    /// A usage reading, metered against the copy's own base.
    Usage(Box<MeteredUsageDelta>),
    /// The turn ended, as the frame's turn reads where it carried one.
    Ended(Option<CopyTurn>),
    /// Nothing the copy reads.
    Other,
}

/// Reads one frame of a copy's turn, its usage metered through `accountant`.
pub(crate) fn read_copy_frame(
    method: &str,
    params: &RawValue,
    accountant: &mut UsageDeltaAccountant,
) -> CopyFrameReading {
    match method {
        CODEX_ITEM_COMPLETED_METHOD => read_codex_object::<CopyFrame>(params.get())
            .and_then(|frame| frame.item)
            .filter(|item| item.item_type.as_deref() == Some(CODEX_AGENT_MESSAGE_ITEM_TYPE))
            .and_then(|item| item.text)
            .filter(|text| !text.is_empty())
            .map_or(CopyFrameReading::Other, CopyFrameReading::Reply),
        CODEX_THREAD_TOKEN_USAGE_METHOD => read_codex_token_usage(params)
            .and_then(|reading| accountant.meter_reading(reading))
            .map_or(CopyFrameReading::Other, |delta| {
                CopyFrameReading::Usage(Box::new(delta))
            }),
        CODEX_TURN_COMPLETED_METHOD => CopyFrameReading::Ended(
            read_codex_object::<CopyFrame>(params.get()).and_then(|frame| frame.turn),
        ),
        _ => CopyFrameReading::Other,
    }
}

/// Codex's own words for a copy's turn that ended with no answer.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(crate) struct CopyTurnFailure(String);

impl CopyTurnFailure {
    /// The words of Codex's `error` for the turn with any credential they quote masked, else the
    /// copy's own.
    pub(crate) fn of(error: Option<&Value>) -> Self {
        let words = error
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .filter(|words| !words.trim().is_empty());
        Self(words.map_or_else(|| NO_ANSWER_DETAIL.to_owned(), scrub_credentials))
    }
}
