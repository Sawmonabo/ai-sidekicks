//! The pending row a screen draws for a stored queue item.

use sidekicks_contracts::run::queue::{QueueItemSummary, QueueMessageSummary, QueueReviewSummary};

use crate::queue_store::{QueueItemBody, QueueItemRecord, RecordedQueueItemState};

/// The pending row a screen draws for `record`.
pub fn summary_of(record: QueueItemRecord) -> QueueItemSummary {
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
    match body {
        QueueItemBody::Message(message) => {
            let content = message.content;
            let attachments = message.attachments;
            QueueItemSummary::Message(match state {
                RecordedQueueItemState::Queued => QueueMessageSummary::Queued {
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
                RecordedQueueItemState::Admitted => QueueMessageSummary::Admitted {
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
                RecordedQueueItemState::Superseded => QueueMessageSummary::Superseded {
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
                RecordedQueueItemState::Canceled => QueueMessageSummary::Canceled {
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
                RecordedQueueItemState::NotDelivered { reason } => {
                    QueueMessageSummary::NotDelivered {
                        id,
                        position,
                        content,
                        attachments,
                        child_handle,
                        is_sent_now,
                        created_at,
                        updated_at,
                        not_delivered_reason: reason,
                    }
                }
            })
        }
        // A review waits only on the lead's queue, which no child handle names.
        QueueItemBody::Review { target } => QueueItemSummary::Review(match state {
            RecordedQueueItemState::Queued => QueueReviewSummary::Queued {
                id,
                position,
                target,
                is_sent_now,
                created_at,
                updated_at,
                not_delivered_reason: None,
            },
            RecordedQueueItemState::Admitted => QueueReviewSummary::Admitted {
                id,
                position,
                target,
                is_sent_now,
                created_at,
                updated_at,
                not_delivered_reason: None,
            },
            RecordedQueueItemState::Superseded => QueueReviewSummary::Superseded {
                id,
                position,
                target,
                is_sent_now,
                created_at,
                updated_at,
                not_delivered_reason: None,
            },
            RecordedQueueItemState::Canceled => QueueReviewSummary::Canceled {
                id,
                position,
                target,
                is_sent_now,
                created_at,
                updated_at,
                not_delivered_reason: None,
            },
            RecordedQueueItemState::NotDelivered { reason } => QueueReviewSummary::NotDelivered {
                id,
                position,
                target,
                is_sent_now,
                created_at,
                updated_at,
                not_delivered_reason: reason,
            },
        }),
    }
}
