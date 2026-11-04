use rstest::rstest;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_provider::driver::test_registry::new_run_id;
use sidekicks_provider::run::delivery::{InboundDelivery, InboundOutcome};

use super::Harness;
use crate::run::engine::test_fixture::insert_running_run;

impl Harness {
    // A run of the harness's session under its run, in `state`.
    fn insert_child_run(&self, state: RunState) -> RunId {
        let run_id = new_run_id();
        insert_running_run(&self.database, self.session_id(), run_id);
        self.database
            .reader()
            .execute(
                "UPDATE runs SET parent_run_id = ?1, state = ?2 WHERE run_id = ?3",
                [
                    self.run_id.text().as_str(),
                    <&'static str>::from(state),
                    run_id.text().as_str(),
                ],
            )
            .expect("the test sets the child's parent and state");
        run_id
    }

    // The run's stored parent.
    fn parent_of(&self, run_id: &RunId) -> Option<String> {
        self.database
            .reader()
            .query_row(
                "SELECT parent_run_id FROM runs WHERE run_id = ?1",
                [run_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads the run's row")
    }

    // The type of the event `event_id`.
    fn stored_type_of(&self, event_id: &str) -> String {
        self.database
            .reader()
            .query_row(
                "SELECT type FROM session_events WHERE id = ?1",
                [event_id],
                |row| row.get(0),
            )
            .expect("the test reads the event")
    }
}

// A helper's run that started before the call that started it reached the daemon moves under the
// run that made the call, live or ended. Killed by the correction routed through the ended-run
// absorb, which leaves the ended child under its first parent, and by the outcome answered
// without the engine's write.
#[rstest]
#[case::a_live_child(RunState::Running)]
#[case::an_ended_child(RunState::Completed)]
#[tokio::test]
async fn inbound_moves_a_child_run_under_the_run_whose_call_started_it(
    #[case] child_state: RunState,
) {
    let harness = Harness::new(RunState::Running).await;
    let child_run_id = harness.insert_child_run(child_state);
    let parent_run_id = harness.insert_child_run(RunState::Running);

    let outcome = harness
        .dispatched(InboundDelivery::ChildRunParentCorrected {
            binding: harness.on_binding(None),
            child_run_id,
            parent_run_id,
        })
        .await;

    let InboundOutcome::Appended { event_id } = outcome else {
        panic!("the correction is appended: {outcome:?}");
    };
    assert_eq!(
        harness.stored_type_of(event_id.as_str()),
        "agent.run.parentCorrected"
    );
    assert_eq!(
        harness.parent_of(&child_run_id).as_deref(),
        Some(parent_run_id.text().as_str())
    );
}
