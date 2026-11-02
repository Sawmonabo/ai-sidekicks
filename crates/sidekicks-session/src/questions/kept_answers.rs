//! The kept answers: an answer given while no provider request held its question, as after the
//! daemon's restart before its provider asked again, kept so the question asked again and the
//! run's continue each take it once.
//!
//! - A plain answer's row is written in the answer's own write. A question answered while a
//!   request held it has none: that request took the answer.
//! - An answer with a secret is kept in memory only, lost at the daemon's next stop, and a
//!   continue reads it with the secret masked.
//! - Each hand claims its mark before the answer goes out, so a stop between the two loses that
//!   hand and never repeats it. A continue that failed gives its mark back for the next continue.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::named_params;
use sidekicks_contracts::question::{QuestionAnswer, QuestionId};
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;

use crate::questions::answer_text::compose_answer_text;
use crate::questions::resolve::asked_pages;
use crate::questions::service::{HeldRequestAnswerer, QuestionError, QuestionsService};
use crate::questions::store::read_asked;

const INSERT_KEPT_ANSWER_SQL: &str = "INSERT INTO question_kept_answers
    (question_id, session_id, run_id, answer, kept_at)
  VALUES (@questionId, @sessionId, @runId, @answer, @keptAt)";

// Each claim changes no row once another caller took that hand.
const CLAIM_CALL_SQL: &str = "UPDATE question_kept_answers SET call_handed_at = @at
  WHERE question_id = @questionId AND call_handed_at IS NULL";

const CLAIM_CONTINUE_SQL: &str = "UPDATE question_kept_answers SET continue_handed_at = @at
  WHERE question_id = @questionId AND continue_handed_at IS NULL";

const RELEASE_CONTINUE_SQL: &str = "UPDATE question_kept_answers SET continue_handed_at = NULL
  WHERE question_id = @questionId";

// The run's kept answers to a question of the same pages that no question asked again took yet.
const KEPT_CALL_ANSWERS_SQL: &str = "SELECT kept.question_id, kept.answer, kept.kept_at
  FROM question_kept_answers AS kept
  JOIN questions ON questions.id = kept.question_id
  WHERE kept.run_id = @runId AND kept.call_handed_at IS NULL
    AND questions.input_digest = @inputDigest";

// The session's kept answers neither a continue nor the question asked again took yet, since an
// answer the question asked again took is not repeated to the agent.
const OWED_CONTINUES_SQL: &str = "SELECT question_id, run_id, answer, kept_at
  FROM question_kept_answers
  WHERE session_id = @sessionId AND continue_handed_at IS NULL AND call_handed_at IS NULL";

/// A kept answer a run's continue still owes its agent: the question and what the person said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwedQuestionContinue {
    /// The question.
    pub question_id: QuestionId,
    /// The run that asked it.
    pub run_id: RunId,
    /// Its pages' questions, one line each, in the record's order.
    pub question: String,
    /// The person's answers, one line each, a secret read as answered secretly.
    pub answer: String,
}

/// The answers given with a secret while no request held their question, by question: held in
/// memory only, never written, so they are lost at the daemon's next stop.
#[derive(Default)]
pub(crate) struct KeptSecretAnswers(Mutex<HashMap<QuestionId, KeptSecretAnswer>>);

/// One answer given with a secret while no request held its question.
struct KeptSecretAnswer {
    /// The session.
    session_id: SessionId,
    /// The run that asked it.
    run_id: RunId,
    /// The digest of its pages, by which the question asked again finds it.
    input_digest: Option<Sha256Hex>,
    /// When it was kept.
    kept_at: WireInstant,
    /// The answers, secret included, until the question asked again takes them.
    answers: Option<Vec<QuestionAnswer>>,
    /// The person's turn, the secret masked, which the run's continue reads.
    answer_text: String,
    /// Whether a continue holds its mark.
    is_continue_handed: bool,
}

impl KeptSecretAnswers {
    /// Keeps `answers`, which hold a secret, to `question_id` of `run_id` in `session_id`, whose
    /// pages have `input_digest`.
    pub(crate) fn keep(
        &self,
        question_id: QuestionId,
        session_id: SessionId,
        run_id: RunId,
        input_digest: Option<Sha256Hex>,
        answers: Vec<QuestionAnswer>,
    ) {
        let answer_text = compose_answer_text(&answers);
        lock(&self.0).insert(
            question_id,
            KeptSecretAnswer {
                session_id,
                run_id,
                input_digest,
                kept_at: WireInstant::now(),
                answers: Some(answers),
                answer_text,
                is_continue_handed: false,
            },
        );
    }

