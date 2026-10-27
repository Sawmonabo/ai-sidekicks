//! The question tables as the log keeps them in step: each record from its `question.asked`, each
//! opening of one that waited for its run from its `question.opened`, each cancellation from its
//! `question.canceled`, a held question's answer from the `user.message.sent` that names it, and a
//! queued answer's pairing, withdrawal and admission from the send and the queue's own events. A
//! rebuild writes every row at the event's own instant through the live write's own statements and
//! guards, so the rows it writes are the rows the live writes wrote.

use std::borrow::Cow;

use rusqlite::types::Value;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::question::QuestionSettledState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;

use crate::questions::store::{
    insert_question_statement, open_waiting_question_statement, queued_answer_statements,
    settle_question_statement,
};

const CLEAR_ANSWER_ITEMS_SQL: &str = "DELETE FROM question_answer_items
  WHERE question_id IN (SELECT id FROM questions WHERE session_id = ?)";

const CLEAR_QUESTIONS_SQL: &str = "DELETE FROM questions WHERE session_id = ?";

// Every type the fold reads: a record, its opening, its cancellation, a send that answers it, and
// what becomes of a queued answer.
const QUESTION_EVENT_TYPES: [SessionEventType; 7] = [
    SessionEventType::QuestionAsked,
    SessionEventType::QuestionOpened,
    SessionEventType::QuestionCanceled,
    SessionEventType::UserMessageSent,
    SessionEventType::AgentQueueItemAdmitted,
    SessionEventType::AgentQueueItemCanceled,
    SessionEventType::AgentQueueItemSuperseded,
];

/// The statements that keep the queued answers of every question in step with an append, run in
/// the append's own write for each event it stores.
pub fn question_projection_statements(envelope: &UnsequencedEventEnvelope) -> Vec<WriteStatement> {
    queued_answer_statements(envelope.event_type(), envelope.payload())
}

/// The `questions` and `question_answer_items` rows as a rebuild replaces them. Its fold keeps no
/// state, so the projection is its own fold.
#[derive(Clone, Copy, Debug)]
pub struct QuestionsProjection;

impl SessionProjection for QuestionsProjection {
    fn name(&self) -> &'static str {
        "questions"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &QUESTION_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        [CLEAR_ANSWER_ITEMS_SQL, CLEAR_QUESTIONS_SQL]
            .into_iter()
            .map(|sql| WriteStatement {
                sql: Cow::Borrowed(sql),
                bindings: StatementBindings::Positional(vec![Value::Text(
                    session_id.text().as_str().to_owned(),
                )]),
                expected_row_count: None,
            })
            .collect()
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(*self)
    }
}

impl SessionProjectionFold for QuestionsProjection {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        if let SessionEvent::QuestionAsked(asked) = event {
            statements.push(insert_question_statement(asked));
        } else if let SessionEvent::QuestionOpened(opened) = event {
            statements.push(open_waiting_question_statement(&opened.question_id));
        } else if let SessionEvent::QuestionCanceled(canceled) = event {
            statements.push(settle_question_statement(
                &canceled.question_id,
                QuestionSettledState::Canceled,
            ));
        } else if let SessionEvent::UserMessageSent(sent) = event
            && let Some(question_id) = sent.answers_question_id
            && sent.queue_item_id.is_none()
        {
            // A held question's answer, written beside its settle rather than through the queue.
            statements.push(settle_question_statement(
                &question_id,
                QuestionSettledState::Answered,
            ));
        }
        statements.extend(queued_answer_statements(
            event.event_type(),
            &envelope.payload,
        ));
        Ok(())
    }
}
