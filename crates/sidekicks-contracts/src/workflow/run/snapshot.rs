//! The two numbers that name one of a workflow run's snapshots: which execution of the run it
//! belongs to, and which of that execution's approval pauses took it.

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::named_scalar;

named_scalar! {
    /// Which execution of a run a snapshot belongs to: 0 for the first, one more at each re-run.
    WorkflowRunEpoch(SafeInt<0>), Copy
}

named_scalar! {
    /// Which approval pause of one execution took a snapshot, counted from 1.
    WorkflowRunPauseNumber(SafeInt<1>), Copy
}

/// The TypeScript module of the snapshot numbers.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/snapshot",
    doc: "The two numbers that name one of a workflow run's snapshots: which execution of the run \
          it belongs to, and which of that execution's approval pauses took it.",
    definitions: &[
        Definition::read::<WorkflowRunEpoch>().checked(),
        Definition::read::<WorkflowRunPauseNumber>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
