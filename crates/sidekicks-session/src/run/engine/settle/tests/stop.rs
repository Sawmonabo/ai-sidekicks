use std::borrow::Cow;

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{
    AgentRunRefusalChoiceRequestedPayload, AgentRunUsageCreditsChoiceRequestedPayload,
};
use sidekicks_contracts::run::queue::{
    AgentQueueItemCanceledPayload, AgentQueueItemCanceledState, QueueItemId,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_store::events::session::appender::{SessionEventDraft, SessionEventDraftError};

use super::running_at;
use crate::questions::schema::schema_parts;
use crate::queue_store::{
    NewQueueItem, QueueItemBody, QueueItemExit, QueueItemOutcome, QueueItemRecord,
    QueueMessageBody, insert_queue_item_statement, leave_queued_statement,
};
use crate::run::engine::test_fixture::{append, insert_run, stored_run_state, test_engine};
use crate::run::read::{LiveRun, RunRead};
use crate::run::state_change::RunWriteCompanions;

// The stand-in's table for the one statement it adds with no event, as the composer's draft is.
const CREATE_STOP_MARKS_SQL: &str = "CREATE TABLE stop_marks (session_id TEXT NOT NULL)";

// The stand-in for the queue's builder, which takes no message as taken: each waiting message
// `canceled` with its event, then one statement with no event.
fn cancel_waiting(
    items: &[QueueItemRecord],
    _run_id: RunId,
    _taken: &[QueueItemId],
    now: &WireInstant,
) -> Result<RunWriteCompanions, SessionEventDraftError> {
    let mut companions = RunWriteCompanions::default();
    for item in items {
        companions.statements.push(leave_queued_statement(
            &item.id,
            &QueueItemExit::Outcome(QueueItemOutcome::Canceled),
            now,
        ));
        companions
            .preceding_events
            .push(SessionEventDraft::of_session(
                item.session_id,
                &SessionEvent::AgentQueueItemCanceled(AgentQueueItemCanceledPayload {
                    session_id: item.session_id,
                    queue_item_id: item.id,
                    state: AgentQueueItemCanceledState::Value,
                }),
            )?);
    }
    companions.statements.push(WriteStatement {
        sql: Cow::Borrowed("INSERT INTO stop_marks (session_id) VALUES (@session_id)"),
        bindings: StatementBindings::Named(vec![text_binding(
            "@session_id",
            test_session_id().text().as_str(),
        )]),
        expected_row_count: Some(1),
    });
    Ok(companions)
}

// One row of the Stop's settle and what lands between its read and its write.
#[derive(Clone, Copy, Debug)]
enum StopCase {
    // A queued run two messages wait for.
    QueuedWithTwoMessages,
    // A run waiting on the refusal choice.
    WaitingOnTheRefusal,
    // A run waiting on the usage-credits choice.
    WaitingOnUsageCredits,
    // A queued run two messages wait for, a third queued after the read.
    QueuedWithAThirdQueuedMeanwhile,
    // A queued run whose one message left `queued` after the read.
    QueuedWhoseMessageLeftMeanwhile,
    // A running lead, a message queued for it after the read.
    RunningWithAMessageQueuedMeanwhile,
}

// The run's state and what the case writes for it before the settle.
struct Seeded {
    state: RunState,
    messages: usize,
}

fn seeded(case: StopCase) -> Seeded {
    match case {
        StopCase::QueuedWithTwoMessages | StopCase::QueuedWithAThirdQueuedMeanwhile => Seeded {
            state: RunState::Queued,
            messages: 2,
        },
        StopCase::QueuedWhoseMessageLeftMeanwhile => Seeded {
            state: RunState::Queued,
            messages: 1,
        },
        StopCase::WaitingOnTheRefusal | StopCase::WaitingOnUsageCredits => Seeded {
            state: RunState::WaitingForInput,
            messages: 0,
        },
        StopCase::RunningWithAMessageQueuedMeanwhile => Seeded {
            state: RunState::Running,
            messages: 0,
        },
    }
}

// Queues one message for `run_id` through `writer`; the queue crate's writer is not imported, since
// that crate depends on this one.
async fn queue_message(writer: &DatabaseWriter, session_id: SessionId, run_id: RunId) {
    let item = NewQueueItem {
        id: QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id"),
        session_id,
        body: QueueItemBody::Message(QueueMessageBody {
            content: FreeFormText::new("Look again".to_owned()).expect("a test message"),
            attachments: None,
            skills: None,
            answers_question_id: None,
            output_speed_for_turn: None,
            workspace_id: None,
        }),
        target_run_id: run_id,
        device_id: None,
        client_idempotency_key: None,
        replaces_queue_item_id: None,
        now: WireInstant::now(),
    };
    writer
        .write(vec![insert_queue_item_statement(&item)])
        .await
        .expect("the test queues its message");
}

// Each run and queue item event of the session's log, in order, with its payload's `member`.
fn stored_events_of(database: &TestDatabase, member: &str) -> Vec<(String, Option<String>)> {
    database
        .reader()
        .prepare(&format!(
            "SELECT type, json_extract(payload, '$.{member}') FROM session_events
              WHERE type LIKE 'agent.run.%' OR type LIKE 'agent.queueItem.%'
              ORDER BY sequence"
        ))
        .expect("the test reads the log")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the log reads")
        .collect::<Result<_, _>>()
        .expect("each event reads")
}

fn owned(expected: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
    expected
        .iter()
        .map(|(event_type, member)| ((*event_type).to_owned(), member.map(str::to_owned)))
        .collect()
}

// Killed by the builder's pairs dropped (`queued_with_two_messages` keeps its messages queued); by
// the waiting guard placed before them or pushed only for a queued run, or by no second attempt
// (`*_meanwhile` answer with an error or leave a message waiting); by the restart's "left" arm
// matched by its old fixed position under the Stop (`queued_whose_message_left_meanwhile` leaves
// the run queued); and by the refusal's settlement dropped (`waiting_on_the_refusal` settles the
// choice `runEnded`).
#[rstest]
#[case::queued_with_two_messages(StopCase::QueuedWithTwoMessages)]
#[case::waiting_on_the_refusal(StopCase::WaitingOnTheRefusal)]
#[case::waiting_on_usage_credits(StopCase::WaitingOnUsageCredits)]
#[case::queued_with_a_third_queued_meanwhile(StopCase::QueuedWithAThirdQueuedMeanwhile)]
#[case::queued_whose_message_left_meanwhile(StopCase::QueuedWhoseMessageLeftMeanwhile)]
#[case::running_with_a_message_queued_meanwhile(StopCase::RunningWithAMessageQueuedMeanwhile)]
#[tokio::test]
async fn a_stop_ends_a_run_and_its_waiting_messages_in_one_write(#[case] case: StopCase) {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let connection = database.reader();
    connection
        .execute(CREATE_STOP_MARKS_SQL, [])
        .expect("the test makes the stand-in's table");
    let Seeded { state, messages } = seeded(case);
    let version = if state == RunState::Queued {
        connection
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version)
                 VALUES (?1, ?2, 'queued', 0)",
                params![run_id.text().as_str(), session_id.text().as_str()],
            )
            .expect("the test queues the run");
        0
    } else {
        insert_run(&database, session_id, run_id, "running");
        connection
            .execute(
                "UPDATE runs SET state = ?2 WHERE run_id = ?1",
                params![run_id.text().as_str(), <&'static str>::from(state)],
            )
            .expect("the test puts the run in its state");
        1
    };
    for _ in 0..messages {
        queue_message(&writer, session_id, run_id).await;
    }
    let engine = test_engine(&database, log.service, home.path());
    match case {
        StopCase::WaitingOnTheRefusal => {
            let requested = SessionEvent::AgentRunRefusalChoiceRequested(
                AgentRunRefusalChoiceRequestedPayload {
                    session_id,
                    run_id,
                    refused_model: FreeFormText::new("a model".to_owned()).expect("a model"),
                    fallback_model: FreeFormText::new("a fallback".to_owned()).expect("a model"),
                    sentence: None,
                    safety_category: None,
                    retracted_message_ids: None,
                },
            );
            append(&engine, session_id, &requested).await;
        }
        StopCase::WaitingOnUsageCredits => {
            let requested = SessionEvent::AgentRunUsageCreditsChoiceRequested(
                AgentRunUsageCreditsChoiceRequestedPayload {
                    session_id,
                    run_id,
                    model_name: FreeFormText::new("a model".to_owned()).expect("a model name"),
                    overages_enabled: false,
                    balance_cents: None,
                    currency: None,
                    fallback_model: None,
                },
            );
            append(&engine, session_id, &requested).await;
        }
        StopCase::QueuedWithTwoMessages
        | StopCase::QueuedWithAThirdQueuedMeanwhile
        | StopCase::QueuedWhoseMessageLeftMeanwhile
        | StopCase::RunningWithAMessageQueuedMeanwhile => {}
    }
    let run = LiveRun {
        run: RunRead {
            state,
            ..running_at(session_id, run_id, version).run
        },
        ..running_at(session_id, run_id, version)
    };

    let paused = engine.restart_facts_pause().arm();
    let mut settling = Box::pin(engine.settle_run_at_stop(&run, cancel_waiting, &[], None));
    tokio::select! {
        settled = &mut settling => panic!("the settle passed its pause: {settled:?}"),
        reached = paused.reached => reached.expect("the settle holds after its read"),
    }
    match case {
        StopCase::QueuedWithAThirdQueuedMeanwhile
        | StopCase::RunningWithAMessageQueuedMeanwhile => {
            queue_message(&writer, session_id, run_id).await;
        }
        StopCase::QueuedWhoseMessageLeftMeanwhile => {
            connection
                .execute("UPDATE queue_items SET state = 'canceled'", [])
                .expect("the test takes the message out of the queue");
        }
        StopCase::QueuedWithTwoMessages
        | StopCase::WaitingOnTheRefusal
        | StopCase::WaitingOnUsageCredits => {}
    }
    paused.release.send(()).expect("the settle waits");
    settling.await.expect("the Stop settles the run");

    let still_queued: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM queue_items WHERE state = 'queued'",
            [],
            |row| row.get(0),
        )
        .expect("the test reads the queue");
    assert_eq!(still_queued, 0, "no message waits for the ended run");
    let marks: i64 = connection
        .query_row("SELECT COUNT(*) FROM stop_marks", [], |row| row.get(0))
        .expect("the test reads the stand-in's table");
    let canceled = |count: usize| vec![("agent.queueItem.canceled", None); count];
    match case {
        StopCase::QueuedWithTwoMessages
        | StopCase::QueuedWithAThirdQueuedMeanwhile
        | StopCase::QueuedWhoseMessageLeftMeanwhile => {
            let ended = match case {
                StopCase::QueuedWithAThirdQueuedMeanwhile => 3,
                StopCase::QueuedWithTwoMessages => 2,
                StopCase::QueuedWhoseMessageLeftMeanwhile
                | StopCase::WaitingOnTheRefusal
                | StopCase::WaitingOnUsageCredits
                | StopCase::RunningWithAMessageQueuedMeanwhile => 0,
            };
            let mut expected = canceled(ended);
            expected.push(("agent.run.stopped", Some("daemonStop")));
            assert_eq!(stored_events_of(&database, "trigger"), owned(&expected));
            assert_eq!(
                stored_run_state(&database, &run_id),
                ("stopped".to_owned(), 1)
            );
            assert_eq!(marks, 1, "the eventless statement is written once");
        }
        StopCase::RunningWithAMessageQueuedMeanwhile => {
            let mut expected = canceled(1);
            expected.push(("agent.run.interrupted", Some("daemonStop")));
            assert_eq!(stored_events_of(&database, "trigger"), owned(&expected));
            assert_eq!(
                stored_run_state(&database, &run_id),
                ("interrupted".to_owned(), 2)
            );
            assert_eq!(marks, 1, "the eventless statement is written once");
        }
        StopCase::WaitingOnTheRefusal => {
            assert_eq!(
                stored_events_of(&database, "choice"),
                owned(&[
                    ("agent.run.refusalChoice.requested", None),
                    ("agent.run.refusalChoice.resolved", Some("canceled")),
                    ("agent.run.failed", None),
                ])
            );
            let category: String = connection
                .query_row(
                    "SELECT json_extract(payload, '$.failureCategory') FROM session_events
                      WHERE type = 'agent.run.failed'",
                    [],
                    |row| row.get(0),
                )
                .expect("the test reads the run's end");
            assert_eq!(category, "refused");
            assert_eq!(
                stored_run_state(&database, &run_id),
                ("failed".to_owned(), 2)
            );
        }
        StopCase::WaitingOnUsageCredits => {
            assert_eq!(
                stored_events_of(&database, "choice"),
                owned(&[
                    ("agent.run.usageCreditsChoice.requested", None),
                    ("agent.run.usageCreditsChoice.resolved", Some("interrupted")),
                    ("agent.run.interrupted", None),
                ])
            );
            assert_eq!(
                stored_events_of(&database, "trigger").last(),
                Some(&(
                    "agent.run.interrupted".to_owned(),
                    Some("daemonStop".to_owned())
                ))
            );
            assert_eq!(
                stored_run_state(&database, &run_id),
                ("interrupted".to_owned(), 2)
            );
        }
    }
}
