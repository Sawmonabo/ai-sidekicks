//! How large one environment entry, and the whole environment, may be when a program starts; each
//! platform's module reads its own bounds.

use sidekicks_contracts::workflow::run::failures::WorkflowStepValueMeasure;

/// The bounds a program's environment must fit to start, each counted in `measure`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnvironmentValueLimits {
    /// The most one `NAME=value` entry, its NUL counted, may fill.
    pub per_value: usize,
    /// The most the arguments and the whole environment may fill together, before the caller
    /// subtracts what the start already carries; `None` where the system sets no such bound.
    pub total: Option<usize>,
    /// The unit both bounds count in.
    pub measure: WorkflowStepValueMeasure,
}
