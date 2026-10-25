//! The service's recovery after a restart: the state `daemon.status.read` carries as its `recovery`
//! member, the details of the refusal a write meets while the whole service cannot take one, the
//! repair of the database file and the line a person reads meanwhile, and the three events the
//! daemon's recovery pass records on its own sentinel session.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::IntoStaticStr;

use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::refusal::RefusalCode;
use crate::machine::id::MachineId;
use crate::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::recovery::RecoveryCondition;
use crate::run::control::RunFailureCategory;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;

/// Where the service stands in recovery: `rebuilding` while the restart's pass runs, `degraded`
/// while one or more sessions have damaged history, and `blocked` when the local store itself is
/// unavailable. Ordered from least to most severe.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum DaemonRecoveryState {
    /// Every session takes writes.
    Healthy,
    /// The restart's pass runs.
    Rebuilding,
    /// One or more sessions have damaged history.
    Degraded,
    /// The local store is unavailable.
    Blocked,
}

/// Where one session that is not healthy stands: `rebuilding` while the restart's pass has yet to
/// rebuild it, which a write refusal names and the status read leaves to the service's own state,
/// `degraded` when its history is damaged after a readable start, so it opens read-only at its
/// last good point, `damaged` when no event of it can be read, and `blocked` when a run of it
/// halted after the restart on a question for the person, named in its `haltedRuns`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DaemonRecoverySessionState {
    /// The restart's pass has yet to rebuild it.
    Rebuilding,
    /// Its history is damaged after a readable start.
    Degraded,
    /// No event of it can be read.
    Damaged,
    /// A run of it halted on a question for the person.
    Blocked,
}

/// One run behind a session's entry that needs the person: a halt on a diverged resume carries no
/// `failureCategory`, since the run did not fail; a failed resume carries one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonRecoveryHaltedRun {
    /// The run.
    pub run_id: RunId,
    /// What its recovery needs.
    pub recovery_condition: RecoveryCondition,
    /// Why it failed, where it did.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunFailureCategory")]
    pub failure_category: Option<RunFailureCategory>,
}

/// One session that is not healthy, and why. A `degraded` session carries its last good point:
/// the last event it opens at, that event's time, and the first event that cannot be read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonRecoverySession {
    /// The session.
    pub session_id: SessionId,
    /// Where it stands.
    pub state: DaemonRecoverySessionState,
    /// The last event sequence the session's projections reflect.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub last_applied_sequence: Option<SafeInt<0>>,
    /// When the event at `last_applied_sequence` happened.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub last_applied_at: Option<WireInstant>,
    /// The first event that cannot be read; every event from it to the head is damaged.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub damaged_from_sequence: Option<SafeInt<0>>,
    /// Why its run failed, where one did.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunFailureCategory")]
    pub failure_category: Option<RunFailureCategory>,
    /// What its recovery needs, where that is known.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RecoveryCondition")]
    pub recovery_condition: Option<RecoveryCondition>,
    /// The runs that need the person, each once; absent when no run does.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<DaemonRecoveryHaltedRun>")]
    pub halted_runs: Option<Vec<DaemonRecoveryHaltedRun>>,
}

/// The `recovery` member of `daemon.status.read`: the service's overall state and the sessions that
/// are not healthy, each damaged session among them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonRecoveryStatus {
    /// The service's overall state.
    pub overall: DaemonRecoveryState,
    /// The sessions that are not healthy.
    #[garde(dive)]
    pub sessions: Vec<DaemonRecoverySession>,
}

/// The service's state when a write was refused by the whole service.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, IntoStaticStr)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum DaemonWriteRefusedRecovery {
    /// The restart's pass runs.
    Rebuilding,
    /// The local store is unavailable.
    Blocked,
}

impl From<DaemonWriteRefusedRecovery> for DaemonRecoveryState {
    fn from(recovery: DaemonWriteRefusedRecovery) -> Self {
        match recovery {
            DaemonWriteRefusedRecovery::Rebuilding => Self::Rebuilding,
            DaemonWriteRefusedRecovery::Blocked => Self::Blocked,
        }
    }
}

