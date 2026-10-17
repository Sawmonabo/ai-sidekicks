//! A session whose history is damaged: the details of the refusal its writes meet, and of the
//! one a session the restart's pass is still rebuilding gives, the details of its two actions'
//! refusal when they do not apply, and the event `Continue from here` appends. The log is never
//! cut or rewritten: the event names the damaged range, and every read and rebuild skips it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::daemon::recovery::DaemonRecoverySessionState;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;

/// How far a session's history is damaged: after a readable start, or with no readable event;
/// each is a [`DaemonRecoverySessionState`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionHistoryDamagedRecovery {
    /// Its history is damaged after a readable start.
    Degraded,
    /// No event of it can be read.
    Damaged,
}

impl From<SessionHistoryDamagedRecovery> for DaemonRecoverySessionState {
    fn from(recovery: SessionHistoryDamagedRecovery) -> Self {
        match recovery {
            SessionHistoryDamagedRecovery::Degraded => Self::Degraded,
            SessionHistoryDamagedRecovery::Damaged => Self::Damaged,
        }
    }
}

/// The `session.history.damaged` refusal's `data.fields`: the session and how far its history is
/// damaged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionHistoryDamagedDetails {
    /// The session.
    pub session_id: SessionId,
    /// How far its history is damaged.
    pub recovery: SessionHistoryDamagedRecovery,
}

/// The `session.rebuilding` refusal's `data.fields`: the session the restart's pass has not rebuilt
/// yet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRebuildingDetails {
    /// The session.
    pub session_id: SessionId,
}

/// Why a recovery action was refused: the session's history is not damaged, or no event of it can
/// be read, so there is no point to continue from and only delete applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionRecoveryRefusedReason {
    /// The session's history is not damaged.
    NotDamaged,
    /// No event of the session can be read.
    NoReadableEvent,
}

/// The `session.recovery.refused` refusal's `data.fields`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRecoveryRefusedDetails {
    /// The session.
    pub session_id: SessionId,
    /// Why the action was refused.
    pub reason: SessionRecoveryRefusedReason,
}

/// `session.damagedEvents.skipped`: the session continued from its last good point. Its events
/// from `from_sequence` through `to_sequence` are damaged; they stay in the log and every read and
/// rebuild skips them, so the event before `from_sequence` is the session's end until it takes new
/// work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionDamagedEventsSkippedPayload {
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
        Definition::read::<SessionHistoryDamagedRecovery>(),
        Definition::read::<SessionHistoryDamagedDetails>(),
        Definition::read::<SessionRebuildingDetails>(),
        Definition::read::<SessionRecoveryRefusedReason>(),
        Definition::read::<SessionRecoveryRefusedDetails>(),
        Definition::read::<SessionDamagedEventsSkippedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
