//! The `interventions` row: the statements that write it, each guarded so a write decided from a
//! stale read is refused whole, the read of a row by its id or saved under a reused idempotency
//! key, the read of whether a limit's interrupt of a run is pending, the settle at start of a
//! faster-model retry a restart left with no outcome, and the record of an interrupt whose queue
//! hold's release failed to settle the run's waiting messages.

use std::borrow::Cow;
use std::str::FromStr as _;
use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::length_limits::{
    PROVIDER_FAILURE_DETAIL_MAX_LEN, PROVIDER_FALLBACK_ACTION_MAX_LEN,
};
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::run::events::{
    AgentInterventionExpiredPayload, AgentInterventionExpiredState, AgentInterventionFailedPayload,
    AgentInterventionFailedState, DaemonInterventionActor, InterventionActor,
    InterventionDeviceActor,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterventionId, InterventionState, InterventionType, RunLimit,
};
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, UuidText};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::stored_column::{closed_word, optional_text_column, text_column};
use crate::events::session::appender::{SessionEventDraft, SessionEventDraftError};
use crate::interventions::interrupt_queue::InterruptChoice;
use crate::provider::driver::run_control::InterruptPendingChoice;

/// A new intervention as its `requested` row records it; `payload` is its type's own fields, as
/// JSON text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RequestedIntervention {
    /// The intervention.
    pub(crate) intervention_id: InterventionId,
    /// The run it acts on.
    pub(crate) target_run_id: RunId,
    /// What it does.
    pub(crate) intervention_type: InterventionType,
    /// Its type's own fields, as JSON text.
    pub(crate) payload: String,
    /// The run version the request was decided against.
    pub(crate) expected_run_version: SafeInt<0>,
    /// The requester's key, which a retry reuses.
    pub(crate) client_idempotency_key: ClientUuid,
    /// The device a person's request came from; `None` on the daemon's own.
    pub(crate) device_id: Option<DeviceId>,
}

/// The states an intervention moves out of: the two before its outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UnresolvedInterventionState {
    /// Asked for.
    Requested,
    /// Taken by the daemon.
    Accepted,
}

impl From<UnresolvedInterventionState> for InterventionState {
    fn from(state: UnresolvedInterventionState) -> Self {
        match state {
            UnresolvedInterventionState::Requested => Self::Requested,
            UnresolvedInterventionState::Accepted => Self::Accepted,
        }
    }
}

/// An intervention state past its outcome, which no move leaves.
#[derive(Debug, thiserror::Error)]
#[error("an intervention in {} has an outcome", <&'static str>::from(*.0))]
pub(crate) struct InterventionResolvedError(InterventionState);

impl TryFrom<InterventionState> for UnresolvedInterventionState {
    type Error = InterventionResolvedError;

    fn try_from(state: InterventionState) -> Result<Self, Self::Error> {
        match state {
            InterventionState::Requested => Ok(Self::Requested),
            InterventionState::Accepted => Ok(Self::Accepted),
            InterventionState::Applied
            | InterventionState::Rejected
            | InterventionState::Degraded
            | InterventionState::Expired
            | InterventionState::Failed => Err(InterventionResolvedError(state)),
        }
    }
}

