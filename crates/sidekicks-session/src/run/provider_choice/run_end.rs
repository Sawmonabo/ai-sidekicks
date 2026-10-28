//! The choices a run's end lets go: each choice the provider asked and no answer settled is
//! settled in the write that ends the run, by the held answer a report showed the provider took or
//! else with none, and a run that ended with one still open, because its request committed after
//! the end had read them, is settled once it reads ended.

use std::sync::LazyLock;

use rusqlite::Connection;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{
    AgentRunRefusalChoiceResolvedPayload, AgentRunUsageCreditsChoiceResolvedPayload,
    RunRefusalChoiceSettlement, RunRefusalChoiceUnanswered, RunUsageCreditsChoiceSettlement,
    RunUsageCreditsChoiceUnanswered,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::session_scope::SessionScopedSql;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};

use super::held::MovedAnswer;
use super::{ChoiceDialog, is_settled_since, latest_request, settlement_guard};
use crate::run::engine::RunEngineError;
use crate::run::read::{RunStateReader, SessionRun, session_run_of_row};
use crate::run::state_change::refused_statement_index;
use crate::run::transitions::RUN_TERMINAL_STATES_SQL;

// Every ended run holding a choice requested and never settled, with its session: a request with
// no settlement of its kind after it.
static SELECT_ENDED_RUNS_WITH_OPEN_CHOICES_SQL: LazyLock<SessionScopedSql> = LazyLock::new(|| {
    let [refusal, usage_credits] =
        [ChoiceDialog::Refusal, ChoiceDialog::UsageCredits].map(|dialog| {
            (
                dialog.requested_type().as_str(),
                dialog.resolved_type().as_str(),
            )
        });
    SessionScopedSql::new("runs.session_id", |session_condition| {
        format!(
            "SELECT DISTINCT runs.run_id, runs.session_id
  FROM runs JOIN session_events AS requested ON requested.run_id = runs.run_id
  WHERE runs.state IN ({terminal_states})
    AND requested.type IN ('{refusal_requested}', '{usage_credits_requested}')
    AND NOT EXISTS (
      SELECT 1 FROM session_events AS resolved
       WHERE resolved.session_id = requested.session_id
         AND resolved.type = CASE requested.type
               WHEN '{refusal_requested}' THEN '{refusal_resolved}'
               ELSE '{usage_credits_resolved}' END
         AND resolved.run_id = requested.run_id
         AND resolved.sequence > requested.sequence)
    {session_condition}",
            terminal_states = *RUN_TERMINAL_STATES_SQL,
            refusal_requested = refusal.0,
            refusal_resolved = refusal.1,
            usage_credits_requested = usage_credits.0,
            usage_credits_resolved = usage_credits.1,
        )
    })
});

/// The settle of one choice a run's end let go: the guard that no settlement followed its request
/// since it was read, and the settlement's event.
pub(crate) struct OpenChoiceSettlement {
    /// Refuses the write once a settlement followed the request.
    pub(crate) guard: WriteStatement,
    /// The `*.resolved` event that settles it.
    pub(crate) event: SessionEventDraft,
}

/// The settle of each choice of `run_id`, a run of `session_id`, still unsettled when the run ends
/// in `end`, read on `reader`, but those in `settled`, which the end's own write settles: `moved`'s
/// settlement for the request it answered, else `canceled` and `interrupted` for an interrupted
/// end and `runEnded` for any other. Fails when the read fails or an event breaks a check of its
/// type.
pub(crate) fn read_open_choice_settlements(
    reader: &Connection,
    session_id: SessionId,
    run_id: RunId,
    end: RunState,
    settled: &[ChoiceDialog],
    moved: Option<&MovedAnswer>,
) -> Result<Vec<OpenChoiceSettlement>, RunEngineError> {
    let is_interrupted = end == RunState::Interrupted;
    let mut settlements = Vec::new();
    for dialog in [ChoiceDialog::Refusal, ChoiceDialog::UsageCredits] {
        if settled.contains(&dialog) {
            continue;
        }
        let Some(pending) = latest_request(reader, session_id, run_id, dialog)? else {
            continue;
        };
        if is_settled_since(reader, session_id, run_id, dialog, &pending)? {
            continue;
        }
        let moved_settlement = moved
            .filter(|moved| moved.dialog == dialog && moved.requested_sequence == pending.sequence);
        let event = match (moved_settlement, dialog) {
            (Some(moved), _) => moved.settlement.clone(),
            (None, ChoiceDialog::Refusal) => {
                SessionEvent::AgentRunRefusalChoiceResolved(AgentRunRefusalChoiceResolvedPayload {
                    session_id,
                    run_id,
                    choice: RunRefusalChoiceSettlement::Unanswered(if is_interrupted {
                        RunRefusalChoiceUnanswered::Canceled
                    } else {
                        RunRefusalChoiceUnanswered::RunEnded
                    }),
                    device_id: None,
                })
            }
            (None, ChoiceDialog::UsageCredits) => SessionEvent::AgentRunUsageCreditsChoiceResolved(
                AgentRunUsageCreditsChoiceResolvedPayload {
                    session_id,
                    run_id,
                    choice: RunUsageCreditsChoiceSettlement::Unanswered(if is_interrupted {
                        RunUsageCreditsChoiceUnanswered::Interrupted
                    } else {
                        RunUsageCreditsChoiceUnanswered::RunEnded
                    }),
                    device_id: None,
                },
            ),
        };
        settlements.push(OpenChoiceSettlement {
            guard: settlement_guard(session_id, run_id, dialog, &pending),
            event: SessionEventDraft::of_session(session_id, &event)?,
        });
    }
    Ok(settlements)
}

/// Settles each choice `run_id` still holds unsettled once it reads ended, in one write through
/// `appender`, read again once when one was settled since its read: for a request that committed
/// after the run's end had read its open choices. A run still live is left to its own end. Fails
/// as the reads or the write fail.
pub async fn settle_open_choices_of_ended_run(
    pool: &DatabaseReadPool,
    appender: &SessionEventAppender,
    run_id: RunId,
) -> Result<(), RunEngineError> {
    let mut is_read_again = false;
    loop {
        let settlements = pool
            .read(ReadLength::Short, move |reader| {
                let Some(run) = RunStateReader::new(reader)
                    .read_run(&run_id)?
                    .filter(|run| run.state.is_terminal())
                else {
                    return Ok::<_, RunEngineError>(Vec::new());
                };
                read_open_choice_settlements(reader, run.session_id, run_id, run.state, &[], None)
            })
            .await?;
        let (guards, mut events): (Vec<_>, Vec<_>) = settlements
            .into_iter()
            .map(|settlement| (settlement.guard, settlement.event))
            .unzip();
        let Some(last) = events.pop() else {
            return Ok(());
        };
        let linkage = SessionEventLinkage {
            transactional_prelude: guards,
            preceding_events: events,
            ..SessionEventLinkage::default()
        };
        match appender.append(last, linkage).await {
            Ok(_receipt) => return Ok(()),
            Err(error) if refused_statement_index(&error).is_some() && !is_read_again => {
                is_read_again = true;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

/// The runs of `session_id`, or of every session when it is `None`, that have ended while a choice
/// their provider asked is still unsettled, read on `reader`: one whose request committed after
/// the run's end had read its open choices. Fails when the read fails or a stored id is not one.
pub fn read_ended_runs_with_open_choices(
    reader: &Connection,
    session_id: Option<&SessionId>,
) -> rusqlite::Result<Vec<SessionRun>> {
    SELECT_ENDED_RUNS_WITH_OPEN_CHOICES_SQL.query(reader, session_id, session_run_of_row)
}
