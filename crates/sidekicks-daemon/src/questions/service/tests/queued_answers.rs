//! The queued answers of a question its agent does not wait for, and the question rows a rebuild
//! writes from the log.

use std::sync::Arc;

use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use serde_json::json;
use sidekicks_contracts::question::QuestionAskedState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{Fixture, choice_page};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::events::session::read::DamagedFromSequenceReader;
use crate::provider::port::question::{ProviderQuestionWithdrawal, WaitingQuestionOpening};
use crate::questions::projection::QuestionsProjection;
use crate::questions::service::HeldRequestAnswerer;
use crate::recovery::database_file::damage::DatabaseDamageWatch;
use crate::recovery::projection_rebuild::{
    PROJECTION_REBUILD_STATEMENT_CAPACITY, ProjectionRebuildRequest, ProjectionRebuildService,
};
use crate::session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};

fn table_rows(connection: &Connection, sql: &str) -> Vec<Vec<SqlValue>> {
    let mut statement = connection.prepare(sql).expect("the read prepares");
    let columns = statement.column_count();
    statement
        .query_map([], |row| {
            (0..columns)
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("the rows read")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("every row reads")
}

fn question_rows(connection: &Connection) -> (Vec<Vec<SqlValue>>, Vec<Vec<SqlValue>>) {
    (
        table_rows(connection, "SELECT * FROM questions ORDER BY id"),
        table_rows(
            connection,
            "SELECT * FROM question_answer_items ORDER BY queue_item_id",
        ),
    )
}

// A question its agent does not wait for stays open while a send naming it is queued, stays open
// when that item is withdrawn, and is answered when the agent takes a queued answer; of two
// devices' answers the first taken wins and unpairs the other, and an item that answers nothing
// answers nothing. The rows a rebuild writes from the log, with a held question answered, one
// withdrawn, one withdrawn while it waited for its run and one opened from that wait and answered
// beside them, are the rows the live writes wrote. Killed by answering at send time, by answering
// on another item's admission, and by a fold arm that drops an event.
#[tokio::test]
async fn queued_answers_settle_a_question_its_agent_does_not_wait_for_and_rebuild_as_written() {
    let fixture = Fixture::new().await;
    let record_waiting = |request_id: &'static str| {
        fixture.questions.record_question(
            fixture.question(request_id, json!([choice_page()]), true),
            HeldRequestAnswerer::Driver,
            QuestionAskedState::WaitingForRun,
        )
    };
    let withdrawn_waiting = record_waiting("request-4")
        .await
        .expect("the question is recorded waiting for its run");
    fixture
        .questions
        .withdraw_question(ProviderQuestionWithdrawal {
            session_id: fixture.session_id,
            request_id: "request-4".to_owned(),
        })
        .await
        .expect("the withdrawal is taken");
    let opened = record_waiting("request-5")
        .await
        .expect("the question is recorded waiting for its run");
    assert_eq!(
        fixture
            .questions
            .open_waiting_question(fixture.session_id, "request-5")
            .await
            .expect("the run reads running"),
        WaitingQuestionOpening::Opened
    );
    fixture
        .answer(opened, json!([{ "kind": "picked", "labels": ["Beta"] }]))
        .await
        .expect("the opened question is answered");
    let withdrawn = fixture.ask("request-1", json!([choice_page()]), true).await;
    fixture
        .questions
        .withdraw_question(ProviderQuestionWithdrawal {
            session_id: fixture.session_id,
            request_id: "request-1".to_owned(),
        })
        .await
        .expect("the withdrawal is taken");
    let held = fixture.ask("request-2", json!([choice_page()]), true).await;
    fixture
        .answer(held, json!([{ "kind": "picked", "labels": ["Alpha"] }]))
        .await
        .expect("the held question is answered");
    let unwaited = fixture
        .ask("request-3", json!([choice_page()]), false)
        .await;
    let [withdrawn_item, unrelated_item, first_item, second_item] =
        [(); 4].map(|()| mint_uuid_v7().to_string());
    let send = |queue_item_id: String| {
        json!({
            "sessionId": fixture.session_id,
            "queueItemId": queue_item_id,
            "runId": fixture.run_id,
            "actor": "device-1",
            "deviceId": "device-1",
            "message": "Which one?\nAlpha",
            "answersQuestionId": unwaited,
        })
    };
    let queue_event = |state: &str, queue_item_id: String| {
        let mut payload = json!({
            "sessionId": fixture.session_id,
            "queueItemId": queue_item_id,
            "state": state,
        });
        if state == "admitted" {
            payload["runId"] = json!(fixture.run_id);
        }
        payload
    };

    fixture
        .append("user.message.sent", send(withdrawn_item.clone()))
        .await;
    let after_send = fixture.state(unwaited);
    fixture
        .append(
            "agent.queueItem.canceled",
            queue_event("canceled", withdrawn_item),
        )
        .await;
    fixture
        .append(
            "agent.queueItem.admitted",
            queue_event("admitted", unrelated_item),
        )
        .await;
    let after_withdrawal = fixture.state(unwaited);
    fixture
        .append("user.message.sent", send(first_item.clone()))
        .await;
    fixture.append("user.message.sent", send(second_item)).await;
    fixture
        .append(
            "agent.queueItem.admitted",
            queue_event("admitted", first_item),
        )
        .await;

    assert_eq!(after_send, "open");
    assert_eq!(after_withdrawal, "open");
    assert_eq!(fixture.state(unwaited), "answered");
    assert_eq!(fixture.state(withdrawn), "canceled");
    assert_eq!(fixture.state(withdrawn_waiting), "canceled");
    assert_eq!(fixture.state(opened), "answered");
    let reader = fixture.database.reader();
    let live = question_rows(&reader);
    assert!(
        live.1.is_empty(),
        "the first taken answer unpairs the other"
    );

    let pool = Arc::new(DatabaseReadPool::new(
        fixture.database.path(),
        PROJECTION_REBUILD_STATEMENT_CAPACITY + SESSION_SERVICE_STATEMENT_CAPACITY,
    ));
    let reads_whole: Arc<DamagedFromSequenceReader> =
        Arc::new(|_session_id: &SessionId| -> Option<i64> { None });
    ProjectionRebuildService::new(
        Arc::clone(&pool),
        Arc::clone(&fixture.writer),
        Arc::new(SessionService::new(pool, reads_whole)),
        Arc::new(DatabaseDamageWatch::new()),
        vec![Box::new(QuestionsProjection)],
    )
    .rebuild(
        ProjectionRebuildRequest {
            session_id: fixture.session_id,
            is_forced: true,
            before_sequence: None,
            stop: None,
        },
        None,
    )
    .await
    .expect("the session's questions are rebuilt");

    assert_eq!(question_rows(&reader), live);
}
