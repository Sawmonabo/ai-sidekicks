//! A going run's status as a function of its steps, the run event a change of that status implies,
//! and how the time the run waits on people moves with it. Every write that changes a step, and
//! the fold that rebuilds the rows from the log, read the same answers, so the run row follows
//! the log.

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};

/// What the status rules read of a going run's steps, kept as counts so a write or the fold keeps
/// them as it applies each change rather than scanning the run again.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's commit and the engine's projection, which keep a going run's status"
    )
)]
pub(crate) struct RunStepCounts {
    /// True once any step of the run was admitted.
    pub(crate) has_admitted_step: bool,
    /// Steps `running`: admitted, started or winding down.
    pub(crate) running: usize,
    /// Steps the memory gate holds before they start.
    pub(crate) waiting_memory: usize,
    /// Steps readied and not yet admitted.
    pub(crate) pending: usize,
    /// Steps `waiting`, whatever the cause.
    pub(crate) waiting: usize,
    /// Waiting steps parked on a spent provider account.
    pub(crate) account_waits: usize,
    /// Failed steps whose failure parks the run: failed under `onError: stop`, or by the crash
    /// sweep.
    pub(crate) parking_failures: usize,
}

impl RunStepCounts {
    /// Moves one step from `from`, its status and wait cause, to `to`; `from` is `None` for a step
    /// new to the run. A settled status counts nowhere.
    pub(crate) fn moved(
        &mut self,
        from: Option<(WorkflowStepStatus, Option<WorkflowWaitCause>)>,
        to: (WorkflowStepStatus, Option<WorkflowWaitCause>),
    ) {
        if let Some(from) = from {
            self.count(from, false);
        }
        self.count(to, true);
    }

    /// Records that a step of the run was admitted.
    pub(crate) fn admitted(&mut self) {
        self.has_admitted_step = true;
    }

    /// Records a failed step whose failure parks the run.
    pub(crate) fn parked(&mut self) {
        self.parking_failures += 1;
    }

    // Counts one step in, or out of, the counts of `status`, and of its account wait.
    fn count(
        &mut self,
        (status, wait_cause): (WorkflowStepStatus, Option<WorkflowWaitCause>),
        is_in: bool,
    ) {
        let counted = match status {
            WorkflowStepStatus::Pending => &mut self.pending,
            WorkflowStepStatus::Running => &mut self.running,
            WorkflowStepStatus::WaitingMemory => &mut self.waiting_memory,
            WorkflowStepStatus::Waiting => &mut self.waiting,
            WorkflowStepStatus::Succeeded
            | WorkflowStepStatus::Failed
            | WorkflowStepStatus::Skipped
            | WorkflowStepStatus::Canceled => return,
        };
        shift(counted, is_in);
        if status == WorkflowStepStatus::Waiting && wait_cause == Some(WorkflowWaitCause::Account) {
            shift(&mut self.account_waits, is_in);
        }
    }
}

// Adds one to `count`, or takes one from it.
fn shift(count: &mut usize, is_in: bool) {
    *count = if is_in {
        *count + 1
    } else {
        count
            .checked_sub(1)
            .expect("a step leaves only a status it was counted in")
    };
}

/// A going run's status as its steps give it. The ended statuses never come from here: each comes
/// only from its own run event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's commit and the engine's projection, which keep a going run's status"
    )
)]
pub(crate) enum GoingRunStatus {
    /// No step admitted yet.
    New,
    /// A step runs, is held for memory or is ready to admit, with no failed park.
    Running,
    /// Only waits are left, a failed park beside them included.
    Waiting,
    /// A failed step parked the run and no step waits: `failed` with no `finished_at`.
    FailedPark,
    /// Every step settled: the run's ending, not this status, writes what follows.
    Settled,
}

/// The status `counts` give a going run, by the first rule that holds: nothing admitted is new; a
/// step running, held for memory or pending, with no failed park, is running; a waiting step is
/// waiting; a failed park is a parked failure; else every step settled.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's commit and the engine's projection, which keep a going run's status"
    )
)]
pub(crate) fn going_run_status(counts: &RunStepCounts) -> GoingRunStatus {
    let has_failed_park = counts.parking_failures > 0;
    if !counts.has_admitted_step {
        GoingRunStatus::New
    } else if !has_failed_park && counts.running + counts.waiting_memory + counts.pending > 0 {
        GoingRunStatus::Running
    } else if counts.waiting > 0 {
        GoingRunStatus::Waiting
    } else if has_failed_park {
        GoingRunStatus::FailedPark
    } else {
        GoingRunStatus::Settled
    }
}

