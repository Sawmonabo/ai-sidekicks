//! The seen mark: how far the person has seen a session, or one workflow run in it, kept as the
//! session's newest event sequence when they looked, so an entry raised by a later event reads
//! unseen however close in time it came.

use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::attention::AttentionSeenSubject;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_ipc::workflow_run_not_found::workflow_run_not_found;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::writer::DatabaseWriter;

use crate::attention::moment::AttentionSubject;
use crate::attention::projection::{binding, session_binding, statement, version_bump_sql};
use crate::attention::retention::{retention_statements, seen_entry_sql};
use crate::directory::lookups::{SessionWriteError, session_exists_statement};

// Reads a row only while the workflow run is one of the session's.
const WORKFLOW_RUN_IN_SESSION_SQL: &str =
    "SELECT 1 FROM workflow_runs WHERE id = @seen_run_id AND session_id = @session_id";

// The subject's mark moves to the session's newest event. Every session row is written with its
// creation event, so the session has one.
const MARK_SEEN_SQL: &str = "INSERT INTO attention_seen (session_id, run_id, seen_through_sequence)
  SELECT @session_id, @seen_run_id, MAX(sequence) FROM session_events
   WHERE session_id = @session_id
  ON CONFLICT (session_id, run_id)
    DO UPDATE SET seen_through_sequence = excluded.seen_through_sequence";

// The counts move when an entry of the subject was raised past its mark, which the move makes
// seen; read before the mark moves.
static BUMP_IF_UNSEEN_ENTRIES_SQL: LazyLock<String> = LazyLock::new(|| {
    version_bump_sql(&format!(
        "EXISTS (SELECT 1 FROM attention_entries AS entry
    JOIN session_events AS source ON source.id = entry.source_event_id
   WHERE entry.session_id = @session_id
     AND COALESCE(entry.workflow_run_id, '') = @seen_run_id
     AND NOT {seen})",
        seen = seen_entry_sql("entry", "source.sequence"),
    ))
});

impl From<&AttentionSeenSubject> for AttentionSubject {
    /// A named workflow run is its own subject; the session is the subject otherwise.
    fn from(subject: &AttentionSeenSubject) -> Self {
        match subject.run_id {
            Some(workflow_run_id) => Self::WorkflowRun(workflow_run_id),
            None => Self::Session(subject.session_id),
        }
    }
}

/// Marks `subject` seen through the session's newest event, in one write that also retires the
/// session's entries the mark leaves past keeping and raises the counts when an entry turned
/// seen. Fails with [`SessionWriteError::Refused`]: `session.notFound` for a session with no row,
/// `workflow.run.notFound` for a run the session does not hold, either changing nothing; and with
/// [`SessionWriteError::Write`] when the write is not kept.
pub async fn write_seen(
    writer: &DatabaseWriter,
    subject: &AttentionSeenSubject,
) -> Result<(), SessionWriteError> {
    let session_id = subject.session_id;
    let seen_run_id = match AttentionSubject::from(subject) {
        AttentionSubject::Session(_) => None,
        AttentionSubject::WorkflowRun(workflow_run_id) => Some(workflow_run_id),
    };
    let mark_bindings = || {
        vec![
            session_binding(session_id),
            binding(
                "@seen_run_id",
                Value::Text(
                    seen_run_id
                        .map_or_else(String::new, |workflow_run_id| workflow_run_id.to_string()),
                ),
            ),
        ]
    };
    let mut statements = vec![session_exists_statement(&session_id)];
    if seen_run_id.is_some() {
        statements.push(WriteStatement {
            expected_row_count: Some(1),
            ..statement(WORKFLOW_RUN_IN_SESSION_SQL, mark_bindings())
        });
    }
    statements.push(statement(&BUMP_IF_UNSEEN_ENTRIES_SQL, mark_bindings()));
    statements.push(statement(MARK_SEEN_SQL, mark_bindings()));
    statements.extend(retention_statements(session_id));
    match writer.write(statements).await {
        Ok(_) => Ok(()),
        Err(error) => Err(match (error.refused_statement_index(), seen_run_id) {
            (Some(0), _) => session_not_found(&session_id).into(),
            (Some(1), Some(workflow_run_id)) => workflow_run_not_found(&workflow_run_id).into(),
            (Some(_) | None, _) => error.into(),
        }),
    }
}
