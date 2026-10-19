use rstest::rstest;
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterruptInterventionRecord, InterventionId, RunLimit,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::integer::SafeInt;

use super::{
    PendingInterrupt, QUEUE_ITEMS_TABLE_SQL, RestartDecision, RestartFacts, RestartSettlement,
    RestartTurnEnd, TurnCut, decide_restart_settlement, no_waiting_item_statement,
};
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};
use crate::interventions::store::UnresolvedInterventionState;
use crate::session::run::read::{LiveRun, RunRead};
use crate::uuid_v7::mint_uuid_v7;

fn ends(settlement: RestartSettlement, turn_end: RestartTurnEnd) -> Option<RestartDecision> {
    Some(RestartDecision {
        settlement,
        open_turn_end: Some(turn_end),
        turn_cuts: Vec::new(),
    })
}

// Each turn in `turn_numbers` cut by `limit`.
fn cuts(limit: RunLimit, turn_numbers: &[u64]) -> Vec<TurnCut> {
    turn_numbers
        .iter()
        .map(|&turn_number| TurnCut {
            turn_number: SafeInt::new(turn_number).expect("the test's turns count from 1"),
            limit,
        })
        .collect()
}

// `decision` with `turn_cuts`.
fn with_cuts(
    decision: Option<RestartDecision>,
    turn_cuts: Vec<TurnCut>,
) -> Option<RestartDecision> {
    decision.map(|decision| RestartDecision {
        turn_cuts,
        ..decision
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
// still owes a limit (`step_limit_owed*`), by letting a pending interrupt win over an owed token
// limit (`*_beside_an_owed_token_limit`), by settling by the first pending row alone, or by a
// limit's row over a person's or the step limit's over the spend limit's
// (`*_beside_a_pending_step_limit`) or the spend limit's over the token limit's
// (`token_limit_beside_a_pending_spend_limit`), by dropping the held child's rule (`held_child_*`),
// by giving a run the wrong turn end or none, and by keeping only the deciding limit's cuts: the
// person's end (`person_interrupt_beside_*_step_limit`), another limit's
// (`*_beside_a_pending_step_limit`, `token_limit_owed_beside_a_step_cut`) or a failed end
// (`failed_beside_a_discharged_step_cut`) then gives a turn the step limit cut `daemonRestart`.
#[rstest]
#[case::queued_behind_a_message(RunState::Queued, false, &[], None, Vec::new(), true, None)]
#[case::queued_with_nothing_to_start_it(
    RunState::Queued,
    false,
    &[],
    None,
    Vec::new(),
    false,
    Some(RestartDecision {
        settlement: RestartSettlement::Failed,
        open_turn_end: None,
        turn_cuts: Vec::new(),
    })
)]
#[case::person_interrupt(
    RunState::Running,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    None,
    Vec::new(),
    false,
    interrupted(None)
)]
#[case::person_naming_step_limit(
    RunState::Running,
    false,
    &[r#"{"pending":"returnToDraft","reason":"stepLimit"}"#],
    None,
    Vec::new(),
    false,
    interrupted(None)
)]
#[case::step_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#],
    None,
    Vec::new(),
    false,
    interrupted(Some(InterruptReason::StepLimit))
)]
#[case::step_limit_pending_and_owed(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#],
    Some(RunLimit::StepLimit),
    cuts(RunLimit::StepLimit, &[1]),
    false,
    with_cuts(interrupted(Some(InterruptReason::StepLimit)), cuts(RunLimit::StepLimit, &[1]))
)]
#[case::spend_limit(
    RunState::WaitingForApproval,
    false,
    &[r#"{"limit":"spendLimit"}"#],
    None,
    Vec::new(),
    false,
    interrupted(Some(InterruptReason::SpendLimit))
)]
#[case::token_limit(
    RunState::Paused,
    true,
    &[r#"{"limit":"tokenLimit"}"#],
    None,
    Vec::new(),
    false,
    stopped_at_token_limit()
)]
#[case::token_limit_beside_a_pending_spend_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"spendLimit"}"#, r#"{"limit":"tokenLimit"}"#],
    None,
    Vec::new(),
    false,
    stopped_at_token_limit()
)]
#[case::person_interrupt_beside_an_owed_token_limit(
    RunState::Running,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    Some(RunLimit::TokenLimit),
    cuts(RunLimit::TokenLimit, &[2]),
    false,
    with_cuts(stopped_at_token_limit(), cuts(RunLimit::TokenLimit, &[2]))
)]
#[case::spend_limit_beside_an_owed_token_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"spendLimit"}"#],
    Some(RunLimit::TokenLimit),
    cuts(RunLimit::TokenLimit, &[1]),
    false,
    with_cuts(stopped_at_token_limit(), cuts(RunLimit::TokenLimit, &[1]))
)]
#[case::token_limit_owed_beside_a_step_cut(
    RunState::Running,
    false,
    &[],
    Some(RunLimit::TokenLimit),
    [cuts(RunLimit::StepLimit, &[1]), cuts(RunLimit::TokenLimit, &[2])].concat(),
    false,
    with_cuts(
        stopped_at_token_limit(),
        [cuts(RunLimit::StepLimit, &[1]), cuts(RunLimit::TokenLimit, &[2])].concat()
    )
)]
#[case::person_interrupt_beside_an_owed_step_limit(
    RunState::Running,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    Some(RunLimit::StepLimit),
    cuts(RunLimit::StepLimit, &[1]),
    false,
    with_cuts(interrupted(None), cuts(RunLimit::StepLimit, &[1]))
)]
#[case::person_interrupt_beside_a_pending_step_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#, r#"{"pending":"nextTurn"}"#],
    Some(RunLimit::StepLimit),
    cuts(RunLimit::StepLimit, &[1]),
    false,
    with_cuts(interrupted(None), cuts(RunLimit::StepLimit, &[1]))
)]
#[case::spend_limit_beside_a_pending_step_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#, r#"{"limit":"spendLimit"}"#],
    Some(RunLimit::StepLimit),
    cuts(RunLimit::StepLimit, &[1]),
    false,
    with_cuts(interrupted(Some(InterruptReason::SpendLimit)), cuts(RunLimit::StepLimit, &[1]))
)]
#[case::held_child_paused(
    RunState::Paused,
    true,
    &[],
    None,
    Vec::new(),
    false,
    interrupted(Some(InterruptReason::DaemonRestart))
)]
#[case::held_child_pausing(
    RunState::Pausing,
    true,
    &[],
    None,
    Vec::new(),
    false,
    interrupted(Some(InterruptReason::DaemonRestart))
)]
#[case::paused_lead(RunState::Paused, false, &[], None, Vec::new(), false, failed_with_its_turn())]
#[case::running_child(
    RunState::Running,
    true,
    &[],
    None,
    Vec::new(),
    false,
    failed_with_its_turn()
)]
#[case::step_limit_owed(
    RunState::Running,
    false,
    &[],
    Some(RunLimit::StepLimit),
    cuts(RunLimit::StepLimit, &[1, 2]),
    false,
    with_cuts(interrupted(Some(InterruptReason::StepLimit)), cuts(RunLimit::StepLimit, &[1, 2]))
)]
#[case::step_limit_owed_with_no_turn_cut(
    RunState::Running,
    false,
    &[],
    Some(RunLimit::StepLimit),
    Vec::new(),
    false,
    interrupted(Some(InterruptReason::StepLimit))
)]
#[case::failed_beside_a_discharged_step_cut(
    RunState::Running,
    false,
    &[],
    None,
    cuts(RunLimit::StepLimit, &[1]),
    false,
    with_cuts(failed_with_its_turn(), cuts(RunLimit::StepLimit, &[1]))
)]
#[case::running(RunState::Running, false, &[], None, Vec::new(), false, failed_with_its_turn())]
fn a_restart_settles_each_live_run_by_what_it_was_waiting_on(
    #[case] state: RunState,
    #[case] has_parent: bool,
    #[case] pending_records: &[&str],
    #[case] owed_limit: Option<RunLimit>,
    #[case] turn_cuts: Vec<TurnCut>,
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
        turn_cuts,
        has_queued_item,
    };

    assert_eq!(decide_restart_settlement(&run, &facts), expected);
}

// Killed by the guard reading a state other than the stored `queued` word, or by dropping its
// run condition: either lets the settle end a run its queue still starts, or refuses one whose
// message is gone.
#[tokio::test]
async fn the_waiting_item_guard_holds_only_while_a_queued_message_targets_the_run() {
    let database = TestDatabase::new();
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let connection = database.reader();
    connection
        .execute_batch(QUEUE_ITEMS_TABLE_SQL)
        .expect("the test makes the queue table");
    connection
        .execute(
            "INSERT INTO queue_items (id, session_id, state, target_run_id, created_at,
               updated_at)
             VALUES ('item', 'session', 'queued', ?1, '', '')",
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