/// The run event a move between two going statuses implies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's commit and the engine's projection, which keep a going run's status"
    )
)]
pub(crate) enum RunStatusChange {
    /// `workflow.run.waiting`: the run went from running to only waits.
    Waiting,
    /// `workflow.run.resumed`: the run went back to running from a wait or a failed park.
    Resumed,
    /// `workflow.run.failed` with the park marker: the run parked on a failed step.
    FailedPark,
}

/// The run event the move from `before` to `after` implies, or `None` where the move has none:
/// the first admission's own event starts the run, an unchanged status repeats nothing, and a
/// settled run's ending decides what it writes.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's commit and the engine's projection, which keep a going run's status"
    )
)]
pub(crate) fn run_status_change(
    before: GoingRunStatus,
    after: GoingRunStatus,
) -> Option<RunStatusChange> {
    match (before, after) {
        (GoingRunStatus::Running, GoingRunStatus::Waiting) => Some(RunStatusChange::Waiting),
        (GoingRunStatus::Waiting | GoingRunStatus::FailedPark, GoingRunStatus::Running) => {
            Some(RunStatusChange::Resumed)
        }
        (GoingRunStatus::Running | GoingRunStatus::Waiting, GoingRunStatus::FailedPark) => {
            Some(RunStatusChange::FailedPark)
        }
        _ => None,
    }
}

/// The run's person-wait columns: when its open wait on people began, and the milliseconds its
/// closed ones took.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's commit and the engine's projection, which keep a going run's status"
    )
)]
pub(crate) struct RunPersonWait {
    /// The instant of the `workflow.run.waiting` that opened the wait, while one is open.
    pub(crate) since: Option<WireInstant>,
    /// The milliseconds of every closed wait on people.
    pub(crate) total_ms: u64,
}

/// The person-wait columns after a change at `at`: a `Waiting` change opens a wait at `at` where
/// no step holds an account wait; a `Resumed` or `FailedPark` change, or `leaves_waiting` (which
/// the ending, Cancel and the crash sweep pass), closes an open one, adding the whole milliseconds
/// since it opened, never fewer than 0; anything else leaves the columns as they are.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's commit and the engine's projection, which keep a going run's status"
    )
)]
pub(crate) fn person_wait_after(
    before: RunPersonWait,
    change: Option<RunStatusChange>,
    leaves_waiting: bool,
    account_waits: usize,
    at: &WireInstant,
) -> RunPersonWait {
    let closes = leaves_waiting
        || matches!(
            change,
            Some(RunStatusChange::Resumed | RunStatusChange::FailedPark)
        );
    match before.since {
        Some(since) if closes => RunPersonWait {
            since: None,
            total_ms: before
                .total_ms
                .saturating_add(whole_milliseconds_between(&since, at)),
        },
        None if change == Some(RunStatusChange::Waiting) && account_waits == 0 => RunPersonWait {
            since: Some(at.clone()),
            total_ms: before.total_ms,
        },
        since => RunPersonWait {
            since,
            total_ms: before.total_ms,
        },
    }
}

