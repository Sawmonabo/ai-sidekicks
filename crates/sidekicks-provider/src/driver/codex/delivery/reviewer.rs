//! Codex's own reviewer at Reviewed: a `guardianWarning` waits for the next review on its thread.
//! A warning about an approval or a block is dropped, a block's words being on its action's row,
//! and one about a review that fell back to the person is flagged on the reviewed tool call; the
//! warning Codex sends as it stops a turn whose reviews blocked too often, which no review follows,
//! is flagged on that turn at its end, as a required review is, in Codex's app's words; a helper's
//! are about its `subagent.started` row, since its turns write no start of their own. A review
//! that blocked an action goes to the approval service with the review as the event Codex takes
//! back, built as Codex's own app builds it, each review once.

mod assessment;
#[cfg(test)]
mod tests;

use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::session::controls::events::{
    ApprovalReviewerFlaggedPayload, ModerationReviewSignal,
};
use sidekicks_contracts::wire::text::{ComposedText, FreeFormText};

use crate::driver::codex::delivery::memory::CodexDeliveryMemory;
use crate::driver::codex::delivery::notices::provider_words;
use crate::driver::codex::delivery::reviewer::assessment::{
    GuardianAssessmentAction, GuardianAssessmentEvent, GuardianAssessmentStatus,
    ReviewCompletedParams,
};
use crate::driver::codex::delivery::rows::CodexRowRun;
use crate::port::reviewer_denial::ProviderReviewerDenial;
use crate::record_readers::read_non_empty_string;
use crate::run::delivery::UnstampedRow;

/// The sentence Codex's own app writes for a required review, which carries no words of its own.
const CODEX_REVIEW_REQUIRED_SENTENCE: &str =
    "This request requires additional safety checks, some tool calls might take extra time";

/// The frame that ends a review.
const CODEX_REVIEW_COMPLETED_METHOD: &str = "item/autoApprovalReview/completed";

/// A flag the reviewer writes on `run` about the event `about_event_id`; with no such event, which
/// was never written, it is reported rather than written.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CodexReviewFlag {
    /// The run it is written on.
    pub(crate) run: CodexRowRun,
    /// The event it is about.
    pub(crate) about_event_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// Which signal it carries.
    pub(crate) signal: ModerationReviewSignal,
    /// The words the row shows.
    pub(crate) text: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    /// The frame it came from.
    pub(crate) method: &'static str,
    /// The turn the frame named.
    pub(crate) turn_id: Option<String>,
}

impl CodexReviewFlag {
    /// The flag's row, or `None` when the event it is about was never written.
    pub(crate) fn row(&self) -> Option<UnstampedRow> {
        let event_id = ComposedText::from(self.about_event_id.clone()?);
        Some(UnstampedRow::ApprovalReviewerFlagged(
            ApprovalReviewerFlaggedPayload {
                session_id: self.run.session_id,
                run_id: self.run.run_id,
                agent_id: self.run.agent_id,
                event_id,
                signal: self.signal,
                text: self.text.clone(),
            },
        ))
    }
}

/// What a review's end leaves to write: the flag on the reviewed call, and the block handed to
/// the approval service, or why the block's record could not be read.
#[derive(Debug, Default)]
pub(crate) struct CodexReviewCompletion {
    /// The flag.
    pub(crate) flag: Option<CodexReviewFlag>,
    /// The block.
    pub(crate) denial: Option<Result<ProviderReviewerDenial, serde_json::Error>>,
}

/// Holds a reviewer warning for the next review on its thread.
pub(crate) fn hold_guardian_warning(memory: &mut CodexDeliveryMemory, params: &Map<String, Value>) {
    if let Some((thread_id, message)) =
        read_non_empty_string(params, "threadId").zip(read_non_empty_string(params, "message"))
    {
        memory
            .guardian_warning_by_thread_id
            .insert(thread_id.to_owned(), message.to_owned());
    }
}

