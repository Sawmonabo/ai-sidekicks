//! The one builder and writer of the queue items tests queue, in this crate's and other crates'
//! tests.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageText, QueueItemId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::writer::DatabaseWriter;

use crate::queue_store::{
    NewQueueItem, QueueItemBody, QueueMessageBody, insert_queue_item_statement,
};

/// A message carrying only `text`.
pub fn words(text: &str) -> QueueMessageBody {
    QueueMessageBody {
        content: MessageText::new(text.to_owned()).expect("a test message"),
        attachments: None,
        skills: None,
        skill_picks: None,
        answers_question_id: None,
        output_speed_for_turn: None,
        workspace_id: None,
    }
}

/// An item carrying `body` for `run_id` of `session_id`, under a fresh id and a fresh send key,
/// from no device and replacing none; a test sets any other field on it.
pub fn test_queue_item(session_id: SessionId, run_id: RunId, body: QueueItemBody) -> NewQueueItem {
    NewQueueItem {
        id: QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id"),
        session_id,
        body,
        target_run_id: run_id,
        device_id: None,
        client_idempotency_key: Some(
            ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client key"),
        ),
        replaces_queue_item_id: None,
        now: WireInstant::now(),
    }
}

/// Queues `item` through `writer`, after every one before it, and answers its id.
pub async fn write_item(writer: &DatabaseWriter, item: &NewQueueItem) -> QueueItemId {
    writer
        .write(vec![insert_queue_item_statement(item)])
        .await
        .expect("the test queues its item");
    item.id
}

/// Queues an item carrying `body` for `run_id` of `session_id` through `writer`, as
/// [`test_queue_item`] builds it, and answers its id.
pub async fn insert_item(
    writer: &DatabaseWriter,
    session_id: SessionId,
    run_id: RunId,
    body: QueueItemBody,
) -> QueueItemId {
    write_item(writer, &test_queue_item(session_id, run_id, body)).await
}
