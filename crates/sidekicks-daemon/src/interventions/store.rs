//! The `interventions` row: the statements that write it, each guarded so a write decided from a
//! stale read is refused whole, and the read of a row saved under a reused idempotency key.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::provider::driver::intervention::InterventionType;
use sidekicks_contracts::provider::driver::length_limits::{
    DRIVER_FAILURE_DETAIL_MAX_LEN, DRIVER_FALLBACK_ACTION_MAX_LEN,
};
use sidekicks_contracts::provider::driver::methods::DRIVER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::run::control::{InterventionId, InterventionState};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use crate::database::stored_column::{
    closed_word, closed_word_text, optional_text_column, text_column,
};

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
        reason: FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>,
    },
    /// `accepted` to `failed`, with what its dispatch threw.
    Fail {
        /// The thrown error's code, else its message.
        reason: FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>,
    },
    /// To `applied`.
    Apply {
        /// The state it leaves.
        from: UnresolvedInterventionState,
    },
    /// `accepted` to `degraded`, with the fallback taken where the driver named one.
    Degrade {
        /// The fallback taken.
        fallback_action: Option<FreeFormText<DRIVER_FALLBACK_ACTION_MAX_LEN>>,
    },
}

/// An intervention as saved, read back for a request that reused its idempotency key.
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
    pub(crate) rejection_reason: Option<FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>>,
    /// What its dispatch threw, on a failed row.
    pub(crate) failure_reason: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
}

// Changes no row when the key was already spent on this run, so the write that carries it is
// refused and nothing saved is replaced.
static INSERT_REQUESTED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO interventions
    (id, target_run_id, type, state, payload, expected_run_version, client_idempotency_key,
     device_id, created_at)
  VALUES (@id, @target_run_id, @type, 'requested', @payload, @expected_run_version,
          @client_idempotency_key, @device_id, {DATABASE_NOW_SQL})
  ON CONFLICT (target_run_id, client_idempotency_key) DO NOTHING"
    )
});

static MOVE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE interventions
    SET state = @to,
        rejection_reason = @rejection_reason,
        failure_reason = @failure_reason,
        fallback_action = @fallback_action,
        resolved_at = CASE WHEN @to = 'accepted' THEN NULL ELSE {DATABASE_NOW_SQL} END
  WHERE id = @id
    AND state = @from"
    )
});

const RUN_AT_VERSION_SQL: &str = "SELECT 1 FROM runs
  WHERE run_id = @run_id
    AND run_version = @run_version";

const RUN_IN_STATES_SQL: &str = "SELECT 1 FROM runs
  WHERE run_id = @run_id
    AND state IN (SELECT value FROM json_each(@states))";

const SELECT_BY_IDEMPOTENCY_KEY_SQL: &str =
    "SELECT id, type, state, payload, rejection_reason, failure_reason FROM interventions
  WHERE target_run_id = @target_run_id AND client_idempotency_key = @client_idempotency_key";

/// The statement that records a new intervention, refused when its key is already spent.
pub(crate) fn insert_requested_intervention_statement(
    intervention: &RequestedIntervention,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_REQUESTED_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", intervention.intervention_id.as_str()),
            text_binding("@target_run_id", intervention.target_run_id.as_str()),
            (
                Cow::Borrowed("@type"),
                Value::Text(closed_word_text(&intervention.intervention_type)),
            ),
            text_binding("@payload", &intervention.payload),
            (
                Cow::Borrowed("@expected_run_version"),
                Value::Integer(
                    i64::try_from(intervention.expected_run_version.get())
                        .expect("a safe integer fits SQLite's INTEGER"),
                ),
            ),
            text_binding(
                "@client_idempotency_key",
                intervention.client_idempotency_key.as_str(),
            ),
            (
                Cow::Borrowed("@device_id"),
                optional_text_value(intervention.device_id.as_ref().map(DeviceId::as_str)),
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
            text_binding("@id", intervention_id.as_str()),
            (Cow::Borrowed("@from"), Value::Text(closed_word_text(&from))),
            (Cow::Borrowed("@to"), Value::Text(closed_word_text(&to))),
            (
                Cow::Borrowed("@rejection_reason"),
                optional_text_value(rejection_reason),
            ),
            (
                Cow::Borrowed("@failure_reason"),
                optional_text_value(failure_reason),
            ),
            (
                Cow::Borrowed("@fallback_action"),
                optional_text_value(fallback_action),
            ),
        ]),
        expected_row_count: Some(1),
    }
}

/// A guard that refuses its write unless the run is still at `run_version`.
pub(crate) fn run_at_version_statement(run_id: &RunId, run_version: i64) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RUN_AT_VERSION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.as_str()),
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
            text_binding("@run_id", run_id.as_str()),
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
                "@target_run_id": target_run_id.as_str(),
                "@client_idempotency_key": client_idempotency_key.as_str(),
            },
            |row| {
                Ok(SavedIntervention {
                    intervention_id: text_column(row, 0, InterventionId::new)?,
                    intervention_type: text_column(row, 1, closed_word)?,
                    state: text_column(row, 2, closed_word)?,
                    payload: row.get(3)?,
                    rejection_reason: optional_text_column(row, 4, FreeFormText::new)?,
                    failure_reason: optional_text_column(row, 5, FreeFormText::new)?,
                })
            },
        )
        .optional()
}

fn optional_text_value(text: Option<&str>) -> Value {
    text.map_or(Value::Null, |text| Value::Text(text.to_owned()))
}
