//! The summarized child-run projection a transcript row carries and `transcript.childRunExpand`
//! expands. A failed detail fetch leaves the summary row visible and marked incomplete, with a
//! required cause, so a consumer can decide whether to retry; a low `eventCount` alone cannot be
//! told from a run that did little.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::run::id::RunId;
use crate::run::state::RunState;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;

/// Why a child-run summary is not the whole picture. Closed; a context compaction is not one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChildRunIncompleteCause {
    /// The daemon could not fetch the child run's detail.
    DetailFetchFailed,
}

/// Whether a summary row reflects the child run's full activity, and if not, why and as of when.
/// `observedAt` is required because the cause is transient: a retry decision and the age of the
/// notice both need to know how old it is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum ChildRunCompleteness {
    /// The summary is the whole picture.
    Complete {},
    /// The summary is a lower bound.
    Incomplete {
        /// Why.
        cause: ChildRunIncompleteCause,
        /// When the daemon noticed.
        #[garde(dive)]
        observed_at: WireInstant,
    },
}

/// Refuses a run named as its own parent, which would make the run-lineage graph cyclic and every
/// walk of it non-terminating.
pub fn refuse_self_parenting_run(run_id: &RunId, parent_run_id: &RunId) -> garde::Result {
    if run_id == parent_run_id {
        Err(garde::Error::new(
            "a child run cannot be its own parent: runId and parentRunId are equal",
        ))
    } else {
        Ok(())
    }
}

/// The summarized child-run projection: its parent, state, event count and completeness. No run
/// is its own parent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ChildRunSummary {
    /// The child run.
    pub run_id: RunId,
    /// The run that started it; never the child itself.
    #[garde(custom(|parent_run_id: &RunId, (): &()| {
        refuse_self_parenting_run(&self.run_id, parent_run_id)
    }))]
    #[schemars(extend("type" = "string", "not" = { "const": { "$data": "1/runId" } }))]
    pub parent_run_id: RunId,
    /// The child's state.
    pub state: RunState,
    /// How many events the daemon holds for it; on the `incomplete` arm a lower bound.
    pub event_count: SafeInt<0>,
    /// Whether the summary is the whole picture.
    #[garde(dive)]
    pub completeness: ChildRunCompleteness,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "transcript/child-run-summary",
    doc: "The summarized child-run projection a transcript row carries and \
          `transcript.childRunExpand` expands.",
    definitions: &[
        Definition::read::<ChildRunIncompleteCause>(),
        Definition::read::<ChildRunCompleteness>().checked(),
        Definition::read::<ChildRunSummary>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