/// Why a stored state is not one an intervention leaves.
#[derive(Debug, thiserror::Error)]
pub(crate) enum UnresolvedStateError {
    /// The stored word is no intervention state.
    #[error("the stored state is not an intervention state")]
    Unreadable(#[source] serde_json::Error),
    /// The state is an outcome.
    #[error(transparent)]
    Resolved(InterventionResolvedError),
}

/// The stored state word `text` of a row a read selected for having no outcome yet; any other
/// state fails it, as a broken row.
pub(crate) fn unresolved_state_of(
    text: String,
) -> Result<UnresolvedInterventionState, UnresolvedStateError> {
    closed_word::<InterventionState>(text)
        .map_err(UnresolvedStateError::Unreadable)
        .and_then(|state| {
            UnresolvedInterventionState::try_from(state).map_err(UnresolvedStateError::Resolved)
        })
}

/// Who an intervention is from, read from its stored device: the device a person's came from, or
/// the daemon for its own, which names none.
pub(crate) fn stored_actor(device: Option<InterventionDeviceActor>) -> InterventionActor {
    device.map_or(
        InterventionActor::Daemon(DaemonInterventionActor::Value),
        InterventionActor::Device,
    )
}

/// One move of an intervention's row, each arm carrying only the states it may leave. Only a
/// rejected or failed row carries a reason, and only a degraded one a fallback. A request expires
/// only before dispatch: once dispatched, the driver's verdict stands. Only a restart that ends the
/// run for a stop still pending moves a `requested` row to `applied`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum InterventionTransition {
    /// `requested` to `accepted`.
    Accept,
    /// To `expired`.
    Expire {
        /// The state it leaves.
        from: UnresolvedInterventionState,
    },
    /// To `rejected`, with why.
    Reject {
        /// The state it leaves.
        from: UnresolvedInterventionState,
        /// The machine-readable cause.
        reason: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
    },
    /// `accepted` to `failed`: its dispatch threw, never completed (a daemon death among them), or
    /// was never sent because the run ended and was continued before it.
    Fail {
        /// The thrown error's code, else its message, or why it never completed or was never
        /// sent.
        reason: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    },
    /// To `applied`.
    Apply {
        /// The state it leaves.
        from: UnresolvedInterventionState,
    },
    /// `accepted` to `degraded`, with the fallback taken where the driver named one.
    Degrade {
        /// The fallback taken.
        fallback_action: Option<FreeFormText<PROVIDER_FALLBACK_ACTION_MAX_LEN>>,
    },
}

/// An intervention as saved, read back for a request that reused its idempotency key or whose row
/// reached an outcome another write gave it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SavedIntervention {
    /// The intervention.
    pub(crate) intervention_id: InterventionId,
    /// What it does.
    pub(crate) intervention_type: InterventionType,
    /// Where it stands.
    pub(crate) state: InterventionState,
    /// Its type's own fields, as JSON text.
    pub(crate) payload: String,
    /// Why it was rejected, on a rejected row.
    pub(crate) rejection_reason: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// Why its dispatch threw, never completed or was never sent, on a failed row.
    pub(crate) failure_reason: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
}

// Changes no row when the key was already spent on this run, so the write that carries it is
// refused and nothing saved is replaced.
static INSERT_REQUESTED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO interventions
    (id, target_run_id, type, state, payload, expected_run_version, client_idempotency_key,
     device_id, created_at)
  VALUES (@id, @target_run_id, @type, '{}', @payload, @expected_run_version,
          @client_idempotency_key, @device_id, {DATABASE_NOW_SQL})
  ON CONFLICT (target_run_id, client_idempotency_key) DO NOTHING",
        <&'static str>::from(InterventionState::Requested)
    )
});

static MOVE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE interventions
    SET state = @to,
        rejection_reason = @rejection_reason,
        failure_reason = @failure_reason,
        fallback_action = @fallback_action,
        resolved_at = CASE WHEN @to = '{}' THEN NULL ELSE {DATABASE_NOW_SQL} END
  WHERE id = @id
    AND state = @from",
        <&'static str>::from(InterventionState::Accepted)
    )
});

const RUN_AT_VERSION_SQL: &str = "SELECT 1 FROM runs
  WHERE run_id = @run_id
    AND run_version = @run_version";

const RUN_IN_STATES_SQL: &str = "SELECT 1 FROM runs
  WHERE run_id = @run_id
    AND state IN (SELECT value FROM json_each(@states))";

// An interrupt of the run at one limit that has no outcome yet.
static PENDING_LIMIT_INTERRUPT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM interventions
   WHERE target_run_id = @run_id
     AND type = '{}'
     AND state IN ('{}', '{}')
     AND json_extract(payload, '$.limit') = @limit
   LIMIT 1",
        <&'static str>::from(InterventionType::Interrupt),
        <&'static str>::from(InterventionState::Requested),
        <&'static str>::from(InterventionState::Accepted)
    )
});

static SELECT_LIMIT_INTERRUPT_PENDING_SQL: LazyLock<String> =
    LazyLock::new(|| format!("SELECT EXISTS ({})", *PENDING_LIMIT_INTERRUPT_SQL));

