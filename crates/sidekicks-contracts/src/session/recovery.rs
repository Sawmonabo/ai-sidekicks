//! A session whose history is damaged: the details of the refusal its writes meet, which a session
//! the restart's pass is still rebuilding gives too, the details of its two actions' refusal when
//! they do not apply, and the event `Continue from here` appends. The log is never cut or
//! rewritten: the event names the damaged range, and every read and rebuild skips it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::daemon::recovery::DaemonRecoverySessionState;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;

/// Where a session that refuses writes stands in recovery: being rebuilt by the restart's pass,
/// at its last good point, or with no readable event; each is a [`DaemonRecoverySessionState`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionWriteRefusedRecovery {
    /// The restart's pass has not yet rebuilt it.
    Rebuilding,
    /// Its history is damaged after a readable start.
    Degraded,
    /// No event of it can be read.
    Damaged,
}

impl From<SessionWriteRefusedRecovery> for DaemonRecoverySessionState {
    fn from(recovery: SessionWriteRefusedRecovery) -> Self {
        match recovery {
            SessionWriteRefusedRecovery::Rebuilding => Self::Rebuilding,
            SessionWriteRefusedRecovery::Degraded => Self::Degraded,
            SessionWriteRefusedRecovery::Damaged => Self::Damaged,
        }
    }
}

/// The `session.write_refused` refusal's `data.fields`: the session and where its recovery stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionWriteRefusedDetails {
    /// The session.
    pub session_id: SessionId,
    /// Where its recovery stands.
    pub recovery: SessionWriteRefusedRecovery,
}

/// Why a recovery action was refused: the session's history is not damaged, or no event of it can
/// be read, so there is no point to continue from and only delete applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionRecoveryRefusedReason {
    /// The session's history is not damaged.
    NotDamaged,
    /// No event of the session can be read.
    NoReadableEvent,
}

/// The `session.recovery_refused` refusal's `data.fields`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRecoveryRefusedDetails {
    /// The session.
    pub session_id: SessionId,
    /// Why the action was refused.
    pub reason: SessionRecoveryRefusedReason,
}

/// `recovery.damaged_events_skipped`: the session continued from its last good point. Its events
/// from `from_sequence` through `to_sequence` are damaged; they stay in the log and every read and
/// rebuild skips them, so the event before `from_sequence` is the session's end until it takes new
/// work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RecoveryDamagedEventsSkippedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The first damaged event.
    pub from_sequence: SafeInt<0>,
    /// The last damaged event; at or after `from_sequence`.
    #[garde(custom(|to: &SafeInt<0>, (): &()| {
        if *to >= self.from_sequence {
            Ok(())
        } else {
            Err(garde::Error::new("a skipped range ends at or after its start"))
        }
    }))]
    #[schemars(extend("minimum" = { "$data": "1/fromSequence" }))]
    pub to_sequence: SafeInt<0>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/recovery",
    doc: "A session whose history is damaged: its refusals' details and the event `Continue from \
          here` appends.",
    definitions: &[
        Definition::read::<SessionWriteRefusedRecovery>(),
        Definition::read::<SessionWriteRefusedDetails>(),
        Definition::read::<SessionRecoveryRefusedReason>(),
        Definition::read::<SessionRecoveryRefusedDetails>(),
        Definition::read::<RecoveryDamagedEventsSkippedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
