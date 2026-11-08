//! A child run moved under the run whose call started it, when the run started before that call
//! reached the daemon: one `agent.run.parentCorrected` written with the run's new parent, whatever
//! the run's state.

use std::borrow::Cow;
use std::sync::LazyLock;

use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::run::events::AgentRunParentCorrectedPayload;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::SessionEventDraft;

use crate::run::engine::RunEngine;
use crate::run::engine::errors::RunEngineError;
use crate::run::projection::{CORRECT_PARENT_RUN_SQL, correct_parent_run_statement};

// The correction's column write, matching only a child run never corrected before whose new parent
// is a run of its session and neither the run itself nor a run below it. The walk up from the new
// parent is bounded by the session's runs, each inserted with its parent already present.
static GUARDED_CORRECT_PARENT_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    let parent_corrected = SessionEventType::AgentRunParentCorrected.as_str();
    format!(
        "{CORRECT_PARENT_RUN_SQL}
    AND parent_run_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM runs AS parent
                 WHERE parent.run_id = @parent_run_id AND parent.session_id = @session_id)
    AND NOT EXISTS (SELECT 1 FROM session_events
                     WHERE session_id = @session_id AND run_id = @run_id
                       AND type = '{parent_corrected}')
    AND NOT EXISTS (WITH RECURSIVE above(run_id) AS (
                      SELECT @parent_run_id
                      UNION SELECT runs.parent_run_id FROM runs JOIN above USING (run_id)
                       WHERE runs.parent_run_id IS NOT NULL)
                    SELECT 1 FROM above WHERE run_id = @run_id)"
    )
});