// Every faster-model retry with no outcome yet, with its run's session, read through the partial
// index on pending states, oldest first.
static SELECT_PENDING_RETRIES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT interventions.id, interventions.target_run_id, interventions.state,
       interventions.device_id, runs.session_id
  FROM interventions JOIN runs ON runs.run_id = interventions.target_run_id
  WHERE interventions.type = '{}'
    AND interventions.state IN ('{}', '{}')
  ORDER BY interventions.created_at, interventions.id",
        <&'static str>::from(InterventionType::FasterModelRetry),
        <&'static str>::from(InterventionState::Requested),
        <&'static str>::from(InterventionState::Accepted)
    )
});

// The reason an accepted retry records when the daemon went down before its outcome.
static RETRY_LOST_TO_RESTART: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new(
            "The background service restarted before the retry's outcome was known".to_owned(),
        )
        .expect("the reason is non-blank and within the cap")
    });

const SELECT_BY_IDEMPOTENCY_KEY_SQL: &str =
    "SELECT id, type, state, payload, rejection_reason, failure_reason FROM interventions
  WHERE target_run_id = @target_run_id AND client_idempotency_key = @client_idempotency_key";

const SELECT_BY_ID_SQL: &str =
    "SELECT id, type, state, payload, rejection_reason, failure_reason FROM interventions
  WHERE id = @id";

/// The statement that records a new intervention, refused when its key is already spent.
pub(crate) fn insert_requested_intervention_statement(
    intervention: &RequestedIntervention,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_REQUESTED_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", intervention.intervention_id.text().as_str()),
            text_binding("@target_run_id", intervention.target_run_id.text().as_str()),
            text_binding(
                "@type",
                <&'static str>::from(intervention.intervention_type),
            ),
            text_binding("@payload", &intervention.payload),
            (
                Cow::Borrowed("@expected_run_version"),
                Value::Integer(i64::from(intervention.expected_run_version)),
            ),
            text_binding(
                "@client_idempotency_key",
                intervention.client_idempotency_key.as_str(),
            ),
            nullable_text_binding(
                "@device_id",
                intervention.device_id.as_ref().map(DeviceId::as_str),
            ),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that moves an intervention's row, refused unless the row is still in the state
/// `transition` leaves. Every move but the one to `accepted` is an outcome and stamps when it was
/// reached.
pub(crate) fn move_intervention_statement(
    intervention_id: &InterventionId,
    transition: &InterventionTransition,
) -> WriteStatement {
    let mut rejection_reason = None;
    let mut failure_reason = None;
    let mut fallback_action = None;
    let (from, to) = match transition {
        InterventionTransition::Accept => {
            (InterventionState::Requested, InterventionState::Accepted)
        }
        InterventionTransition::Expire { from } => ((*from).into(), InterventionState::Expired),
        InterventionTransition::Reject { from, reason } => {
            rejection_reason = Some(reason.as_str());
            ((*from).into(), InterventionState::Rejected)
        }
        InterventionTransition::Fail { reason } => {
            failure_reason = Some(reason.as_str());
            (InterventionState::Accepted, InterventionState::Failed)
        }
        InterventionTransition::Apply { from } => ((*from).into(), InterventionState::Applied),
        InterventionTransition::Degrade {
            fallback_action: fallback,
        } => {
            fallback_action = fallback.as_ref().map(FreeFormText::as_str);
            (InterventionState::Accepted, InterventionState::Degraded)
        }
    };
    WriteStatement {
        sql: Cow::Borrowed(MOVE_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", intervention_id.text().as_str()),
            text_binding("@from", <&'static str>::from(from)),
            text_binding("@to", <&'static str>::from(to)),
            nullable_text_binding("@rejection_reason", rejection_reason),
            nullable_text_binding("@failure_reason", failure_reason),
            nullable_text_binding("@fallback_action", fallback_action),
        ]),
        expected_row_count: Some(1),
    }
}

/// A guard that refuses its write unless the run is still at `run_version`.
pub(crate) fn run_at_version_statement(run_id: &RunId, run_version: i64) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RUN_AT_VERSION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            (Cow::Borrowed("@run_version"), Value::Integer(run_version)),
        ]),
        expected_row_count: Some(1),
    }
}

/// A guard that refuses its write unless the run is in one of `states`.
pub(crate) fn run_in_states_statement(run_id: &RunId, states: &[RunState]) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RUN_IN_STATES_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            (
                Cow::Borrowed("@states"),
                Value::Text(
                    serde_json::to_string(states).expect("a list of run states serializes"),
                ),
            ),
        ]),
        expected_row_count: Some(1),
    }
}

