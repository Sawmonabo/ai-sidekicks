//! A lead a person's continue moved to `running` while the daemon's restart held it, moved back to
//! `paused` once the continue that was to carry it failed: each of the session's leads that reads
//! `running` with no turn open, the move guarded in its write on both, so a lead that moved on or
//! opened a turn since is left as it is.

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
use crate::run::state_change::{RunStateChange, RunWriteCompanions};

// A session's leads that read `running` with no started turn left without an end.
static SELECT_CONTINUED_LEADS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT runs.run_id FROM runs
  WHERE runs.session_id = @session_id
    AND runs.parent_run_id IS NULL
    AND runs.state = @running
    AND NOT EXISTS ({})
  ORDER BY runs.rowid",
        open_turns_sql("runs.run_id", "LIMIT 1")
    )
});

impl RunEngine {
    /// Moves each lead of `session_id` that reads `running` with no turn open back to `paused`,
    /// the write refused for a lead that left `running` or opened a turn since, and answers the
    /// leads it moved. A lead whose move fails is logged and left out. Fails as the listing fails.
    pub async fn pause_continued_leads(
        self: &Arc<Self>,
        session_id: SessionId,
    ) -> Result<Vec<RunId>, RunEngineError> {
        let leads = self
            .pool
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
            .await?;
        let mut paused = Vec::with_capacity(leads.len());
        for run_id in leads {
            let back_to_paused = RunStateChange {
                expected_state: Some(RunState::Running),
                ..RunStateChange::new(run_id, RunStateEntry::Paused)
            };
            let companions = RunWriteCompanions {
                statements: vec![no_open_turn_statement(&run_id)],
                ..RunWriteCompanions::default()
            };
            match self.transition(back_to_paused, companions).await {
                Ok(_) => paused.push(run_id),
                Err(error) => tracing::warn!(
                    run_id = %run_id,
                    error = &error as &(dyn Error + 'static),
                    "a continued lead was not moved back to paused"
                ),
            }
        }
        Ok(paused)
    }
}
