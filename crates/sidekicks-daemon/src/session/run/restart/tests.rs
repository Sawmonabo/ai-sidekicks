use rstest::rstest;
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterruptInterventionRecord, InterventionId, RunLimit,
};
use sidekicks_contracts::run::state::RunState;

use super::{
    PendingInterrupt, RestartDecision, RestartFacts, RestartSettlement, RestartTurnEnd,
    decide_restart_settlement, no_waiting_item_statement,
};
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};
use crate::interventions::store::UnresolvedInterventionState;
use crate::questions::schema::schema_parts;
use crate::session::run::read::{LiveRun, RunRead};
use sidekicks_contracts::wire::id::mint_uuid_v7;

fn ends(settlement: RestartSettlement, turn_end: RestartTurnEnd) -> Option<RestartDecision> {
    Some(RestartDecision {
        settlement,
        open_turn_end: Some(turn_end),
    })
}

fn stopped_at_token_limit() -> Option<RestartDecision> {
    ends(
        RestartSettlement::Stopped {
            trigger: StopTrigger::TokenLimit,
        },
        RestartTurnEnd::Interrupted,
    )
}

fn interrupted(trigger: Option<InterruptReason>) -> Option<RestartDecision> {
    ends(
        RestartSettlement::Interrupted { trigger },
        RestartTurnEnd::Interrupted,
    )
}

fn failed_with_its_turn() -> Option<RestartDecision> {
    ends(RestartSettlement::Failed, RestartTurnEnd::Failed)
}

