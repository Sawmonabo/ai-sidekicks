//! The waiting messages' part of a run's end write: how each message waiting for a run the person's
//! stop of the service settles ends, how every waiting message of a run ends not delivered, and the
//! returned messages' words put back into the session's draft.

use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_session::draft_store::restored_words_statement;
use sidekicks_session::queue_store::{
    QueueItemBody, QueueItemOutcome, QueueItemRecord, QueueMessageBody,
};
use sidekicks_session::run::state_change::RunWriteCompanions;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::SessionEventDraftError;

use crate::delivery::is_lead_message;
use crate::recorder::outcome_draft_of;

/// The outcome of a waiting message whose delivery failed: the one way a waiting message fails.
pub(crate) const FAILED_DELIVERY: QueueItemOutcome = QueueItemOutcome::NotDelivered {
    reason: QueueItemNotDeliveredReason::Failed {},
};

/// The ends of `items`, the messages waiting for a run the person's stop of the service settles,
/// in queue order, for that run's write: a lead message carrying only words is canceled and its
/// words go back into the draft ahead of what it holds, and every other item ends not delivered.
/// A run's own opening ends with the rest, since the Stop ends the run it opens. Fails when an
/// item's event cannot be drafted.
pub fn stop_message_ends(
    items: &[QueueItemRecord],
    now: &WireInstant,
) -> Result<RunWriteCompanions, SessionEventDraftError> {
    let mut companions = RunWriteCompanions::default();
    let mut returned = Vec::new();
    for item in items {
        let outcome = if is_returned_at_stop(item) {
            returned.push(item.clone());
            QueueItemOutcome::Canceled
        } else {
            FAILED_DELIVERY
        };
        add_outcome(&mut companions, item, &outcome, now)?;
    }
    companions
        .statements
        .extend(build_returned_words_draft(&returned, now));
    Ok(companions)
}

/// The ends of `items`, every one not delivered, its delivery failed, for the write that ends
/// their run or for a write of their own. Fails when an item's event cannot be drafted.
pub fn not_delivered_ends(
    items: &[QueueItemRecord],
    now: &WireInstant,
) -> Result<RunWriteCompanions, SessionEventDraftError> {
    let mut companions = RunWriteCompanions::default();
    for item in items {
        add_outcome(&mut companions, item, &FAILED_DELIVERY, now)?;
    }
    Ok(companions)
}

/// The draft write that puts the words of `items`, the lead messages one session's caller returns,
/// back ahead of the session's held draft, one line per message in queue order; `None` when
/// `items` carry no words.
pub fn build_returned_words_draft(
    items: &[QueueItemRecord],
    now: &WireInstant,
) -> Option<WriteStatement> {
    let session_id = items.first()?.session_id;
    let words: Vec<&str> = items
        .iter()
        .filter_map(|item| item.body.as_message())
        .map(|message| message.content.as_str())
        .collect();
    if words.is_empty() {
        return None;
    }
    Some(restored_words_statement(
        &session_id,
        &words.join("\n"),
        now,
    ))
}

// Whether the Stop puts `item` back into the draft: a lead message carrying only words. A helper's
// box keeps no draft, and a review or a plan message is no words the person typed.
fn is_returned_at_stop(item: &QueueItemRecord) -> bool {
    match &item.body {
        QueueItemBody::Message(message) => is_lead_message(item) && carries_only_words(message),
        QueueItemBody::Review { .. } | QueueItemBody::PlanMessage { .. } => false,
    }
}

// Whether `message` carries nothing the draft cannot hold. The question it answers goes with the
// Stop, so it keeps no message from the draft.
fn carries_only_words(message: &QueueMessageBody) -> bool {
    let QueueMessageBody {
        content: _,
        attachments,
        skills,
        answers_question_id: _,
        output_speed_for_turn,
        workspace_id,
    } = message;
    attachments
        .as_ref()
        .is_none_or(|attachments| attachments.0.is_empty())
        && skills.as_ref().is_none_or(Vec::is_empty)
        && output_speed_for_turn.is_none()
        && workspace_id.is_none()
}

// Adds the row move of `item` to `outcome` to `companions`, and its event ahead of the run's own.
fn add_outcome(
    companions: &mut RunWriteCompanions,
    item: &QueueItemRecord,
    outcome: &QueueItemOutcome,
    now: &WireInstant,
) -> Result<(), SessionEventDraftError> {
    let (draft, statement) = outcome_draft_of(item, outcome, now)?;
    companions.statements.push(statement);
    companions.preceding_events.push(draft);
    Ok(())
}