impl RunEngine {
    /// Moves the child run `run_id` under `parent_run_id`, the run whose call started it, in any
    /// state, an ended run included: one `agent.run.parentCorrected` and the row's new parent in
    /// one write, answering the event's id. Fails with
    /// [`RunRefusal::NotFound`](crate::run::refusals::RunRefusal::NotFound) for a run the
    /// daemon has no row for, and with [`RunEngineError::Append`], nothing written, when the run
    /// is no child, was corrected before, or the new parent is no run of its session, is the run
    /// itself or is below it.
    pub(crate) async fn correct_parent_run(
        &self,
        run_id: RunId,
        parent_run_id: RunId,
    ) -> Result<FreeFormText<EVENT_FIELD_MAX_LEN>, RunEngineError> {
        let run = self.require_run(run_id).await?;
        let payload = AgentRunParentCorrectedPayload {
            session_id: run.session_id,
            run_id,
            parent_run_id,
        };
        let guarded = WriteStatement {
            sql: Cow::Borrowed(GUARDED_CORRECT_PARENT_RUN_SQL.as_str()),
            expected_row_count: Some(1),
            ..correct_parent_run_statement(&payload)
        };
        let draft = SessionEventDraft::of_session(
            run.session_id,
            &SessionEvent::AgentRunParentCorrected(payload),
        )?;
        let receipt = self.append(draft, vec![guarded], Vec::new(), None).await?;
        Ok(receipt.id)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::queued::AgentRunQueuedPayload;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_provider::driver::test_registry::new_run_id;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
    use sidekicks_store::events::projection::SessionProjection as _;
    use sidekicks_store::events::session::appender::SessionEventDraft;
    use sidekicks_store::events::session::read::{SessionEventFilter, SessionEventReads};
    use tempfile::TempDir;

    use crate::run::engine::RunEngine;
    use crate::run::engine::errors::RunEngineError;
    use crate::run::engine::test_fixture::{parent_of, test_engine};
    use crate::run::projection::{RunsProjection, insert_queued_run_statement};
    use crate::run::refusals::RunRefusal;
    use crate::run::schema::schema_parts;

    /// A session's runs: its lead, two children of the lead (the run moved and the run whose call
    /// started it), a grandchild below the run moved, and the lead of another session.
    struct Fixture {
        database: TestDatabase,
        log: TestLog,
        engine: Arc<RunEngine>,
        session_id: SessionId,
        lead: RunId,
        child: RunId,
        caller: RunId,
        grandchild: RunId,
        other_session_lead: RunId,
        _home: TempDir,
    }

    impl Fixture {
        async fn new() -> Self {
            let database = TestDatabase::new(schema_parts());
            let log = open_log(&database, None).await;
            let home = tempfile::tempdir().expect("the test makes a home folder");
            let engine = test_engine(&database, Arc::clone(&log.service), home.path());
            let session_id = test_session_id();
            let lead = queue_run(&engine, session_id, None).await;
            let child = queue_run(&engine, session_id, Some(lead)).await;
            let caller = queue_run(&engine, session_id, Some(lead)).await;
            let grandchild = queue_run(&engine, session_id, Some(child)).await;
            let other_session_lead = queue_run(&engine, test_session_id(), None).await;
            Self {
                database,
                log,
                engine,
                session_id,
                lead,
                child,
                caller,
                grandchild,
                other_session_lead,
                _home: home,
            }
        }

        /// How many events the log holds, every session's.
        fn event_count(&self) -> i64 {
            self.database
                .reader()
                .query_row("SELECT COUNT(*) FROM session_events", [], |row| row.get(0))
                .expect("the test counts the log")
        }

        /// The id and type of the log's last event.
        fn last_event(&self) -> (String, String) {
            self.database
                .reader()
                .query_row(
                    "SELECT id, type FROM session_events ORDER BY rowid DESC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("the test reads the log's last event")
        }

        /// Ends the run `completed`.
        fn end(&self, run_id: &RunId) {
            self.database
                .reader()
                .execute(
                    "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
                    [run_id.text().as_str()],
                )
                .expect("the test ends the run");
        }
    }

    /// Queues a run of `session_id` under `parent`, its `agent.run.queued` and its row in one
    /// write, as the engine writes them.
    async fn queue_run(engine: &RunEngine, session_id: SessionId, parent: Option<RunId>) -> RunId {
        let run_id = new_run_id();
        let mut payload = json!({
            "sessionId": session_id,
            "runId": run_id,
            "runVersion": 0,
            "newState": "queued",
            "agentId": mint_uuid_v7().to_string(),
            "admittedProviderAccountId": "account-1",
        });
        if let Some(parent_run_id) = parent {
            payload["parentRunId"] = json!(parent_run_id);
            payload["reachedBy"] = json!("bridgeRun");
        }
        let queued: AgentRunQueuedPayload =
            serde_json::from_value(payload).expect("the test writes a queued run");
        let row = insert_queued_run_statement(&queued);
        engine
            .append(
                SessionEventDraft::of_session(session_id, &SessionEvent::AgentRunQueued(queued))
                    .expect("the event passes its checks"),
                vec![row],
                Vec::new(),
                None,
            )
            .await
            .expect("the run is queued");
        run_id
    }

    /// A row of the case table: the run corrected and its new parent.
    #[derive(Clone, Copy, Debug)]
    enum Case {
        LiveChild,
        EndedChild,
        CorrectedChild,
        LeadRun,
        OtherSessionParent,
        UnknownParent,
        ItselfParent,
        BelowParent,
        UnknownRun,
    }

    /// What a row of the case table answers.
    #[derive(Debug, PartialEq, Eq)]
    enum Expected {
        Lands,
        Refused,
        NotFound,
    }

    // Killed by the guard's once-only clause dropped (a corrected child lands again), by the walk
    // up dropped (a run below lands as the parent), by the session clause dropped (another
    // session's run lands as the parent), and by the write made only while the run is live (the
    // ended child writes nothing).
    #[rstest]
    #[case::a_live_child(Case::LiveChild, Expected::Lands)]
    #[case::an_ended_child(Case::EndedChild, Expected::Lands)]
    #[case::a_child_corrected_once(Case::CorrectedChild, Expected::Refused)]
    #[case::a_lead_run(Case::LeadRun, Expected::Refused)]
    #[case::a_parent_in_another_session(Case::OtherSessionParent, Expected::Refused)]
    #[case::no_parent_run(Case::UnknownParent, Expected::Refused)]
    #[case::the_run_itself(Case::ItselfParent, Expected::Refused)]
    #[case::a_run_below(Case::BelowParent, Expected::Refused)]
    #[case::no_run(Case::UnknownRun, Expected::NotFound)]
    #[tokio::test]
    async fn a_correction_lands_once_on_a_child_under_a_run_of_its_session(
        #[case] case: Case,
        #[case] expected: Expected,
    ) {
        let fixture = Fixture::new().await;
        let (run_id, parent_run_id) = match case {
            Case::LiveChild | Case::EndedChild => (fixture.child, fixture.caller),
            Case::CorrectedChild => {
                fixture
                    .engine
                    .correct_parent_run(fixture.child, fixture.caller)
                    .await
                    .expect("the first correction lands");
                (fixture.child, fixture.lead)
            }
            Case::LeadRun => (fixture.lead, fixture.caller),
            Case::OtherSessionParent => (fixture.child, fixture.other_session_lead),
            Case::UnknownParent => (fixture.child, new_run_id()),
            Case::ItselfParent => (fixture.child, fixture.child),
            Case::BelowParent => (fixture.child, fixture.grandchild),
            Case::UnknownRun => (new_run_id(), fixture.caller),
        };
        if matches!(case, Case::EndedChild) {
            fixture.end(&fixture.child);
        }
        let events_before = fixture.event_count();
        let parent_before = parent_of(&fixture.database, &fixture.child);
        let lead_parent_before = parent_of(&fixture.database, &fixture.lead);

        let corrected = fixture
            .engine
            .correct_parent_run(run_id, parent_run_id)
            .await;

        match expected {
            Expected::Lands => {
                let event_id = corrected.expect("the correction lands");
                assert_eq!(fixture.event_count(), events_before + 1);
                assert_eq!(
                    fixture.last_event(),
                    (
                        event_id.as_str().to_owned(),
                        "agent.run.parentCorrected".to_owned()
                    )
                );
                assert_eq!(
                    parent_of(&fixture.database, &run_id).as_deref(),
                    Some(parent_run_id.text().as_str())
                );
            }
            Expected::Refused => {
                match corrected {
                    Err(RunEngineError::Append(error)) => {
                        assert_eq!(error.refused_statement_index(), Some(0), "{error:?}");
                    }
                    other => panic!("the guard refuses the correction: {other:?}"),
                }
                assert_eq!(fixture.event_count(), events_before, "nothing is written");
            }
            Expected::NotFound => {
                assert!(
                    matches!(
                        corrected,
                        Err(RunEngineError::Refused(RunRefusal::NotFound { run_id: missing }))
                            if missing == run_id
                    ),
                    "{corrected:?}"
                );
                assert_eq!(fixture.event_count(), events_before, "nothing is written");
            }
        }
        if expected != Expected::Lands {
            assert_eq!(parent_of(&fixture.database, &fixture.child), parent_before);
            assert_eq!(
                parent_of(&fixture.database, &fixture.lead),
                lead_parent_before
            );
        }
    }

    // Killed by the fold's arm dropped, or by its type left out of the types the fold reads: the
    // rebuilt row then names the run's first parent.
    #[tokio::test]
    async fn a_rebuild_of_the_runs_gives_the_corrected_parent() {
        let fixture = Fixture::new().await;
        fixture
            .engine
            .correct_parent_run(fixture.child, fixture.caller)
            .await
            .expect("the correction lands");

        let event_types: Vec<&str> = RunsProjection
            .event_types()
            .iter()
            .map(|event_type| event_type.as_str())
            .collect();
        let filter = SessionEventFilter {
            event_types: Some(&event_types),
            before_sequence: None,
            is_sparse: false,
        };
        let reader = fixture.database.reader();
        let stored = SessionEventReads::new(&reader, |_: &SessionId| None)
            .read_after(&fixture.session_id, -1, -1, filter)
            .expect("the test reads the log");
        let mut statements = RunsProjection.clear_statements(&fixture.session_id);
        let mut fold = RunsProjection.fold(&fixture.session_id);
        for envelope in &stored {
            let event =
                SessionEvent::from_envelope(envelope).expect("a stored event reads as its type");
            fold.apply(envelope, &event, &mut statements)
                .expect("the event folds");
        }
        fixture
            .log
            .writer
            .write(statements)
            .await
            .expect("the rebuild writes");

        assert_eq!(
            parent_of(&fixture.database, &fixture.child).as_deref(),
            Some(fixture.caller.text().as_str())
        );
        assert_eq!(
            parent_of(&fixture.database, &fixture.grandchild).as_deref(),
            Some(fixture.child.text().as_str())
        );
    }
}
