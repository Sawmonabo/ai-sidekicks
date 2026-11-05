//! The waiting messages' part of a run's end write: how each message the person's stop of the
//! service or an interrupt's return to the draft takes back ends, how every waiting message of a
//! run ends not delivered, and the returned messages' words put back into the session's draft.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
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

/// The reason a waiting message whose delivery failed reads not delivered.
pub(crate) const FAILED_DELIVERY_REASON: QueueItemNotDeliveredReason =
    QueueItemNotDeliveredReason::Failed {};

/// The outcome of a waiting message whose delivery failed: the one way a waiting message fails.
pub(crate) const FAILED_DELIVERY: QueueItemOutcome = QueueItemOutcome::NotDelivered {
    reason: FAILED_DELIVERY_REASON,
};

/// The ends of `items`, the messages waiting for a run the person's stop of the service settles
/// or an interrupt returns to the draft, in queue order, for one write: a lead message carrying
/// only words is canceled and its words go back into the draft, every other item ends not
/// delivered, kept whole. Fails when an item's event cannot be drafted.
pub fn stop_message_ends(
    items: &[QueueItemRecord],
    now: &WireInstant,
) -> Result<RunWriteCompanions, SessionEventDraftError> {
    ends_at_stop(items, returned_message_outcome, now)
}

/// The ends of `items`, the messages waiting for `run_id` as the person's stop of the service
/// settles it, as [`stop_message_ends`] builds them, except that each of `taken`, those the run's
/// provider took by its own record, is admitted into the run, so none goes back into the draft.
/// Fails when an item's event cannot be drafted.
pub fn stop_message_ends_with_taken(
    items: &[QueueItemRecord],
    run_id: RunId,
    taken: &[QueueItemId],
    now: &WireInstant,
) -> Result<RunWriteCompanions, SessionEventDraftError> {
    let outcome_of = |item: &QueueItemRecord| {
        if taken.contains(&item.id) {
            QueueItemOutcome::Admitted { run_id }
        } else {
            returned_message_outcome(item)
        }
    };
    ends_at_stop(items, outcome_of, now)
}

// The ends of `items` for one write, each to the outcome `outcome_of` answers, with the words of
// those canceled put back into the draft.
fn ends_at_stop(
    items: &[QueueItemRecord],
    outcome_of: impl Fn(&QueueItemRecord) -> QueueItemOutcome,
    now: &WireInstant,
) -> Result<RunWriteCompanions, SessionEventDraftError> {
    // A run's own opening ends with the rest, since the Stop ends the run it opens.
    let outcomes: Vec<QueueItemOutcome> = items.iter().map(outcome_of).collect();
    let returned: Vec<&QueueItemRecord> = items
        .iter()
        .zip(&outcomes)
        .filter(|(_, outcome)| **outcome == QueueItemOutcome::Canceled)
        .map(|(item, _)| item)
        .collect();
    let mut companions = outcome_companions(items.iter().zip(&outcomes), now)?;
    // The returned words go ahead of what the draft holds.
    companions
        .statements
        .extend(build_returned_words_draft(&returned, now));
    Ok(companions)
}

/// The ends of `items`, every one not delivered, its delivery failed, for the write that ends
/// their run or for a write of their own. Fails when an item's event cannot be drafted.
pub(crate) fn not_delivered_ends(
    items: &[QueueItemRecord],
    now: &WireInstant,
) -> Result<RunWriteCompanions, SessionEventDraftError> {
    let failed = FAILED_DELIVERY;
    outcome_companions(items.iter().map(|item| (item, &failed)), now)
}

/// The row move of each item of `outcomes` to the outcome beside it, with its event, for one
/// write, each event ahead of the run's own. Fails when an item's event cannot be drafted.
pub(crate) fn outcome_companions<'a>(
    outcomes: impl IntoIterator<Item = (&'a QueueItemRecord, &'a QueueItemOutcome)>,
    now: &WireInstant,
) -> Result<RunWriteCompanions, SessionEventDraftError> {
    let mut companions = RunWriteCompanions::default();
    for (item, outcome) in outcomes {
        let (draft, statement) = outcome_draft_of(item, outcome, now)?;
        companions.statements.push(statement);
        companions.preceding_events.push(draft);
    }
    Ok(companions)
}

// The draft write that puts the words of `items`, the lead messages one session's caller returns,
// back ahead of the session's held draft, one line per message in queue order; `None` when
// `items` carry no words.
fn build_returned_words_draft(
    items: &[&QueueItemRecord],
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

// How a returned `item` ends: a lead message carrying only words is canceled, its words going
// back into the draft; anything else ends not delivered, since a helper's box keeps no draft, a
// review or a plan message is no words the person typed, and the draft holds no message's extras.
fn returned_message_outcome(item: &QueueItemRecord) -> QueueItemOutcome {
    match &item.body {
        QueueItemBody::Message(message) if is_lead_message(item) && carries_only_words(message) => {
            QueueItemOutcome::Canceled
        }
        QueueItemBody::Message(_)
        | QueueItemBody::Review { .. }
        | QueueItemBody::PlanMessage { .. } => FAILED_DELIVERY,
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