/// The intervention saved on `target_run_id` under `client_idempotency_key`, if one is, read on
/// `reader`. Fails when the read fails or a stored column does not read as its type.
pub(crate) fn read_intervention_by_idempotency_key(
    reader: &Connection,
    target_run_id: &RunId,
    client_idempotency_key: &ClientUuid,
) -> rusqlite::Result<Option<SavedIntervention>> {
    reader
        .prepare_cached(SELECT_BY_IDEMPOTENCY_KEY_SQL)?
        .query_row(
            named_params! {
                "@target_run_id": target_run_id.text().as_str(),
                "@client_idempotency_key": client_idempotency_key.as_str(),
            },
            saved_intervention,
        )
        .optional()
}

/// The intervention saved as `intervention_id`, if one is, read on `reader`. Fails when the read
/// fails or a stored column does not read as its type.
pub(crate) fn read_intervention(
    reader: &Connection,
    intervention_id: &InterventionId,
) -> rusqlite::Result<Option<SavedIntervention>> {
    reader
        .prepare_cached(SELECT_BY_ID_SQL)?
        .query_row(
            named_params! { "@id": intervention_id.text().as_str() },
            saved_intervention,
        )
        .optional()
}

// A row of the saved-intervention reads.
fn saved_intervention(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedIntervention> {
    Ok(SavedIntervention {
        intervention_id: text_column(row, 0, |text| InterventionId::new(&text))?,
        intervention_type: text_column(row, 1, closed_word)?,
        state: text_column(row, 2, closed_word)?,
        payload: row.get(3)?,
        rejection_reason: optional_text_column(row, 4, FreeFormText::new)?,
        failure_reason: optional_text_column(row, 5, FreeFormText::new)?,
    })
}

/// A guard that refuses its write while an interrupt of `run_id` at `limit` is `requested` or
/// `accepted`, so one limit's interrupt of a run is pending once at a time.
pub(crate) fn no_pending_limit_interrupt_statement(
    run_id: &RunId,
    limit: RunLimit,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(PENDING_LIMIT_INTERRUPT_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            text_binding("@limit", <&'static str>::from(limit)),
        ]),
        expected_row_count: Some(0),
    }
}

/// Whether an interrupt of `run_id` at `limit` is `requested` or `accepted`, read on `reader`.
/// Fails as the read fails.
pub(crate) fn is_limit_interrupt_pending(
    reader: &Connection,
    run_id: &RunId,
    limit: RunLimit,
) -> rusqlite::Result<bool> {
    reader
        .prepare_cached(&SELECT_LIMIT_INTERRUPT_PENDING_SQL)?
        .query_row(
            named_params! {
                "@run_id": run_id.text().as_str(),
                "@limit": <&'static str>::from(limit),
            },
            |row| row.get(0),
        )
}

/// A faster-model retry a restart found with no outcome yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingRetry {
    /// The retry.
    pub(crate) intervention_id: InterventionId,
    /// The run it retries.
    pub(crate) target_run_id: RunId,
    /// The run's session.
    pub(crate) session_id: SessionId,
    /// Where it stands.
    pub(crate) state: UnresolvedInterventionState,
    /// Who it is from.
    pub(crate) actor: InterventionActor,
}

/// The one write that settles a pending retry: its row's move and the move's event.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's recovery pass at start")
)]
pub(crate) struct RetrySettlement {
    /// The row's move, refused unless the row is still in the state it was read in.
    pub(crate) statement: WriteStatement,
    /// The move's `agent.intervention.*` event.
    pub(crate) event: SessionEventDraft,
}

/// Every faster-model retry with no outcome yet, read on `reader` by the daemon's recovery pass at
/// start. Fails when the read fails or a stored column does not read as its type.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's recovery pass at start")
)]
pub(crate) fn read_pending_retries(reader: &Connection) -> rusqlite::Result<Vec<PendingRetry>> {
    reader
        .prepare_cached(&SELECT_PENDING_RETRIES_SQL)?
        .query_map([], |row| {
            Ok(PendingRetry {
                intervention_id: text_column(row, 0, |text| InterventionId::new(&text))?,
                target_run_id: text_column(row, 1, |text| RunId::new(&text))?,
                state: text_column(row, 2, unresolved_state_of)?,
                actor: stored_actor(optional_text_column(
                    row,
                    3,
                    closed_word::<InterventionDeviceActor>,
                )?),
                session_id: text_column(row, 4, |text| SessionId::new(&text))?,
            })
        })?
        .collect()
}

