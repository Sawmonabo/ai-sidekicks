//! The lead queue's order as its writes leave it.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

use super::test_items::{test_queue_item, words, write_item};
use super::{
    QueueItemBody, QueueItemExit, QueueItemReader, insert_queue_item_statement,
    leave_queued_statement,
};
use crate::questions::schema::schema_parts;

// Killed by the edit's place taken from the end of the queue rather than from the message it
// replaces, which reads the edit last.
#[tokio::test]
async fn an_edited_waiting_message_keeps_its_place_in_the_queue() {
    let database = TestDatabase::new(schema_parts());
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let message =
        |text: &str| test_queue_item(session_id, run_id, QueueItemBody::Message(words(text)));
    let first = write_item(&writer, &message("A")).await;
    let edited = write_item(&writer, &message("B")).await;
    let last = write_item(&writer, &message("C")).await;

    let mut edit = message("B, edited");
    edit.replaces_queue_item_id = Some(edited);
    writer
        .write(vec![
            insert_queue_item_statement(&edit),
            leave_queued_statement(&edited, &QueueItemExit::Superseded, &WireInstant::now()),
        ])
        .await
        .expect("the edit writes");

    let order: Vec<_> = QueueItemReader::new(&database.reader())
        .list(&session_id, None, None)
        .expect("the queue reads")
        .into_iter()
        .map(|item| item.id)
        .collect();
    assert_eq!(order, [first, edit.id, last]);
}
