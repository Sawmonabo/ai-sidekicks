//! The question rows' writes, each the statement its event's live write and a rebuild's fold share,
//! with the guards the live write keeps, and the reads of a record, its pages and the questions a
//! run's end settles.

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::LazyLock;

use rusqlite::types::{Type, Value as SqlValue};
use rusqlite::{Connection, OptionalExtension as _, named_params};
use serde_json::{Map, Value};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::question::{
    QuestionAskedPayload, QuestionAskedState, QuestionId, QuestionSettledState,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::{UuidText, UuidTextForm};

use crate::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::stored_column::{closed_word, optional_text_column, text_column};
use crate::questions::schema::QuestionState;

const INSERT_QUESTION_SQL: &str = "INSERT INTO questions
  (id, session_id, run_id, wait_id, is_agent_waiting, state)
  VALUES (@id, @sessionId, @runId, @waitId, @isAgentWaiting, @state)";

// Settles an open question, or cancels one waiting for its run; refused once it is settled.
static SETTLE_QUESTION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE questions SET state = @state
  WHERE id = @questionId
    AND (state = '{open}' OR (state = '{waiting}' AND @state = '{canceled}'))",
        open = <&'static str>::from(QuestionState::Open),
        waiting = <&'static str>::from(QuestionState::WaitingForRun),
        canceled = <&'static str>::from(QuestionState::Canceled)
    )
});

// Opens a question that waited for its run; refused unless it still waits.
static OPEN_WAITING_QUESTION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE questions SET state = '{open}' WHERE id = @questionId AND state = '{waiting}'",
        open = <&'static str>::from(QuestionState::Open),
        waiting = <&'static str>::from(QuestionState::WaitingForRun)
    )
});

// A queued message answering an open question its agent does not wait for; any other message
// that names a question pairs nothing.
static PAIR_ANSWER_ITEM_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO question_answer_items (queue_item_id, question_id)
  SELECT @queueItemId, id FROM questions
   WHERE id = @questionId AND state = '{}' AND is_agent_waiting = 0",
        <&'static str>::from(QuestionState::Open)
    )
});

const UNPAIR_ANSWER_ITEM_SQL: &str =
    "DELETE FROM question_answer_items WHERE queue_item_id = @queueItemId";

// The agent took a queued answer: its question is answered.
static ANSWER_BY_ITEM_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE questions SET state = '{answered}'
  WHERE state = '{open}'
    AND id = (SELECT question_id FROM question_answer_items WHERE queue_item_id = @queueItemId)",
        answered = <&'static str>::from(QuestionState::Answered),
        open = <&'static str>::from(QuestionState::Open)
    )
});

// Every other queued answer of the question the taken one answered pairs nothing any longer.
const UNPAIR_ANSWERED_SQL: &str = "DELETE FROM question_answer_items
  WHERE question_id IN (SELECT question_id FROM question_answer_items
                         WHERE queue_item_id = @queueItemId)";

const QUESTION_SQL: &str = "SELECT session_id, run_id, wait_id, is_agent_waiting, state
  FROM questions WHERE id = @questionId";

// The record's `question.asked`, which holds its pages.
const ASKED_SQL: &str = "SELECT payload FROM session_events
  WHERE session_id = @sessionId AND type = @askedType
    AND json_extract(payload, '$.questionId') = @questionId";

// The questions a run holds open, or waiting for it, and its agent waits on.
static UNSETTLED_HELD_OF_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, session_id FROM questions
  WHERE run_id = @runId AND state IN ('{waiting}', '{open}') AND is_agent_waiting = 1
  ORDER BY rowid",
        waiting = <&'static str>::from(QuestionState::WaitingForRun),
        open = <&'static str>::from(QuestionState::Open)
    )
});

// Which of a JSON array of question ids are not settled: open, or waiting for their run.
static UNSETTLED_AMONG_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT questions.id FROM json_each(@questionIds) AS listed
  JOIN questions ON questions.id = listed.value
  WHERE questions.state IN ('{waiting}', '{open}')",
        waiting = <&'static str>::from(QuestionState::WaitingForRun),
        open = <&'static str>::from(QuestionState::Open)
    )
});