/// The `daemon.writeRefused` refusal's `data.fields`: the service's recovery state when the call
/// arrived.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonWriteRefusedDetails {
    /// The service's state.
    pub recovery: DaemonWriteRefusedRecovery,
}

ts_constants! {
    /// The error code a service answers `connection.initialize` with, once the request carries its
    /// session token, while it repairs its database file. A client waits for it rather than
    /// counting it as silence.
    DAEMON_REPAIRING_CODE = RefusalCode::DaemonRepairing;
    /// What a person reads while the service repairs its database file.
    pub const DAEMON_REPAIRING_LINE: &str =
        "Repairing saved sessions after an unexpected shutdown";
}

/// How far a repair has come: `done` of the damaged file's `total` session events recovered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonRepairProgress {
    /// The session events recovered so far.
    pub done: SafeInt<0>,
    /// The session events the damaged file lists.
    pub total: SafeInt<0>,
}

/// The `daemon.repairing` refusal's `data.fields`: the repair's count, absent while the step it is
/// on gives none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonRepairingDetails {
    /// The repair's count.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DaemonRepairProgress")]
    pub progress: Option<DaemonRepairProgress>,
}

/// One part of the repair's line: words, or a count the reader draws in its own form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DaemonRepairingLinePart {
    /// Words, as written.
    Words(String),
    /// A count.
    Count(u64),
}

/// The repair's line in parts, `<line> · <done> of <total>`, or the line ending in `…` when there
/// is no count.
pub fn describe_daemon_repairing_line(
    progress: Option<DaemonRepairProgress>,
) -> Vec<DaemonRepairingLinePart> {
    match progress {
        None => vec![DaemonRepairingLinePart::Words(format!(
            "{DAEMON_REPAIRING_LINE}…"
        ))],
        Some(progress) => vec![
            DaemonRepairingLinePart::Words(format!("{DAEMON_REPAIRING_LINE} · ")),
            DaemonRepairingLinePart::Count(progress.done.get()),
            DaemonRepairingLinePart::Words(" of ".to_owned()),
            DaemonRepairingLinePart::Count(progress.total.get()),
        ],
    }
}

/// The step of the recovery pass an event's outcome was decided in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryPhase {
    /// Rebuilding the projections.
    ProjectionRebuild,
    /// Restoring the provider bindings.
    BindingRestore,
    /// Resuming the runs.
    RunResumption,
}

/// What started a recovery pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryTrigger {
    /// The service's start.
    Startup,
    /// The person.
    Manual,
    /// The supervisor.
    Supervisor,
}

/// What kind of failure a failed recovery pass met.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryFailureKind {
    /// The projections could not be rebuilt.
    ProjectionRebuildFailed,
    /// A provider binding could not be restored.
    BindingRestoreFailed,
    /// The local store was unavailable.
    PersistenceUnavailable,
    /// Anything else.
    Other,
}

branded_uuid_id! {
    /// Identifies one recovery pass; every event of the pass names it.
    RecoveryId
}

/// `daemon.recovery.attempted`: a recovery pass started. Like every recovery event it names this
/// machine, the pass, the step it was in, and which attempt it is, one above the failed passes
/// since the last one that succeeded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonRecoveryAttemptedPayload {
    /// This machine.
    pub machine_id: MachineId,
    /// The pass.
    pub recovery_id: RecoveryId,
    /// The step it was in.
    pub phase: RecoveryPhase,
    /// Which attempt it is.
    pub attempt_number: SafeInt<1>,
    /// What started it.
    pub recovery_trigger: RecoveryTrigger,
    /// The failed passes since the last one that succeeded.
    pub prior_failure_count: SafeInt<0>,
    /// When it started.
    #[garde(dive)]
    pub started_at: WireInstant,
}