    // The questions of `run_id` and `input_digest` whose answers no question asked again took,
    // with when each was kept.
    fn call_candidates(
        &self,
        run_id: RunId,
        input_digest: &Sha256Hex,
    ) -> Vec<(String, QuestionId)> {
        lock(&self.0)
            .iter()
            .filter(|(_, kept)| {
                kept.run_id == run_id
                    && kept.input_digest.as_ref() == Some(input_digest)
                    && kept.answers.is_some()
            })
            .map(|(question_id, kept)| (kept.kept_at.as_str().to_owned(), *question_id))
            .collect()
    }

    // Takes `question_id`'s answers for the question asked again, once; the secret is let go.
    fn take_call(&self, question_id: &QuestionId) -> Option<Vec<QuestionAnswer>> {
        lock(&self.0).get_mut(question_id)?.answers.take()
    }

    // The session's answers neither a continue nor the question asked again holds, with when each
    // was kept.
    fn owed(&self, session_id: SessionId) -> Vec<(String, QuestionId, RunId, String)> {
        lock(&self.0)
            .iter()
            .filter(|(_, kept)| {
                kept.session_id == session_id && !kept.is_continue_handed && kept.answers.is_some()
            })
            .map(|(question_id, kept)| {
                (
                    kept.kept_at.as_str().to_owned(),
                    *question_id,
                    kept.run_id,
                    kept.answer_text.clone(),
                )
            })
            .collect()
    }

    // Sets `question_id`'s continue mark to `is_handed`: whether it changed, or `None` where no
    // secret answer of it is kept.
    fn mark_continue(&self, question_id: &QuestionId, is_handed: bool) -> Option<bool> {
        let mut kept = lock(&self.0);
        let kept = kept.get_mut(question_id)?;
        let is_changed = kept.is_continue_handed != is_handed;
        kept.is_continue_handed = is_handed;
        Some(is_changed)
    }
}