/// Pairs a review's end with the warning waiting on its thread, flagging the reviewed tool call
/// when the review neither approved nor blocked it, and reads a block for the approval service. The
/// block goes on the run the reviewed item's rows carry, which for a command outlives its turn,
/// else on `frame_run`, the frame's own run; with neither, the warning is spent and nothing is
/// written. A review already handled is dropped.
pub(crate) fn complete_codex_review(
    memory: &mut CodexDeliveryMemory,
    params: &Map<String, Value>,
    frame_run: Option<&CodexRowRun>,
) -> CodexReviewCompletion {
    let warning = read_non_empty_string(params, "threadId")
        .and_then(|thread_id| memory.guardian_warning_by_thread_id.remove(thread_id));
    let target_item_id = read_non_empty_string(params, "targetItemId");
    let item_run = target_item_id.and_then(|item_id| memory.tool_row_run_by_item_id.get(item_id));
    let Some(run) = item_run.or(frame_run).cloned() else {
        return CodexReviewCompletion::default();
    };
    let review = params.get("review").and_then(Value::as_object);
    let status = review
        .and_then(|review| review.get("status"))
        .and_then(Value::as_str)
        .and_then(GuardianAssessmentStatus::read_wire);
    let flag = warning
        .and_then(|warning| provider_words(&warning))
        .filter(|_| status.is_some_and(|status| !status.is_settled_by_review()))
        .map(|text| CodexReviewFlag {
            about_event_id: target_item_id
                .and_then(|item_id| memory.tool_row_event_id_by_item_id.get(item_id))
                .cloned(),
            run: run.clone(),
            signal: ModerationReviewSignal::ReviewWarning,
            text,
            method: CODEX_REVIEW_COMPLETED_METHOD,
            turn_id: read_non_empty_string(params, "turnId").map(str::to_owned),
        });
    let is_block = status.is_some_and(GuardianAssessmentStatus::is_block);
    let is_new = read_non_empty_string(params, "reviewId")
        .is_some_and(|review_id| memory.remember_review(review_id));
    let denial = (is_block && is_new).then(|| read_review_block(params, &run));
    CodexReviewCompletion { flag, denial }
}

/// Flags the turn `turn_id` on `run` as needing a stricter review, in Codex's app's words, about
/// the event `about_event_id` that opened the turn's work.
pub(crate) fn require_codex_review(
    about_event_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    turn_id: &str,
    run: CodexRowRun,
) -> CodexReviewFlag {
    CodexReviewFlag {
        run,
        about_event_id,
        signal: ModerationReviewSignal::ReviewRequired,
        text: provider_words(CODEX_REVIEW_REQUIRED_SENTENCE)
            .expect("the sentence is non-blank and within the cap"),
        method: "autoApprovalReview/strictReviewRequired",
        turn_id: Some(turn_id.to_owned()),
    }
}

/// Spends the warning waiting on a turn's thread as the turn ends, flagging it about the event
/// `about_event_id` that opened the turn's work when Codex itself stopped the turn on
/// `stopped_run`: the warning its reviewer sends as it stops a turn that blocked too often, which
/// no review follows.
pub(crate) fn end_codex_review_turn(
    memory: &mut CodexDeliveryMemory,
    thread_id: &str,
    about_event_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    turn_id: Option<&str>,
    stopped_run: Option<CodexRowRun>,
) -> Option<CodexReviewFlag> {
    let warning = memory.guardian_warning_by_thread_id.remove(thread_id)?;
    Some(CodexReviewFlag {
        run: stopped_run?,
        about_event_id,
        signal: ModerationReviewSignal::ReviewWarning,
        text: provider_words(&warning)?,
        method: "turn/completed",
        turn_id: turn_id.map(str::to_owned),
    })
}

// A block as the approval service takes it: the reviewed item, the reviewer's reason, whether the
// person may allow it once (a denial, never a timeout), and the review as the event Codex takes
// back with its thread beside it. A network access names no item and is a block of its own, its
// reason naming where it reached.
fn read_review_block(
    params: &Map<String, Value>,
    run: &CodexRowRun,
) -> Result<ProviderReviewerDenial, serde_json::Error> {
    let completed: ReviewCompletedParams = serde_json::from_value(Value::Object(params.clone()))?;
    let reason = match (&completed.target_item_id, &completed.action) {
        (None, GuardianAssessmentAction::NetworkAccess { target, host, .. }) => {
            let place = if target.is_empty() { host } else { target };
            Some(match &completed.review.rationale {
                Some(rationale) => format!("network access to {place} · {rationale}"),
                None => format!("network access to {place}"),
            })
        }
        _ => completed.review.rationale.clone(),
    };
    let is_overridable = completed.review.status == GuardianAssessmentStatus::Denied;
    let thread_id = completed.thread_id.clone();
    let tool_call_id = completed.target_item_id.clone();
    let event = GuardianAssessmentEvent::from(completed);
    let record = serde_json::json!({ "threadId": thread_id, "event": event });
    Ok(ProviderReviewerDenial {
        session_id: run.session_id,
        run_id: run.run_id,
        tool_call_id,
        reason,
        is_overridable,
        provider_denial: RawValue::from_string(record.to_string())?,
    })
}