/// What holds a question open: the run that asked it, or a workflow wait.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuestionHolder {
    /// The run that asked it.
    Run(RunId),
    /// The workflow wait that asked it.
    Wait(UuidTextForm),
}

/// A stored question row that names both a run and a wait, or neither, which the schema's check
/// refuses.
#[derive(Debug, thiserror::Error)]
#[error("the stored question names not exactly one of a run and a wait")]
struct StoredHolderError;

/// A question record as its row holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredQuestion {
    /// The session.
    pub(crate) session_id: SessionId,
    /// What holds it.
    pub(crate) holder: QuestionHolder,
    /// False only on a question its agent does not wait for.
    pub(crate) is_agent_waiting: bool,
    /// Where it stands.
    pub(crate) state: QuestionState,
}

/// A question its agent waits on, open or waiting for its run, as a run's end settles it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HeldQuestion {
    /// The question.
    pub(crate) question_id: QuestionId,
    /// Its session.
    pub(crate) session_id: SessionId,
}

/// The record's row as `asked` writes it, open or waiting for its run. Refused when the record is
/// already kept.
pub(crate) fn insert_question_statement(asked: &QuestionAskedPayload) -> WriteStatement {
    let (question_id, session_id, run_id, wait_id, is_agent_waiting, state) = match asked {
        QuestionAskedPayload::Run(asked) => (
            asked.question_id,
            asked.session_id,
            Some(asked.run_id.text()),
            None,
            asked.is_agent_waiting,
            match asked.state {
                QuestionAskedState::Open => QuestionState::Open,
                QuestionAskedState::WaitingForRun => QuestionState::WaitingForRun,
            },
        ),
        QuestionAskedPayload::Wait(asked) => (
            asked.question_id,
            asked.session_id,
            None,
            Some(asked.wait_id.text()),
            asked.is_agent_waiting,
            QuestionState::Open,
        ),
    };
    WriteStatement {
        sql: Cow::Borrowed(INSERT_QUESTION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", question_id.text().as_str()),
            text_binding("@sessionId", session_id.text().as_str()),
            nullable_text_binding("@runId", run_id.as_ref().map(UuidText::as_str)),
            nullable_text_binding("@waitId", wait_id.as_ref().map(UuidText::as_str)),
            (
                Cow::Borrowed("@isAgentWaiting"),
                SqlValue::Integer(i64::from(is_agent_waiting)),
            ),
            text_binding("@state", state.into()),
        ]),
        expected_row_count: Some(1),
    }
}

/// Opens `question_id`, which waited for its run; refused unless it still waits.
pub(crate) fn open_waiting_question_statement(question_id: &QuestionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(OPEN_WAITING_QUESTION_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding(
            "@questionId",
            question_id.text().as_str(),
        )]),
        expected_row_count: Some(1),
    }
}

