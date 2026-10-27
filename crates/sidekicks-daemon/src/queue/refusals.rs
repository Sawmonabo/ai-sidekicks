//! The run queue's refusals of a send or a change: an item it does not hold, one no longer waiting
//! or not given back by its provider, and a skill pick its provider does not list.

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::queue::{
    AgentQueueItemChangeRefusedDetails, AgentQueueItemChangeRefusedReason, QueueItemId,
    QueuedSkillPick,
};
use sidekicks_contracts::skill::{SkillPathRefusedDetails, SkillPathRefusedReason};
use sidekicks_contracts::wire::text::BoundedText;

use sidekicks_ipc::domain_error::DomainError;
use sidekicks_session::queue_store::{QueueItemRecord, RecordedQueueItemState};

/// Why a withdraw ahead of a change left a message with its provider: taken by the agent, or not
/// given back and now reading not delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UnreturnedReason {
    /// The agent took the message.
    Taken,
    /// The provider did not give the message back, which now reads not delivered.
    NotDelivered,
}

/// An `agent.queueItem.changeRefused` refusal for `reason`, worded by `message`.
pub(crate) fn change_refused(
    reason: AgentQueueItemChangeRefusedReason,
    message: &str,
) -> DomainError {
    DomainError::new(message, RefusalCode::AgentQueueItemChangeRefused)
        .with_detail(AgentQueueItemChangeRefusedDetails { reason })
}

/// The refusal of a change to `item`, no longer waiting, by how it left the queue.
pub(crate) fn left_queue_refusal(item: &QueueItemRecord) -> DomainError {
    match item.state {
        RecordedQueueItemState::Admitted => unreturned_refusal(item.id, UnreturnedReason::Taken),
        RecordedQueueItemState::NotDelivered { .. } => {
            unreturned_refusal(item.id, UnreturnedReason::NotDelivered)
        }
        RecordedQueueItemState::Queued
        | RecordedQueueItemState::Superseded
        | RecordedQueueItemState::Canceled => change_refused(
            AgentQueueItemChangeRefusedReason::AlreadyTaken,
            &format!("Queue item {} has left the queue", item.id),
        ),
    }
}

/// The refusal of a change to an item its provider did not give back, or the agent took.
pub(crate) fn unreturned_refusal(
    queue_item_id: QueueItemId,
    reason: UnreturnedReason,
) -> DomainError {
    match reason {
        UnreturnedReason::Taken => change_refused(
            AgentQueueItemChangeRefusedReason::AlreadyTaken,
            &format!("Queue item {queue_item_id} has been taken by the agent"),
        ),
        UnreturnedReason::NotDelivered => change_refused(
            AgentQueueItemChangeRefusedReason::NotDelivered,
            &format!(
                "Queue item {queue_item_id} was not given back by the provider and reads not \
                 delivered"
            ),
        ),
    }
}

/// The `skill.pathRefused` refusal of a skill pick the session's provider does not list.
pub(crate) fn skill_not_listed(pick: &QueuedSkillPick) -> DomainError {
    let folder_path = pick.folder_path.as_str();
    let path = BoundedText::new(folder_path.to_owned())
        .expect("a skill folder path is within the cap of the refusal's path");
    DomainError::new(
        format!(
            "The skill {} in {folder_path} is not one the session's provider lists",
            pick.name.as_str()
        ),
        RefusalCode::SkillPathRefused,
    )
    .with_detail(SkillPathRefusedDetails {
        path,
        reason: SkillPathRefusedReason::NotListed,
    })
}

/// The refusal of a change to an item the queue does not hold.
pub(crate) fn queue_item_not_found(queue_item_id: QueueItemId) -> DomainError {
    DomainError::new(
        format!("Queue item {queue_item_id} is not in this queue"),
        RefusalCode::AgentQueueItemNotFound,
    )
    .with_detail(json!({ "queueItemId": queue_item_id }))
}