// Killed by leaving every queued run alone or failing one a message still waits to start
// (`queued_*`), by reading a limit from the person's reason text (`person_naming_step_limit`), by
// settling a limit stop as the person's or another limit's (`*_limit`), by failing a run whose log
// still owes a limit (`step_limit_owed`, `step_limit_pending_and_owed`), by letting a pending
// interrupt win over an owed token limit (`*_beside_an_owed_token_limit`), by settling by the
// first pending row alone, or by a limit's row over a person's or the step limit's over the spend
// limit's (`*_beside_a_pending_step_limit`) or the spend limit's over the token limit's
// (`token_limit_beside_a_pending_spend_limit`), by dropping the held child's rule (`held_child_*`),
// and by giving a run the wrong turn end or none.
#[rstest]
#[case::queued_behind_a_message(RunState::Queued, false, &[], None, true, None)]
#[case::queued_with_nothing_to_start_it(
    RunState::Queued,
    false,
    &[],
    None,
    false,
    Some(RestartDecision {
        settlement: RestartSettlement::Failed,
        open_turn_end: None,
    })
)]
#[case::person_interrupt(
    RunState::Running,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    None,
    false,
    interrupted(None)
)]
#[case::person_naming_step_limit(
    RunState::Running,
    false,
    &[r#"{"pending":"returnToDraft","reason":"stepLimit"}"#],
    None,
    false,
    interrupted(None)
)]
#[case::step_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#],
    None,
    false,
    interrupted(Some(InterruptReason::StepLimit))
)]
#[case::step_limit_pending_and_owed(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#],
    Some(RunLimit::StepLimit),
    false,
    interrupted(Some(InterruptReason::StepLimit))
)]
#[case::spend_limit(
    RunState::WaitingForApproval,
    false,
    &[r#"{"limit":"spendLimit"}"#],
    None,
    false,
    interrupted(Some(InterruptReason::SpendLimit))
)]
#[case::token_limit(
    RunState::Paused,
    true,
    &[r#"{"limit":"tokenLimit"}"#],
    None,
    false,
    stopped_at_token_limit()
)]
#[case::token_limit_beside_a_pending_spend_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"spendLimit"}"#, r#"{"limit":"tokenLimit"}"#],
    None,
    false,
    stopped_at_token_limit()
)]
#[case::person_interrupt_beside_an_owed_token_limit(
    RunState::Running,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    Some(RunLimit::TokenLimit),
    false,
    stopped_at_token_limit()
)]
#[case::spend_limit_beside_an_owed_token_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"spendLimit"}"#],
    Some(RunLimit::TokenLimit),
    false,
    stopped_at_token_limit()
)]
#[case::person_interrupt_beside_an_owed_step_limit(
    RunState::Running,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    Some(RunLimit::StepLimit),
    false,
    interrupted(None)
)]
#[case::person_interrupt_beside_a_pending_step_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#, r#"{"pending":"nextTurn"}"#],
    Some(RunLimit::StepLimit),
    false,
    interrupted(None)
)]
#[case::spend_limit_beside_a_pending_step_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#, r#"{"limit":"spendLimit"}"#],
    Some(RunLimit::StepLimit),
    false,
    interrupted(Some(InterruptReason::SpendLimit))
)]
#[case::held_child_paused(
    RunState::Paused,
    true,
    &[],
    None,
    false,
    interrupted(Some(InterruptReason::DaemonRestart))
)]
#[case::held_child_pausing(
    RunState::Pausing,
    true,
    &[],
    None,
    false,
    interrupted(Some(InterruptReason::DaemonRestart))
)]
#[case::paused_lead(RunState::Paused, false, &[], None, false, failed_with_its_turn())]
#[case::running_child(
    RunState::Running,
    true,
    &[],
    None,
    false,
    failed_with_its_turn()
)]
#[case::step_limit_owed(
    RunState::Running,
    false,
    &[],
    Some(RunLimit::StepLimit),
    false,
    interrupted(Some(InterruptReason::StepLimit))
)]
#[case::running(RunState::Running, false, &[], None, false, failed_with_its_turn())]
fn a_restart_settles_each_live_run_by_what_it_was_waiting_on(
    #[case] state: RunState,
    #[case] has_parent: bool,
    #[case] pending_records: &[&str],
    #[case] owed_limit: Option<RunLimit>,
    #[case] has_queued_item: bool,
    #[case] expected: Option<RestartDecision>,
) {
    let run = LiveRun {
        run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        run: RunRead {
            version: 4,
            session_id: test_session_id(),
            state,
        },
        parent_run_id: has_parent
            .then(|| RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")),
        reached_by: None,
    };
    let pending_interrupts = pending_records
        .iter()
        .map(|record| PendingInterrupt {
            intervention_id: InterventionId::try_from(mint_uuid_v7())
                .expect("a minted UUID is an intervention id"),
            state: UnresolvedInterventionState::Accepted,
            actor: InterventionActor::Daemon(DaemonInterventionActor::Value),
            record: serde_json::from_str::<InterruptInterventionRecord>(record)
                .expect("the test's record reads as stored"),
        })
        .collect();
    let facts = RestartFacts {
        pending_interrupts,
        owed_limit,
        turn_cuts: Vec::new(),
        has_queued_item,
    };

    assert_eq!(decide_restart_settlement(&run, &facts), expected);
}

// Killed by the guard reading a state other than the stored `queued` word, or by dropping its
// run condition: either lets the settle end a run its queue still starts, or refuses one whose
// message is gone.
#[tokio::test]
async fn the_waiting_item_guard_holds_only_while_a_queued_message_targets_the_run() {
    let database = TestDatabase::new(schema_parts());
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let connection = database.reader();
    connection
        .execute(
            "INSERT INTO queue_items (id, session_id, state, target_run_id, position,
               created_at, updated_at)
             VALUES ('item', 'session', 'queued', ?1, 0, '', '')",
            [run_id.text().as_str()],
        )
        .expect("the test queues a message for the run");

    let while_queued = writer.write(vec![no_waiting_item_statement(&run_id)]).await;
    assert!(
        matches!(
            while_queued,
            Err(WriteError::Refused {
                statement_index: 0,
                row_count: 1,
            })
        ),
        "a run a queued message targets is not settled: {while_queued:?}"
    );

    connection
        .execute("UPDATE queue_items SET state = 'admitted'", [])
        .expect("the test admits the message");
    writer
        .write(vec![no_waiting_item_statement(&run_id)])
        .await
        .expect("a run with no queued message behind it is settled");
}