/// The whole milliseconds from `from` to `to`; 0 where `to` is earlier or either does not read.
pub(crate) fn whole_milliseconds_between(from: &WireInstant, to: &WireInstant) -> u64 {
    from.unix_millisecond()
        .zip(to.unix_millisecond())
        .map_or(0, |(from, to)| {
            u64::try_from(to.saturating_sub(from)).unwrap_or(0)
        })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::wire::instant::instant;

    use super::{
        GoingRunStatus, RunPersonWait, RunStatusChange, RunStepCounts, going_run_status,
        person_wait_after, run_status_change,
    };

    fn admitted() -> RunStepCounts {
        RunStepCounts {
            has_admitted_step: true,
            ..RunStepCounts::default()
        }
    }

    #[rstest]
    #[case::nothing_admitted(
        RunStepCounts { waiting_memory: 1, ..RunStepCounts::default() },
        GoingRunStatus::New
    )]
    #[case::running_beside_a_wait(
        RunStepCounts { running: 1, waiting: 1, ..admitted() },
        GoingRunStatus::Running
    )]
    #[case::pending_beside_a_wait(
        RunStepCounts { pending: 1, waiting: 1, ..admitted() },
        GoingRunStatus::Running
    )]
    #[case::pending_beside_a_failed_park(
        RunStepCounts { pending: 1, parking_failures: 1, ..admitted() },
        GoingRunStatus::FailedPark
    )]
    #[case::wait_beside_a_failed_park(
        RunStepCounts { running: 1, waiting: 1, parking_failures: 1, ..admitted() },
        GoingRunStatus::Waiting
    )]
    #[case::failed_park(
        RunStepCounts { parking_failures: 1, ..admitted() },
        GoingRunStatus::FailedPark
    )]
    #[case::nothing_live(admitted(), GoingRunStatus::Settled)]
    fn a_going_runs_status_follows_its_steps_in_rule_order(
        #[case] counts: RunStepCounts,
        #[case] expected: GoingRunStatus,
    ) {
        assert_eq!(going_run_status(&counts), expected);
    }

    #[rstest]
    #[case::starts_waiting(
        GoingRunStatus::Running,
        GoingRunStatus::Waiting,
        Some(RunStatusChange::Waiting)
    )]
    #[case::answered(
        GoingRunStatus::Waiting,
        GoingRunStatus::Running,
        Some(RunStatusChange::Resumed)
    )]
    #[case::park_resumed(
        GoingRunStatus::FailedPark,
        GoingRunStatus::Running,
        Some(RunStatusChange::Resumed)
    )]
    #[case::parks_running(
        GoingRunStatus::Running,
        GoingRunStatus::FailedPark,
        Some(RunStatusChange::FailedPark)
    )]
    #[case::parks_waiting(
        GoingRunStatus::Waiting,
        GoingRunStatus::FailedPark,
        Some(RunStatusChange::FailedPark)
    )]
    #[case::first_admission(GoingRunStatus::New, GoingRunStatus::Running, None)]
    #[case::unchanged(GoingRunStatus::Running, GoingRunStatus::Running, None)]
    #[case::settled(GoingRunStatus::Running, GoingRunStatus::Settled, None)]
    fn a_status_move_names_its_run_event(
        #[case] before: GoingRunStatus,
        #[case] after: GoingRunStatus,
        #[case] expected: Option<RunStatusChange>,
    ) {
        assert_eq!(run_status_change(before, after), expected);
    }

    #[test]
    fn the_person_wait_counts_only_waits_on_people_and_closes_once() {
        let opened_at = instant("2026-01-05T10:00:00.000Z");
        let closed_at = instant("2026-01-05T10:00:01.500Z");
        let nothing_open = RunPersonWait::default();

        let open = person_wait_after(
            nothing_open.clone(),
            Some(RunStatusChange::Waiting),
            false,
            0,
            &opened_at,
        );
        assert_eq!(open.since, Some(opened_at.clone()));
        let closed = person_wait_after(open, Some(RunStatusChange::Resumed), false, 0, &closed_at);
        assert_eq!(
            closed,
            RunPersonWait {
                since: None,
                total_ms: 1_500
            }
        );

        let on_an_account = person_wait_after(
            nothing_open,
            Some(RunStatusChange::Waiting),
            false,
            1,
            &opened_at,
        );
        assert_eq!(on_an_account.since, None);

        let closed_again = person_wait_after(closed.clone(), None, true, 0, &closed_at);
        assert_eq!(closed_again, closed);

        let opened_later = RunPersonWait {
            since: Some(closed_at),
            total_ms: 1_500,
        };
        let closed_earlier = person_wait_after(
            opened_later,
            Some(RunStatusChange::FailedPark),
            true,
            0,
            &opened_at,
        );
        assert_eq!(
            closed_earlier,
            RunPersonWait {
                since: None,
                total_ms: 1_500
            }
        );
    }
}