/// `daemon.recovery.succeeded`: a recovery pass completed; every count is of this pass alone, and
/// every run it settled is in exactly one of the run counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonRecoverySucceededPayload {
    /// This machine.
    pub machine_id: MachineId,
    /// The pass.
    pub recovery_id: RecoveryId,
    /// The step it was in.
    pub phase: RecoveryPhase,
    /// Which attempt it is.
    pub attempt_number: SafeInt<1>,
    /// The events applied.
    pub events_applied: SafeInt<0>,
    /// The provider bindings restored.
    pub bindings_restored: SafeInt<0>,
    /// The runs resumed.
    pub runs_resumed: SafeInt<0>,
    /// The runs that failed deterministically.
    pub runs_failed_deterministically: SafeInt<0>,
    /// The runs halted for the person to reconcile.
    pub runs_halted_for_reconciliation: SafeInt<0>,
    /// The runs ended `interrupted`: under the person's pending interrupt, a paused child, or at a
    /// step or spend limit their log still owed.
    pub runs_interrupted: SafeInt<0>,
    /// The runs ended `stopped` at a token limit their log still owed.
    pub runs_stopped: SafeInt<0>,
    /// How long it took, on a monotonic clock, in milliseconds.
    pub duration_ms: SafeInt<0>,
    /// When it completed.
    #[garde(dive)]
    pub completed_at: WireInstant,
}

/// `daemon.recovery.failed`: a recovery pass that left the service blocked, when the local store
/// failed, or degraded, when a session's history could not be rebuilt whole; `detail` is in the
/// service's own words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonRecoveryFailedPayload {
    /// This machine.
    pub machine_id: MachineId,
    /// The pass.
    pub recovery_id: RecoveryId,
    /// The step it was in.
    pub phase: RecoveryPhase,
    /// Which attempt it is.
    pub attempt_number: SafeInt<1>,
    /// What kind of failure it met.
    pub failure_kind: RecoveryFailureKind,
    /// The failure, in the service's own words.
    pub detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    /// The runs the pass left live.
    pub runs_left_in_flight: Vec<RunId>,
    /// How long it took, on a monotonic clock, in milliseconds.
    pub duration_ms: SafeInt<0>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/recovery",
    doc: "The service's recovery after a restart: its state, the refusals a write meets, the \
          repair of the database file and the recovery pass's events.",
    definitions: &[
        Definition::read::<DaemonRecoveryState>(),
        Definition::read::<DaemonRecoverySessionState>(),
        Definition::read::<DaemonRecoveryHaltedRun>(),
        Definition::read::<DaemonRecoverySession>(),
        Definition::read::<DaemonRecoveryStatus>().checked(),
        Definition::read::<DaemonWriteRefusedRecovery>(),
        Definition::read::<DaemonWriteRefusedDetails>(),
        Definition::read::<DaemonRepairProgress>(),
        Definition::read::<DaemonRepairingDetails>().checked(),
        Definition::read::<RecoveryPhase>(),
        Definition::read::<RecoveryTrigger>(),
        Definition::read::<RecoveryId>(),
        Definition::read::<RecoveryFailureKind>(),
        Definition::read::<DaemonRecoveryAttemptedPayload>().checked(),
        Definition::read::<DaemonRecoverySucceededPayload>().checked(),
        Definition::read::<DaemonRecoveryFailedPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{DaemonRepairProgress, DaemonRepairingLinePart, describe_daemon_repairing_line};

    /// The table the client's repair-line suite reads too.
    const CASES: &str = include_str!("../../tests/fixtures/repairing-line.json");

    /// One part as the table writes it: words, or `{ "count": n }`.
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum PartCase {
        Words(String),
        Count { count: u64 },
    }

    /// One case: the repair's count, or `null` while it has none, and the line's parts.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LineCase {
        progress: Option<DaemonRepairProgress>,
        parts: Vec<PartCase>,
    }

    #[test]
    fn the_repair_line_reads_as_the_client_draws_it() {
        let cases: Vec<LineCase> = serde_json::from_str(CASES).expect("the cases read");
        for case in cases {
            let expected: Vec<DaemonRepairingLinePart> = case
                .parts
                .into_iter()
                .map(|part| match part {
                    PartCase::Words(words) => DaemonRepairingLinePart::Words(words),
                    PartCase::Count { count } => DaemonRepairingLinePart::Count(count),
                })
                .collect();
            assert_eq!(
                describe_daemon_repairing_line(case.progress),
                expected,
                "{:?}",
                case.progress
            );
        }
    }
}
