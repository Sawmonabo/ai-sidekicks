//! Where a run stands, the state it starts in and the states it ends in.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::typescript::{Definition, TypeScriptModule, ts_constants};

/// Where a run stands. `pausing` is the step in flight finishing after a pause was asked for; the
/// run reads `paused` once nothing runs. `stopped` is a child ended for good by a stop that reached
/// several agents; a provider whose stop leaves a child resumable reads `interrupted` instead.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum RunState {
    /// Created and waiting to start.
    Queued,
    /// Its provider is starting.
    Starting,
    /// A turn is in flight.
    Running,
    /// Held on a person's approval.
    WaitingForApproval,
    /// Held on a person's answer.
    WaitingForInput,
    /// The step in flight is finishing after a pause was asked for.
    Pausing,
    /// Paused, with nothing running.
    Paused,
    /// Ended with its work done.
    Completed,
    /// Its turn cut by an interrupt, resting until a send continues it.
    Interrupted,
    /// Ended by a stop: a child ended by a stop that reached several agents, or a run at its token
    /// limit.
    Stopped,
    /// Ended by a failure.
    Failed,
}

impl RunState {
    /// Whether a run ends in this state; the event entering one is the terminal record of its run
    /// version.
    pub fn is_terminal(self) -> bool {
        RUN_TERMINAL_STATES.contains(&self)
    }
}

ts_constants! {
    /// The state a run is created in. No state change enters it, so the event entering it creates
    /// a run.
    pub const RUN_INITIAL_STATE: RunState = RunState::Queued;
    /// The states a run ends in; the event entering one is the terminal record of its run version.
    pub const RUN_TERMINAL_STATES: [RunState; 4] = [
        RunState::Completed,
        RunState::Interrupted,
        RunState::Stopped,
        RunState::Failed,
    ];
}

/// The TypeScript module of a run's state.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/state",
    doc: "Where a run stands, the state it starts in and the states it ends in.",
    definitions: &[Definition::read::<RunState>().checked()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
