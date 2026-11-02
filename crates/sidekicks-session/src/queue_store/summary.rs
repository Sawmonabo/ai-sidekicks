//! The pending row a screen draws for a stored queue item.

use sidekicks_contracts::run::queue::{
    QueueItemSummary, QueueMessageSummary, QueuePlanMessageSummary, QueueReviewSummary,
};

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
        // A plan message is the daemon's, drawn by its plan and never as the person's words; it
        // waits only on the lead's queue.
        QueueItemBody::PlanMessage { plan_message, .. } => {
            QueueItemSummary::PlanMessage(match state {
                RecordedQueueItemState::Queued => QueuePlanMessageSummary::Queued {
                    id,
                    position,
                    plan_message,
                    is_sent_now,
                    created_at,
                    updated_at,
                    not_delivered_reason: None,
                },
                RecordedQueueItemState::Admitted => QueuePlanMessageSummary::Admitted {
                    id,
                    position,
                    plan_message,
                    is_sent_now,
                    created_at,
                    updated_at,
                    not_delivered_reason: None,
                },
                RecordedQueueItemState::Superseded => QueuePlanMessageSummary::Superseded {
                    id,
                    position,
                    plan_message,
                    is_sent_now,
                    created_at,
                    updated_at,
                    not_delivered_reason: None,
                },
                RecordedQueueItemState::Canceled => QueuePlanMessageSummary::Canceled {
                    id,
                    position,
                    plan_message,
                    is_sent_now,
                    created_at,
                    updated_at,
                    not_delivered_reason: None,
                },
                RecordedQueueItemState::NotDelivered { reason } => {
                    QueuePlanMessageSummary::NotDelivered {
                        id,
                        position,
                        plan_message,
                        is_sent_now,
                        created_at,
                        updated_at,
                        not_delivered_reason: reason,
                    }
                }
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::plan::PlanId;
    use sidekicks_contracts::run::queue::{
        PlanMessage, PlanMessageKind, QueueItemId, QueueItemNotDeliveredReason,
    };
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::summary_of;
    use crate::queue_store::{QueueItemBody, QueueItemRecord, RecordedQueueItemState};

    // A plan message's pending row reads `kind: planMessage` with its plan id and kind in each
    // state, never the person's words. Killed by summarizing it as the person's message, and by
    // a summary that loses its kind.
    #[rstest]
    #[case::queued(RecordedQueueItemState::Queued, "queued", PlanMessageKind::Build)]
    #[case::not_delivered(
        RecordedQueueItemState::NotDelivered { reason: QueueItemNotDeliveredReason::Failed {} },
        "notDelivered",
        PlanMessageKind::Seed
    )]
    #[case::admitted(RecordedQueueItemState::Admitted, "admitted", PlanMessageKind::Build)]
    #[case::superseded(
        RecordedQueueItemState::Superseded,
        "superseded",
        PlanMessageKind::Seed
    )]
    #[case::canceled(RecordedQueueItemState::Canceled, "canceled", PlanMessageKind::Build)]
    fn a_plan_message_s_pending_row_reads_its_plan_in_each_state(
        #[case] state: RecordedQueueItemState,
        #[case] state_word: &str,
        #[case] kind: PlanMessageKind,
    ) {
        let plan_id = PlanId::try_from(mint_uuid_v7()).expect("a minted UUID is a plan id");
        let now = WireInstant::now();
        let record = QueueItemRecord {
            id: QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is an id"),
            session_id: SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is an id"),
            state,
            body: QueueItemBody::PlanMessage {
                plan_message: PlanMessage {
                    plan_id,
                    kind,
                    source_session_id: None,
                },
                text: FreeFormText::new("Implement the plan.".to_owned()).expect("a message"),
            },
            target_run_id: None,
            child_handle: None,
            position: SafeInt::ZERO,
            client_idempotency_key: None,
            created_at: now.clone(),
            updated_at: now,
            sent_now_id: None,
        };

        let row = serde_json::to_value(summary_of(record)).expect("a summary serializes");

        assert_eq!(row["kind"], json!("planMessage"));
        assert_eq!(row["state"], json!(state_word));
        assert_eq!(row["planMessage"]["planId"], json!(plan_id));
        assert_eq!(row["planMessage"]["kind"], json!(kind));
        assert!(row.get("content").is_none(), "{row}");
    }
}
