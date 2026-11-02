//! The ends a resumed conversation still owes its session: each turn the session's record holds
//! live or ending that the resume lists as over sent its `turn/completed` while the daemon was not
//! connected, and Codex sends none again, so its listed end is routed as Codex's own. A listed
//! turn is read here for how it stands.

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::value::RawValue;

use crate::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::driver::codex::event_normalizer::CODEX_TURN_COMPLETED_METHOD;
use crate::driver::codex::notification_routing::{CodexRoutedFrames, CodexSessionRouting};
use crate::driver::codex::session::history::CodexListedTurn;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::codex::turn_evidence::CodexTurnStatus;

/// Routes the `turn/completed` of each turn in `listed_turns` that `record` holds live or ending
/// and that the listing shows over, through `routing` to `delivery`, in listing order. Answers
/// the frames the ends produced.
pub(crate) async fn end_owed_codex_turns(
    routing: &mut CodexSessionRouting,
    delivery: &CodexFrameDelivery,
    record: &mut CodexSessionRecord,
    listed_turns: &[CodexListedTurn],
) -> CodexRoutedFrames {
    let mut routed = CodexRoutedFrames::default();
    for listed in listed_turns {
        let is_owed = record.active_turn_run(&listed.id).is_some()
            || record.ending_turn_ids().contains(&listed.id.as_str());
        if !is_owed || is_codex_turn_in_progress(&listed.turn) {
            continue;
        }
        let Some(params) = compose_turn_completed_params(&record.thread_id, &listed.turn) else {
            continue;
        };
        let ended = routing
            .route_notification(
                delivery,
                record,
                CODEX_TURN_COMPLETED_METHOD.to_owned(),
                params,
            )
            .await;
        routed.extend(ended);
    }
    routed
}

/// Whether a turn as `thread/turns/list` lists it still runs.
pub(crate) fn is_codex_turn_in_progress(turn: &RawValue) -> bool {
    read_codex_listed_turn(turn).status == Some(CodexTurnStatus::InProgress)
}

/// How a turn as `thread/turns/list` lists it stands: its status, whether it carries the time it
/// ended, which only a turn something stopped or finished carries, and the first turn of its chain.
pub(super) struct CodexListedTurnState {
    /// Its status; `None` for a word Codex does not send or a turn that reads as no object.
    pub(super) status: Option<CodexTurnStatus>,
    /// Whether it carries `completedAt`: a turn a cold load marked interrupted carries none.
    pub(super) has_completed_at: bool,
    /// The first turn of the chain of work that led to it; `None` where Codex names none.
    pub(super) root_turn_id: Option<String>,
}

/// Reads the listed turn `turn` for how it stands.
pub(super) fn read_codex_listed_turn(turn: &RawValue) -> CodexListedTurnState {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ListedTurn {
        status: Option<String>,
        completed_at: Option<IgnoredAny>,
        root_turn_id: Option<String>,
    }
    let listed = read_codex_object::<ListedTurn>(turn.get());
    CodexListedTurnState {
        status: listed
            .as_ref()
            .and_then(|listed| listed.status.as_deref())
            .and_then(CodexTurnStatus::read),
        has_completed_at: listed
            .as_ref()
            .is_some_and(|listed| listed.completed_at.is_some()),
        root_turn_id: listed.and_then(|listed| listed.root_turn_id),
    }
}

// The params of the `turn/completed` Codex sent for a listed turn: the conversation and the turn.
fn compose_turn_completed_params(thread_id: &str, turn: &RawValue) -> Option<Box<RawValue>> {
    let thread_id = serde_json::to_string(thread_id).ok()?;
    RawValue::from_string(format!(
        r#"{{"threadId":{thread_id},"turn":{}}}"#,
        turn.get()
    ))
    .ok()
}
