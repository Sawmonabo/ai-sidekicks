//! The ends a resumed conversation still owes its session: each turn the session's record holds
//! live or ending that the resume lists as over sent its `turn/completed` while the daemon was not
//! connected, and Codex sends none again, so its listed end is routed as Codex's own, which the
//! delivery writes as the daemon's for a continuation held while its lead waits on the person; so
//! is the newest turn's end of each helper an adoption restored, the daemon's too for a held one.
//! A listed turn is read here for how it stands.

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

/// Routes the `turn/completed` of a restored helper's newest turn `newest`, listed over, through
/// `routing` to `delivery`, so the helper's child run, bound in `record`, ends as Codex ended it,
/// or, where the turn is marked held, has the turn's end written as the daemon's.
/// A turn still running or a helper with no bound child run routes nothing. Answers the frames the
/// end produced.
pub(crate) async fn end_owed_codex_helper_turn(
    routing: &mut CodexSessionRouting,
    delivery: &CodexFrameDelivery,
    record: &mut CodexSessionRecord,
    helper_thread_id: &str,
    newest: &CodexListedTurn,
) -> CodexRoutedFrames {
    let is_bound = record
        .delivery
        .child_run_by_thread_id
        .get(helper_thread_id)
        .is_some_and(|child| child.bound.is_some());
    if !is_bound || is_codex_turn_in_progress(&newest.turn) {
        return CodexRoutedFrames::default();
    }
    let Some(params) = compose_turn_completed_params(helper_thread_id, &newest.turn) else {
        return CodexRoutedFrames::default();
    };
    routing
        .route_notification(
            delivery,
            record,
            CODEX_TURN_COMPLETED_METHOD.to_owned(),
            params,
        )
        .await
}

/// Whether a turn as `thread/turns/list` lists it still runs.
pub(crate) fn is_codex_turn_in_progress(turn: &RawValue) -> bool {
    read_codex_listed_turn(turn).status == Some(CodexTurnStatus::InProgress)
}

/// How a turn as `thread/turns/list` lists it stands: its status, whether it carries the time it
/// ended, which only a turn something stopped or finished carries, and the first turn of its chain.
pub(crate) struct CodexListedTurnState {
    /// Its status; `None` for a word Codex does not send or a turn that reads as no object.
    pub(crate) status: Option<CodexTurnStatus>,
    /// Whether it carries `completedAt`: a turn a cold load marked interrupted carries none.
    pub(crate) has_completed_at: bool,
    /// The first turn of the chain of work that led to it; `None` where Codex names none.
    pub(super) root_turn_id: Option<String>,
}

/// Reads the listed turn `turn` for how it stands.
pub(crate) fn read_codex_listed_turn(turn: &RawValue) -> CodexListedTurnState {
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
