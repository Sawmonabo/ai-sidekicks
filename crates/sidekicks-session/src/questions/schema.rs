//! The question tables of the daemon's one schema: one row per question record, held by a run or by
//! a workflow wait, and the queued messages that answer a question its agent does not wait for.
//!
//! Both are projections of the `question.*`, `user.message.sent` and `agent.queueItem.*` events,
//! written in each event's own write and rebuilt from the log. A record's pages stay in its
//! `question.asked` event, read from there when an answer is checked, and a secret answer is never
//! written anywhere.

use serde::Deserialize;
use sidekicks_store::database::schema::{SchemaPart, SchemaParts};
use sidekicks_store::database::sql_list::sql_list_of_every;
use strum::{IntoStaticStr, VariantArray};

/// Where a question record stands, as the `questions.state` column holds it: waiting for its run
/// to read running where it was asked while the run was not, then open until it is answered or
/// canceled. Converts to the column's word and reads back from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, VariantArray, IntoStaticStr)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub(crate) enum QuestionState {
    /// Waiting for its run to read running before it is answerable.
    WaitingForRun,
    /// Waiting for its answer.
    Open,
    /// Answered.
    Answered,
    /// Ended unanswered.
    Canceled,
}

/// The runs' list and the question tables' own part.
pub fn schema_parts() -> SchemaParts {
    crate::run::schema::schema_parts()
        .with_part(SchemaPart::new("questions", question_schema_sql()))
}

fn question_schema_sql() -> String {
    let states = sql_list_of_every::<QuestionState>();
    let open = <&'static str>::from(QuestionState::Open);
    let waiting = <&'static str>::from(QuestionState::WaitingForRun);
    format!(
        "
-- One row per question record, rebuilt from question.asked, question.opened, question.canceled,
-- the user.message.sent that answers it and the admission of a queued answer.
CREATE TABLE questions (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  run_id            TEXT,                      -- the run that holds it, or
  wait_id           TEXT,                      -- the workflow wait that holds it
  -- The provider's own id of the request a run's question came on, by which a request sent again
  -- after a restart finds its record; NULL on a wait's question and an id past a provider handle.
  provider_request_id TEXT,
  -- False only on a question the agent does not wait for, which a queued message answers.
  is_agent_waiting  INTEGER NOT NULL CHECK(is_agent_waiting IN (0, 1)),
  state             TEXT NOT NULL DEFAULT '{open}' CHECK(state IN ({states})),
  CHECK((run_id IS NULL) <> (wait_id IS NULL))
) STRICT;

CREATE INDEX idx_questions_session ON questions(session_id);
-- A run's end reads the questions it still holds, open or waiting for it.
CREATE INDEX idx_questions_unsettled_run ON questions(run_id)
  WHERE state IN ('{waiting}', '{open}');

-- Each queued message that answers a question its agent does not wait for, until the agent takes
-- one, which answers the question, or the message is withdrawn.
CREATE TABLE question_answer_items (
  queue_item_id  TEXT PRIMARY KEY,
  question_id    TEXT NOT NULL REFERENCES questions(id)
) STRICT;

CREATE INDEX idx_question_answer_items_question ON question_answer_items(question_id);
"
    )
}
