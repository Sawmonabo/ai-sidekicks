//! The pending row a screen draws for a stored queue item.

use sidekicks_contracts::run::queue::QueueItemSummary;

use crate::queue::store::{QueueItemRecord, RecordedQueueItemState};

/// The pending row a screen draws for `record`.
pub(crate) fn summary_of(record: QueueItemRecord) -> QueueItemSummary {
    let QueueItemRecord {
        id,
        state,
        body,
        child_handle,
        position,
        sent_now_id,
        created_at,
        updated_at,
        ..
    } = record;
    let is_sent_now = sent_now_id.is_some();
    let content = body.content;
    let attachments = body.attachments;
    match state {
        RecordedQueueItemState::Queued => QueueItemSummary::Queued {
            id,
            position,
            content,
            attachments,
            child_handle,
            is_sent_now,
            created_at,
            updated_at,
            not_delivered_reason: None,
        },
        RecordedQueueItemState::Admitted => QueueItemSummary::Admitted {
            id,
            position,
            content,
            attachments,
            child_handle,
            is_sent_now,
            created_at,
            updated_at,
            not_delivered_reason: None,
        },
        RecordedQueueItemState::Superseded => QueueItemSummary::Superseded {
            id,
            position,
            content,
            attachments,
            child_handle,
            is_sent_now,
            created_at,
            updated_at,
            not_delivered_reason: None,
        },
        RecordedQueueItemState::Canceled => QueueItemSummary::Canceled {
            id,
            position,
            content,
            attachments,
            child_handle,
            is_sent_now,
            created_at,
            updated_at,
            not_delivered_reason: None,
        },
        RecordedQueueItemState::NotDelivered { reason } => QueueItemSummary::NotDelivered {
            id,
            position,
            content,
            attachments,
            child_handle,
            is_sent_now,
            created_at,
            updated_at,
            not_delivered_reason: reason,
        },
    }
}
