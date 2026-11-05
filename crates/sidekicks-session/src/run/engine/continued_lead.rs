//! A lead a person's continue moved to `running` while the daemon's restart held it, moved back to
//! `paused` once the continue that was to carry it failed: each of the session's leads that reads
//! `running` with no turn open and no stop, the move guarded in its write on the state and the
//! turns, so a lead that moved on or opened a turn since is left as it is, and a stopping lead is
//! left to its stop.

use std::error::Error;
use std::sync::{Arc, LazyLock};

use rusqlite::named_params;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::stored_column::text_column;

use crate::run::engine::RunEngine;
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::turns::guards::{no_open_turn_statement, open_turns_sql};
use crate::run::restart::run_has_own_stop_sql;
use crate::run::state_change::{RunStateChange, RunWriteCompanions};

// A session's leads that read `running` with no started turn left without an end and no stop that
// settles them.
static SELECT_CONTINUED_LEADS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT runs.run_id FROM runs
  WHERE runs.session_id = @session_id
    AND runs.parent_run_id IS NULL
    AND runs.state = @running
    AND NOT EXISTS ({})
    AND NOT {}
  ORDER BY runs.rowid",
        open_turns_sql("runs.run_id", "LIMIT 1"),
        run_has_own_stop_sql("runs.run_id")
    )
});

impl RunEngine {
    /// Moves each lead of `session_id` that reads `running` with no turn open and no stop back to
    /// `paused`, the write refused for a lead that left `running` or opened a turn since, and
    /// answers the leads it moved. A lead whose move fails is logged and left out. Fails as the
    /// listing fails.
    pub async fn pause_continued_leads(
        self: &Arc<Self>,
        session_id: SessionId,
    ) -> Result<Vec<RunId>, RunEngineError> {
        let leads = self.list_continued_leads(session_id).await?;
        let mut paused = Vec::with_capacity(leads.len());
        for run_id in leads {
            match self.pause_continued_lead(run_id).await {
                Ok(()) => paused.push(run_id),
                Err(error) => tracing::warn!(
                    run_id = %run_id,
                    error = &error as &(dyn Error + 'static),
                    "a continued lead was not moved back to paused"
                ),
            }
        }
        Ok(paused)
    }

    // The leads of `session_id` that read `running` with no turn open and no stop, oldest first.
    async fn list_continued_leads(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<RunId>, RunEngineError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                let session_text = session_id.text();
                let running: &str = RunState::Running.into();
                let leads = reader
                    .prepare_cached(&SELECT_CONTINUED_LEADS_SQL)?
                    .query_map(
                        named_params! {
                            "@session_id": session_text.as_str(),
                            "@running": running,
                        },
                        |row| text_column(row, 0, |text| RunId::new(&text)),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok::<_, RunEngineError>(leads)
            })
            .await
    }

    // Moves `run_id` from `running` to `paused`, refused once it left `running` or opened a turn.
    async fn pause_continued_lead(self: &Arc<Self>, run_id: RunId) -> Result<(), RunEngineError> {
        let back_to_paused = RunStateChange {
            expected_state: Some(RunState::Running),
            ..RunStateChange::new(run_id, RunStateEntry::Paused)
        };
        let companions = RunWriteCompanions {
            statements: vec![no_open_turn_statement(&run_id)],
            ..RunWriteCompanions::default()
        };
        self.transition(back_to_paused, companions).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_store::database::statement::DATABASE_NOW_SQL;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::log_service::test_fixture::open_log;

    use crate::questions::schema::schema_parts;
    use crate::run::engine::test_fixture::{
        append, insert_run, is_run_stopping, stored_run_state, test_engine,
    };
    use crate::run::engine::tests::turn_started_at;

    // Two running leads with no turn open, one of them with the person's interrupt pending: the
    // plain lead moves back to `paused`, the stopping one, as the restart's stop read reads it,
    // stays `running` for its stop to settle. Killed by the listing's stop clause dropped, which
    // pauses the stopping lead too.
    #[tokio::test]
    async fn a_stopping_lead_stays_running() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let stopping_lead = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let lead = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_run(&database, session_id, stopping_lead, "running");
        insert_run(&database, session_id, lead, "running");
        database
            .reader()
            .execute(
                &format!(
                    "INSERT INTO interventions (id, target_run_id, type, state, payload,
                       expected_run_version, client_idempotency_key, created_at)
                     VALUES (?1, ?2, 'interrupt', 'accepted', ?3, 1, ?1, {DATABASE_NOW_SQL})"
                ),
                params![
                    mint_uuid_v7().to_string(),
                    stopping_lead.text().as_str(),
                    r#"{"pending":"nextTurn"}"#,
                ],
            )
            .expect("the test records the person's interrupt");
        assert!(is_run_stopping(&database, &stopping_lead));
        assert!(!is_run_stopping(&database, &lead));
        let engine = test_engine(&database, log.service, home.path());

        let paused = engine
            .pause_continued_leads(session_id)
            .await
            .expect("the leads are listed");

        assert_eq!(paused, [lead]);
        assert_eq!(stored_run_state(&database, &lead).0, "paused");
        assert_eq!(
            stored_run_state(&database, &stopping_lead),
            ("running".to_owned(), 1)
        );
    }

    // A lead listed with no turn open that opens one before its write: the write is refused and
    // the lead stays `running`. Killed by the no-open-turn statement dropped from the write's
    // companions, which pauses the lead mid-turn.
    #[tokio::test]
    async fn a_lead_that_opens_a_turn_after_the_listing_stays_running() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let lead = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_run(&database, session_id, lead, "running");
        let engine = test_engine(&database, log.service, home.path());

        let listed = engine
            .list_continued_leads(session_id)
            .await
            .expect("the leads are listed");
        assert_eq!(listed, [lead]);
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, lead, 1, 1),
        )
        .await;
        engine
            .pause_continued_lead(lead)
            .await
            .expect_err("a lead with a turn open is not paused");

        assert_eq!(
            stored_run_state(&database, &lead),
            ("running".to_owned(), 1)
        );
    }
}