/// The kept row of `answers`, plain answers to `question_id` of `run_id` in `session_id`, written
/// in the answer's own write. Refused when the question's answer is already kept.
pub(crate) fn insert_kept_answer_statement(
    question_id: QuestionId,
    session_id: SessionId,
    run_id: RunId,
    answers: &[QuestionAnswer],
) -> WriteStatement {
    let answer = serde_json::to_string(answers).expect("a question's answers write as JSON");
    WriteStatement {
        sql: Cow::Borrowed(INSERT_KEPT_ANSWER_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@questionId", question_id.text().as_str()),
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@runId", run_id.text().as_str()),
            text_binding("@answer", &answer),
            text_binding("@keptAt", WireInstant::now().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

impl QuestionsService {
    /// Every kept answer the session's runs' continues still owe, oldest first: one the question
    /// asked again did not take. Fails as the read fails, or where the log holds no
    /// `question.asked` for a kept answer's question.
    pub async fn owed_continues(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<OwedQuestionContinue>, QuestionError> {
        let secrets = self.kept_secrets.owed(session_id);
        let mut owed = self
            .reads
            .read(ReadLength::Short, move |reader| {
                let rows = reader
                    .prepare_cached(OWED_CONTINUES_SQL)?
                    .query_map(
                        named_params! { "@sessionId": session_id.text().as_str() },
                        |row| {
                            let answers: Vec<QuestionAnswer> =
                                text_column(row, 2, |text| serde_json::from_str(&text))?;
                            Ok((
                                row.get::<_, String>(3)?,
                                text_column(row, 0, |text| QuestionId::new(&text))?,
                                text_column(row, 1, |text| RunId::new(&text))?,
                                compose_answer_text(&answers),
                            ))
                        },
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows.into_iter()
                    .chain(secrets)
                    .map(|(kept_at, question_id, run_id, answer)| {
                        let asked = read_asked(reader, session_id, &question_id)?
                            .ok_or(QuestionError::AskedMissing { question_id })?;
                        let question = asked_pages(&asked)
                            .iter()
                            .map(|page| page.text.as_str())
                            .collect::<Vec<_>>()
                            .join("\n");
                        Ok((
                            kept_at,
                            OwedQuestionContinue {
                                question_id,
                                run_id,
                                question,
                                answer,
                            },
                        ))
                    })
                    .collect::<Result<Vec<_>, QuestionError>>()
            })
            .await?;
        owed.sort_by(|(left, _), (right, _)| left.cmp(right));
        Ok(owed.into_iter().map(|(_, owed)| owed).collect())
    }

    /// Claims the question's kept answer for a run's continue: true for the one caller that takes
    /// it, false once it was taken and for a question with no kept answer. Fails as the claim's
    /// write fails.
    pub async fn claim_continue(&self, question_id: QuestionId) -> Result<bool, QuestionError> {
        if let Some(is_claimed) = self.kept_secrets.mark_continue(&question_id, true) {
            return Ok(is_claimed);
        }
        self.claim(CLAIM_CONTINUE_SQL, question_id).await
    }

    /// Gives back a continue's claim on the question's kept answer, the continue having failed
    /// before it reached the agent, so the next continue takes it. Fails as the write fails.
    pub async fn release_continue(&self, question_id: QuestionId) -> Result<(), QuestionError> {
        if self
            .kept_secrets
            .mark_continue(&question_id, false)
            .is_some()
        {
            return Ok(());
        }
        let release = WriteStatement {
            sql: Cow::Borrowed(RELEASE_CONTINUE_SQL),
            bindings: StatementBindings::Named(vec![text_binding(
                "@questionId",
                question_id.text().as_str(),
            )]),
            expected_row_count: None,
        };
        self.writer.write(vec![release]).await?;
        Ok(())
    }

    /// Hands the oldest kept answer of `run_id` to a question of `input_digest`'s pages, that no
    /// question asked again took yet, to `request_id` through `answered_by`, its mark claimed
    /// first; answers the question it answered, or `None` where no such answer is kept. Fails as
    /// the read, the claim or the hand fails; a hand that fails after its claim is not repeated.
    pub(super) async fn hand_kept_answer(
        &self,
        run_id: RunId,
        request_id: &str,
        input_digest: Sha256Hex,
        answered_by: &HeldRequestAnswerer,
    ) -> Result<Option<QuestionId>, QuestionError> {
        let mut candidates = self.kept_secrets.call_candidates(run_id, &input_digest);
        let mut rows = self
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QuestionError>(
                    reader
                        .prepare_cached(KEPT_CALL_ANSWERS_SQL)?
                        .query_map(
                            named_params! {
                                "@runId": run_id.text().as_str(),
                                "@inputDigest": input_digest.as_str(),
                            },
                            |row| {
                                let question_id =
                                    text_column(row, 0, |text| QuestionId::new(&text))?;
                                let answers: Vec<QuestionAnswer> =
                                    text_column(row, 1, |text| serde_json::from_str(&text))?;
                                let kept_at: String = row.get(2)?;
                                Ok((question_id, (kept_at, answers)))
                            },
                        )?
                        .collect::<rusqlite::Result<HashMap<_, _>>>()?,
                )
            })
            .await?;
        candidates.extend(
            rows.iter()
                .map(|(question_id, (kept_at, _))| (kept_at.clone(), *question_id)),
        );
        candidates.sort_by(|(left, _), (right, _)| left.cmp(right));
        for (_, question_id) in candidates {
            let answers = match rows.remove(&question_id) {
                Some((_, answers)) => {
                    if !self.claim(CLAIM_CALL_SQL, question_id).await? {
                        continue;
                    }
                    answers
                }
                None => match self.kept_secrets.take_call(&question_id) {
                    Some(answers) => answers,
                    None => continue,
                },
            };
            self.send_answers(run_id, request_id.to_owned(), answered_by, answers)
                .await?;
            return Ok(Some(question_id));
        }
        Ok(None)
    }

    // One guarded claim: true where it changed the row, false where another caller took it first
    // or the question has no kept answer.
    async fn claim(
        &self,
        sql: &'static str,
        question_id: QuestionId,
    ) -> Result<bool, QuestionError> {
        let claim = WriteStatement {
            sql: Cow::Borrowed(sql),
            bindings: StatementBindings::Named(vec![
                text_binding("@questionId", question_id.text().as_str()),
                text_binding("@at", WireInstant::now().as_str()),
            ]),
            expected_row_count: Some(1),
        };
        match self.writer.write(vec![claim]).await {
            Ok(_results) => Ok(true),
            Err(refused) if refused.refused_statement_index().is_some() => Ok(false),
            Err(failure) => Err(failure.into()),
        }
    }
}