/// Settles the open question `question_id` as `state`, or cancels it while it waits for its run;
/// refused once it is settled, and an answer is refused while it waits.
pub(crate) fn settle_question_statement(
    question_id: &QuestionId,
    state: QuestionSettledState,
) -> WriteStatement {
    let state = match state {
        QuestionSettledState::Answered => QuestionState::Answered,
        QuestionSettledState::Canceled => QuestionState::Canceled,
    };
    WriteStatement {
        sql: Cow::Borrowed(SETTLE_QUESTION_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@questionId", question_id.text().as_str()),
            text_binding("@state", state.into()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statements that keep a question its agent does not wait for in step with the queue, given
/// an event's type and stored payload: a send naming it pairs its queued message, a withdrawn
/// message unpairs, and the agent taking a paired message answers the question and unpairs every
/// other answer to it. Any other event writes none, and none of them is refused, so this runs on
/// every append and in every rebuild.
pub(crate) fn queued_answer_statements(
    event_type: SessionEventType,
    payload: &Map<String, Value>,
) -> Vec<WriteStatement> {
    let Some(queue_item_id) = payload.get("queueItemId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let item_statement = |sql: &'static str| WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![text_binding("@queueItemId", queue_item_id)]),
        expected_row_count: None,
    };
    if event_type == SessionEventType::UserMessageSent {
        let Some(question_id) = payload.get("answersQuestionId").and_then(Value::as_str) else {
            return Vec::new();
        };
        vec![WriteStatement {
            sql: Cow::Borrowed(PAIR_ANSWER_ITEM_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@queueItemId", queue_item_id),
                text_binding("@questionId", question_id),
            ]),
            expected_row_count: None,
        }]
    } else if event_type == SessionEventType::AgentQueueItemAdmitted {
        vec![
            item_statement(ANSWER_BY_ITEM_SQL.as_str()),
            item_statement(UNPAIR_ANSWERED_SQL),
        ]
    } else if matches!(
        event_type,
        SessionEventType::AgentQueueItemCanceled | SessionEventType::AgentQueueItemSuperseded
    ) {
        vec![item_statement(UNPAIR_ANSWER_ITEM_SQL)]
    } else {
        Vec::new()
    }
}

/// The record `question_id`, or `None` when no row holds it. Fails as SQLite does, or when a
/// stored column does not read as its type.
pub(crate) fn read_question(
    connection: &Connection,
    question_id: &QuestionId,
) -> rusqlite::Result<Option<StoredQuestion>> {
    connection
        .prepare_cached(QUESTION_SQL)?
        .query_row(
            named_params! { "@questionId": question_id.text().as_str() },
            |row| {
                let run_id = optional_text_column(row, 1, |text| RunId::new(&text))?;
                let wait_id = optional_text_column(row, 2, |text| UuidTextForm::new(&text))?;
                let holder = match (run_id, wait_id) {
                    (Some(run_id), None) => QuestionHolder::Run(run_id),
                    (None, Some(wait_id)) => QuestionHolder::Wait(wait_id),
                    (Some(_), Some(_)) | (None, None) => {
                        return Err(rusqlite::Error::FromSqlConversionFailure(
                            1,
                            Type::Text,
                            Box::new(StoredHolderError),
                        ));
                    }
                };
                Ok(StoredQuestion {
                    session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                    holder,
                    is_agent_waiting: row.get(3)?,
                    state: text_column(row, 4, closed_word)?,
                })
            },
        )
        .optional()
}

/// The `question.asked` that opened `question_id` in `session_id`, which holds its pages, or
/// `None` when the log holds none. Fails as SQLite does, or when the stored payload does not read
/// as the event's.
pub(crate) fn read_asked(
    connection: &Connection,
    session_id: SessionId,
    question_id: &QuestionId,
) -> rusqlite::Result<Option<QuestionAskedPayload>> {
    connection
        .prepare_cached(ASKED_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@askedType": SessionEventType::QuestionAsked.as_str(),
                "@questionId": question_id.text().as_str(),
            },
            |row| text_column(row, 0, |text| serde_json::from_str(&text)),
        )
        .optional()
}

/// Which of `question_ids` are not settled: open, or waiting for their run. Fails as SQLite does,
/// or when a stored id does not read.
pub(crate) fn read_unsettled_among(
    connection: &Connection,
    question_ids: &[QuestionId],
) -> rusqlite::Result<HashSet<QuestionId>> {
    let listed = serde_json::to_string(question_ids).expect("a list of ids writes as JSON");
    connection
        .prepare_cached(&UNSETTLED_AMONG_SQL)?
        .query_map(named_params! { "@questionIds": listed }, |row| {
            text_column(row, 0, |text| QuestionId::new(&text))
        })?
        .collect()
}

/// The questions `run_id` holds open or waiting for it whose agent waits on them, oldest first.
/// Fails as SQLite does, or when a stored id does not read.
pub(crate) fn read_unsettled_held_questions(
    connection: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Vec<HeldQuestion>> {
    connection
        .prepare_cached(&UNSETTLED_HELD_OF_RUN_SQL)?
        .query_map(named_params! { "@runId": run_id.text().as_str() }, |row| {
            Ok(HeldQuestion {
                question_id: text_column(row, 0, |text| QuestionId::new(&text))?,
                session_id: text_column(row, 1, |text| SessionId::new(&text))?,
            })
        })?
        .collect()
}
