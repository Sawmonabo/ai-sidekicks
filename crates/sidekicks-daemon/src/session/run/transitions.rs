//! Every move a run's state may make: the one table the engine checks a change against before it
//! writes, and the event types that end a run.

use std::sync::LazyLock;

use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::state::{RUN_TERMINAL_STATES, RunState};
use sidekicks_contracts::transcript::run_facts::{RUN_STATE_EVENT_TYPES, RunStateEventType};
use strum::VariantArray as _;

use crate::database::sql_list::sql_list_of;

/// Whether `event_type` enters a terminal state.
pub(crate) fn is_run_terminal_event_type(event_type: &str) -> bool {
    RunStateEventType::from_wire_name(event_type).is_some_and(|known| known.state().is_terminal())
}

/// The terminal states as a SQL list of quoted words, for a `state IN (…)` condition.
pub(crate) static RUN_TERMINAL_STATES_SQL: LazyLock<String> =
    LazyLock::new(|| sql_list_of(RUN_TERMINAL_STATES.map(<&'static str>::from)));

/// The run terminal event types as a SQL list of quoted words, in the order the unique index on
/// terminal records spells its predicate, so a read spelled the same way uses that index.
pub(crate) static RUN_TERMINAL_EVENT_TYPES_SQL: LazyLock<String> = LazyLock::new(|| {
    let mut names: Vec<&'static str> = RUN_STATE_EVENT_TYPES
        .iter()
        .filter(|event_type| event_type.state().is_terminal())
        .map(|event_type| event_type.session_event_type().as_str())
        .collect();
    names.sort_unstable();
    sql_list_of(names)
});

/// The states from which a run may move to `to`, in the states' declared order.
pub(crate) fn states_that_may_enter(to: RunStateChangeState) -> Vec<RunState> {
    RunState::VARIANTS
        .iter()
        .copied()
        .filter(|from| is_transition_allowed(*from, to))
        .collect()
}

/// Whether a run in `from` may move to `to`.
pub(crate) fn is_transition_allowed(from: RunState, to: RunStateChangeState) -> bool {
    next_states(from).contains(&to)
}

// The states each state may move to. A move several triggers share, such as `running -> failed`
// on an error during execution or at a restart, is one entry; the token limit's stop is the one
// way into `stopped` from a waiting or pausing state.
fn next_states(from: RunState) -> &'static [RunStateChangeState] {
    use RunStateChangeState as Next;
    match from {
        RunState::Queued => &[Next::Starting, Next::Failed],
        RunState::Starting => &[
            Next::Running,
            Next::Failed,
            Next::Interrupted,
            Next::WaitingForInput,
        ],
        RunState::Running => &[
            Next::WaitingForApproval,
            Next::WaitingForInput,
            Next::Pausing,
            Next::Interrupted,
            Next::Completed,
            Next::Failed,
            Next::Stopped,
        ],
        RunState::WaitingForApproval | RunState::Paused => &[
            Next::Running,
            Next::Interrupted,
            Next::Failed,
            Next::WaitingForInput,
            Next::Stopped,
        ],
        RunState::WaitingForInput => &[
            Next::Running,
            Next::Interrupted,
            Next::Failed,
            Next::Stopped,
        ],
        RunState::Pausing => &[
            Next::Paused,
            Next::Running,
            Next::Interrupted,
            Next::Failed,
            Next::Stopped,
        ],
        // A send into an ended helper starts a new run, so a final state has no way out.
        RunState::Completed | RunState::Stopped | RunState::Failed => &[],
        RunState::Interrupted => &[Next::Running, Next::Stopped],
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::run::events::RunStateChangeState as Next;
    use sidekicks_contracts::run::state::RunState as Now;

    use super::is_transition_allowed;

    #[rstest]
    #[case(Now::Queued, Next::Starting, true)]
    #[case(Now::Queued, Next::Failed, true)]
    #[case(Now::Starting, Next::Running, true)]
    #[case(Now::Starting, Next::Failed, true)]
    #[case(Now::Starting, Next::Interrupted, true)]
    #[case(Now::Starting, Next::WaitingForInput, true)]
    #[case(Now::Running, Next::WaitingForApproval, true)]
    #[case(Now::Running, Next::WaitingForInput, true)]
    #[case(Now::Running, Next::Pausing, true)]
    #[case(Now::Running, Next::Interrupted, true)]
    #[case(Now::Running, Next::Completed, true)]
    #[case(Now::Running, Next::Failed, true)]
    #[case(Now::Running, Next::Stopped, true)]
    #[case(Now::WaitingForApproval, Next::Running, true)]
    #[case(Now::WaitingForApproval, Next::Interrupted, true)]
    #[case(Now::WaitingForApproval, Next::Failed, true)]
    #[case(Now::WaitingForApproval, Next::WaitingForInput, true)]
    #[case(Now::WaitingForApproval, Next::Stopped, true)]
    #[case(Now::WaitingForInput, Next::Running, true)]
    #[case(Now::WaitingForInput, Next::Interrupted, true)]
    #[case(Now::WaitingForInput, Next::Failed, true)]
    #[case(Now::WaitingForInput, Next::Stopped, true)]
    #[case(Now::Pausing, Next::Paused, true)]
    #[case(Now::Pausing, Next::Running, true)]
    #[case(Now::Pausing, Next::Interrupted, true)]
    #[case(Now::Pausing, Next::Failed, true)]
    #[case(Now::Pausing, Next::Stopped, true)]
    #[case(Now::Paused, Next::Running, true)]
    #[case(Now::Paused, Next::Interrupted, true)]
    #[case(Now::Paused, Next::Failed, true)]
    #[case(Now::Paused, Next::WaitingForInput, true)]
    #[case(Now::Paused, Next::Stopped, true)]
    #[case(Now::Interrupted, Next::Running, true)]
    #[case(Now::Interrupted, Next::Stopped, true)]
    #[case(Now::Completed, Next::Running, false)]
    #[case(Now::Stopped, Next::Running, false)]
    #[case(Now::Queued, Next::Stopped, false)]
    #[case(Now::Starting, Next::Stopped, false)]
    #[case(Now::Queued, Next::Running, false)]
    #[case(Now::Queued, Next::Interrupted, false)]
    #[case(Now::Starting, Next::Completed, false)]
    #[case(Now::Running, Next::Paused, false)]
    #[case(Now::Running, Next::Running, false)]
    #[case(Now::WaitingForInput, Next::WaitingForApproval, false)]
    #[case(Now::Paused, Next::Pausing, false)]
    #[case(Now::Completed, Next::Failed, false)]
    #[case(Now::Interrupted, Next::Completed, false)]
    #[case(Now::Stopped, Next::Interrupted, false)]
    #[case(Now::Failed, Next::Running, false)]
    #[case(Now::Failed, Next::Interrupted, false)]
    fn a_move_is_allowed_only_where_the_table_lists_it(
        #[case] from: Now,
        #[case] to: Next,
        #[case] is_allowed: bool,
    ) {
        assert_eq!(is_transition_allowed(from, to), is_allowed);
    }
}