/// The write that settles `retry` for the daemon's recovery pass at start, the provider process
/// that held its turn having ended with the daemon: a `requested` retry was never sent, so it
/// expires; an `accepted` one fails, its outcome lost with the daemon. Fails when the event breaks
/// a check of its type.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's recovery pass at start")
)]
pub(crate) fn settle_retry_after_restart(
    retry: &PendingRetry,
) -> Result<RetrySettlement, SessionEventDraftError> {
    let PendingRetry {
        intervention_id,
        target_run_id,
        session_id,
        state,
        actor,
    } = retry.clone();
    let (transition, event) = match state {
        UnresolvedInterventionState::Requested => (
            InterventionTransition::Expire { from: state },
            SessionEvent::AgentInterventionExpired(AgentInterventionExpiredPayload {
                session_id,
                intervention_id,
                target_run_id,
                intervention_type: InterventionType::FasterModelRetry,
                state: AgentInterventionExpiredState::Value,
                actor,
            }),
        ),
        UnresolvedInterventionState::Accepted => (
            InterventionTransition::Fail {
                reason: RETRY_LOST_TO_RESTART.clone(),
            },
            SessionEvent::AgentInterventionFailed(AgentInterventionFailedPayload {
                session_id,
                intervention_id,
                target_run_id,
                intervention_type: InterventionType::FasterModelRetry,
                state: AgentInterventionFailedState::Value,
                actor,
                failure_reason: RETRY_LOST_TO_RESTART.clone(),
            }),
        ),
    };
    Ok(RetrySettlement {
        statement: move_intervention_statement(&intervention_id, &transition),
        event: SessionEventDraft::of_session(session_id, &event)?,
    })
}

/// An interrupt whose queue hold went while what it held back was left unsettled: the run and the
/// person's choice for its waiting messages, which the queue settles again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct UnreleasedInterrupt {
    /// The interrupt.
    pub(crate) intervention_id: InterventionId,
    /// The run it held.
    pub(crate) run_id: RunId,
    /// The choice its release had to apply.
    pub(crate) choice: InterruptChoice,
}

const RECORD_UNRELEASED_SQL: &str = "UPDATE interventions
  SET unreleased_choice = @choice, unreleased_deliver_first = @deliver_first
  WHERE id = @id";

const CLEAR_UNRELEASED_SQL: &str = "UPDATE interventions
  SET unreleased_choice = NULL, unreleased_deliver_first = NULL
  WHERE id = @id";

// The session's unsettled releases through the partial index on them, which every hold of a
// session's queue reads and which is empty but for a release that failed, oldest first.
const SELECT_UNRELEASED_SQL: &str = "SELECT interventions.id, interventions.target_run_id,
       interventions.unreleased_choice, interventions.unreleased_deliver_first
  FROM interventions INDEXED BY idx_interventions_unreleased
    JOIN runs ON runs.run_id = interventions.target_run_id
  WHERE interventions.unreleased_choice IS NOT NULL AND runs.session_id = ?
  ORDER BY interventions.created_at, interventions.id";

const SELECT_SESSIONS_WITH_UNRELEASED_SQL: &str = "SELECT DISTINCT runs.session_id
  FROM interventions INDEXED BY idx_interventions_unreleased
    JOIN runs ON runs.run_id = interventions.target_run_id
  WHERE interventions.unreleased_choice IS NOT NULL";

