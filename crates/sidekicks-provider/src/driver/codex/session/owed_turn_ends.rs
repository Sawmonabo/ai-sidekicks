//! The ends a resumed conversation still owes its session: each turn the session's record holds
//! live or ending that the resume lists as over sent its `turn/completed` while the daemon was not
//! connected, and Codex sends none again, so its listed end is routed as Codex's own.

use serde::Deserialize;
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
    #[derive(Deserialize)]
    struct ListedTurnStatus {
        status: Option<String>,
    }
    read_codex_object::<ListedTurnStatus>(turn.get())
        .and_then(|listed| listed.status)
        .and_then(|status| CodexTurnStatus::read(&status))
        == Some(CodexTurnStatus::InProgress)
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
