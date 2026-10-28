//! The question rows a rebuild writes from the log against the rows the live writes wrote.

use std::sync::Arc;

use rusqlite::Connection;
use rusqlite::types::Value;
use sidekicks_session::questions::projection::QuestionsProjection;
use sidekicks_session::questions::service::test_fixture::{Fixture, write_queued_answers};

use super::{rebuild_whole, table_rows};

fn question_rows(connection: &Connection) -> (Vec<Vec<Value>>, Vec<Vec<Value>>) {
    (
        table_rows(connection, "SELECT * FROM questions ORDER BY id"),
        table_rows(
            connection,
            "SELECT * FROM question_answer_items ORDER BY queue_item_id",
        ),
    )
}

// The rows a rebuild writes from the log, with a held question answered, one withdrawn, one
// withdrawn while it waited for its run, one opened from that wait and answered, and one answered
// by a queued answer its agent took, are the rows the live writes wrote. Killed by a fold arm that
// drops an event.
#[tokio::test]
async fn a_rebuild_writes_the_question_rows_the_live_writes_wrote() {
    let fixture = Fixture::new().await;
    write_queued_answers(&fixture).await;
    let reader = fixture.database.reader();
    let live = question_rows(&reader);

    rebuild_whole(
        &fixture.database,
        Arc::clone(&fixture.writer),
        Box::new(QuestionsProjection),
        fixture.session_id,
    )
    .await;

    assert_eq!(question_rows(&reader), live);
}