/// The statement that records `choice` as left unsettled by the release of the queue hold
/// `intervention_id` took; refused when no row is saved as `intervention_id`.
pub(crate) fn record_unreleased_statement(
    intervention_id: &InterventionId,
    choice: InterruptChoice,
) -> WriteStatement {
    let deliver_first = choice.deliver_first.map(|item_id| item_id.text());
    WriteStatement {
        sql: Cow::Borrowed(RECORD_UNRELEASED_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", intervention_id.text().as_str()),
            text_binding("@choice", <&'static str>::from(choice.pending)),
            nullable_text_binding(
                "@deliver_first",
                deliver_first.as_ref().map(UuidText::as_str),
            ),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that clears what [`record_unreleased_statement`] recorded on `intervention_id`,
/// once settled; a row purged meanwhile changes nothing.
pub(crate) fn clear_unreleased_statement(intervention_id: &InterventionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(CLEAR_UNRELEASED_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@id",
            intervention_id.text().as_str(),
        )]),
        expected_row_count: None,
    }
}

/// Every interrupt of a run of `session_id` whose release left its choice unsettled, read on
/// `reader`, oldest first. Fails when the read fails or a stored column does not read as its type.
pub(crate) fn read_unreleased_interrupts(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Vec<UnreleasedInterrupt>> {
    reader
        .prepare_cached(SELECT_UNRELEASED_SQL)?
        .query_map([session_id.text().as_str()], |row| {
            Ok(UnreleasedInterrupt {
                intervention_id: text_column(row, 0, |text| InterventionId::new(&text))?,
                run_id: text_column(row, 1, |text| RunId::new(&text))?,
                choice: InterruptChoice {
                    pending: text_column(row, 2, |text| InterruptPendingChoice::from_str(&text))?,
                    deliver_first: optional_text_column(row, 3, |text| QueueItemId::new(&text))?,
                },
            })
        })?
        .collect()
}

/// Every session with an interrupt whose release left its choice unsettled, read on `reader`.
/// Fails when the read fails or a stored id does not read as its type.
pub(crate) fn read_sessions_with_unreleased_interrupts(
    reader: &Connection,
) -> rusqlite::Result<Vec<SessionId>> {
    reader
        .prepare_cached(SELECT_SESSIONS_WITH_UNRELEASED_SQL)?
        .query_map([], |row| text_column(row, 0, |text| SessionId::new(&text)))?
        .collect()
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::{read_pending_retries, settle_retry_after_restart};
    use crate::database::statement::DATABASE_NOW_SQL;
    use crate::interventions::service::tests::harness;
    use crate::provider::driver::contract::MockProviderDriver;
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    // Each pending retry moves in one write with its event: a `requested` one to `expired`, an
    // `accepted` one to `failed` with the restart as its reason. Killed by swapping the two moves
    // or dropping the reason.
    #[tokio::test]
    async fn a_retry_pending_at_start_expires_unsent_or_fails_once_sent() {
        let harness = harness(MockProviderDriver::new()).await;
        for state in ["requested", "accepted"] {
            let id = mint_uuid_v7().to_string();
            harness
                .database
                .reader()
                .execute(
                    &format!(
                        "INSERT INTO interventions (id, target_run_id, type, state, payload,
                           expected_run_version, client_idempotency_key, device_id, created_at)
                         VALUES (?1, ?2, 'fasterModelRetry', ?3, '{{}}', 1, ?1, 'device-1',
                           {DATABASE_NOW_SQL})"
                    ),
                    params![id, harness.run_id.text().as_str(), state],
                )
                .expect("the test records the pending retry");
        }

        let pending =
            read_pending_retries(&harness.database.reader()).expect("the pending retries read");
        assert_eq!(pending.len(), 2);
        for retry in &pending {
            assert_eq!(retry.session_id, harness.session_id);
            let settlement = settle_retry_after_restart(retry).expect("the settlement drafts");
            harness
                .service
                .append(settlement.event, vec![settlement.statement], Vec::new())
                .await
                .expect("the settlement is written");
        }

        let reasons: Vec<(String, Option<String>)> = harness
            .database
            .reader()
            .prepare("SELECT state, failure_reason FROM interventions ORDER BY created_at, id")
            .expect("the test reads the retries")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("the retries read")
            .collect::<Result<_, _>>()
            .expect("each retry reads");
        assert_eq!(
            reasons,
            [
                ("expired".to_owned(), None),
                (
                    "failed".to_owned(),
                    Some(
                        "The background service restarted before the retry's outcome was known"
                            .to_owned()
                    )
                ),
            ]
        );
        assert_eq!(
            harness.stored_event_types(),
            ["agent.intervention.expired", "agent.intervention.failed"]
        );
        assert_eq!(
            read_pending_retries(&harness.database.reader())
                .expect("the pending retries read")
                .len(),
            0
        );
    }
}
