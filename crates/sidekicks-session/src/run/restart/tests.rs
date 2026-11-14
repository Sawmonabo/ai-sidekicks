use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor, TurnEndCause};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterruptInterventionRecord, InterventionId, RunLimit,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::session_control::ProviderTurnAnswer;
use sidekicks_store::database::statement::DATABASE_NOW_SQL;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};

use super::{
    PendingInterrupt, RestartDecision, RestartFacts, RestartSettlement, RestartTurnEnd,
    ResumedRunMove, decide_restart_settlement, decide_resumed_move, decide_stop_settlement,
    no_waiting_item_statement, read_is_run_stopping,
};
use crate::interventions::store::UnresolvedInterventionState;
use crate::questions::schema::schema_parts;
use crate::run::read::{LiveRun, RunRead};

fn ends(settlement: RestartSettlement, turn_end: RestartTurnEnd) -> RestartDecision {
    RestartDecision {
        settlement,
        open_turn_end: Some(turn_end),
        turn_cause: TurnEndCause::DaemonRestart,
    }
}

// `decision` as the person's stop of the service decides it, its uncut turns ending `daemonStop`.
fn at_stop(decision: RestartDecision) -> RestartDecision {
    RestartDecision {
        turn_cause: TurnEndCause::DaemonStop,
        ..decision
    }
}

// A live run `state`, a child where `has_parent`, as a restart or a stop finds it.
fn live_run(state: RunState, has_parent: bool) -> LiveRun {
    LiveRun {
        run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        run: RunRead {
            version: 4,
            session_id: test_session_id(),
            state,
        },
        parent_run_id: has_parent
            .then(|| RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")),
        reached_by: None,
    }
}

// Each record as the interrupt a restart or a stop finds pending.
fn pending_interrupts(pending_records: &[&str]) -> Vec<PendingInterrupt> {
    pending_records
        .iter()
        .map(|record| PendingInterrupt {
            intervention_id: InterventionId::try_from(mint_uuid_v7())
                .expect("a minted UUID is an intervention id"),
            state: UnresolvedInterventionState::Accepted,
            actor: InterventionActor::Daemon(DaemonInterventionActor::Value),
            record: serde_json::from_str::<InterruptInterventionRecord>(record)
                .expect("the test's record reads as stored"),
            expected_run_version: SafeInt::new(4).expect("a test version"),
            client_idempotency_key: ClientUuid::new(mint_uuid_v7().to_string())
                .expect("a minted UUID is a client key"),
        })
        .collect()
}

fn stopped_at_token_limit() -> RestartDecision {
    ends(
        RestartSettlement::Stopped {
            trigger: StopTrigger::TokenLimit,
        },
        RestartTurnEnd::Interrupted,
    )
}

fn interrupted(trigger: Option<InterruptReason>) -> RestartDecision {
    ends(
        RestartSettlement::Interrupted { trigger },
        RestartTurnEnd::Interrupted,
    )
}

fn failed_with_its_turn() -> RestartDecision {
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
// by failing a lead the person paused or leaving its pause under way unreached (`*_lead`), by
// keeping a paused lead past a stop it waits on (`paused_lead_with_a_person_interrupt`), by
// failing a provider's helper whose lead's stop wins, which the restart cut
// (`helper_of_a_stopping_lead_*` read `failed_with_its_turn()` with the stopping arm dropped), and
// by giving a run the wrong turn end or none, and by an undo's row settled as the person's
// (`undo_interrupt` reads interrupted with no trigger where a pending row without a limit counts).
#[rstest]
#[case::queued_behind_a_message(RunState::Queued, false, &[], None, true, false, None)]
#[case::queued_with_nothing_to_start_it(
    RunState::Queued,
    false,
    &[],
    None,
    false,
    false,
    Some(RestartDecision {
        settlement: RestartSettlement::Failed,
        open_turn_end: None,
        turn_cause: TurnEndCause::DaemonRestart,
    })
)]
#[case::person_interrupt(
    RunState::Running,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    None,
    false,
    false,
    Some(interrupted(None))
)]
#[case::person_naming_step_limit(
    RunState::Running,
    false,
    &[r#"{"pending":"returnToDraft","reason":"stepLimit"}"#],
    None,
    false,
    false,
    Some(interrupted(None))
)]
#[case::step_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#],
    None,
    false,
    false,
    Some(interrupted(Some(InterruptReason::StepLimit)))
)]
#[case::step_limit_pending_and_owed(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#],
    Some(RunLimit::StepLimit),
    false,
    false,
    Some(interrupted(Some(InterruptReason::StepLimit)))
)]
#[case::spend_limit(
    RunState::WaitingForApproval,
    false,
    &[r#"{"limit":"spendLimit"}"#],
    None,
    false,
    false,
    Some(interrupted(Some(InterruptReason::SpendLimit)))
)]
#[case::token_limit(
    RunState::Paused,
    true,
    &[r#"{"limit":"tokenLimit"}"#],
    None,
    false,
    false,
    Some(stopped_at_token_limit())
)]
#[case::token_limit_beside_a_pending_spend_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"spendLimit"}"#, r#"{"limit":"tokenLimit"}"#],
    None,
    false,
    false,
    Some(stopped_at_token_limit())
)]
#[case::person_interrupt_beside_an_owed_token_limit(
    RunState::Running,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    Some(RunLimit::TokenLimit),
    false,
    false,
    Some(stopped_at_token_limit())
)]
#[case::spend_limit_beside_an_owed_token_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"spendLimit"}"#],
    Some(RunLimit::TokenLimit),
    false,
    false,
    Some(stopped_at_token_limit())
)]
#[case::person_interrupt_beside_an_owed_step_limit(
    RunState::Running,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    Some(RunLimit::StepLimit),
    false,
    false,
    Some(interrupted(None))
)]
#[case::person_interrupt_beside_a_pending_step_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#, r#"{"pending":"nextTurn"}"#],
    Some(RunLimit::StepLimit),
    false,
    false,
    Some(interrupted(None))
)]
#[case::spend_limit_beside_a_pending_step_limit(
    RunState::Running,
    false,
    &[r#"{"limit":"stepLimit"}"#, r#"{"limit":"spendLimit"}"#],
    Some(RunLimit::StepLimit),
    false,
    false,
    Some(interrupted(Some(InterruptReason::SpendLimit)))
)]
#[case::held_child_paused(
    RunState::Paused,
    true,
    &[],
    None,
    false,
    false,
    Some(interrupted(Some(InterruptReason::DaemonRestart)))
)]
#[case::held_child_pausing(
    RunState::Pausing,
    true,
    &[],
    None,
    false,
    false,
    Some(interrupted(Some(InterruptReason::DaemonRestart)))
)]
#[case::paused_lead(RunState::Paused, false, &[], None, false, false, None)]
#[case::pausing_lead(
    RunState::Pausing,
    false,
    &[],
    None,
    false,
    false,
    Some(ends(RestartSettlement::Paused, RestartTurnEnd::Interrupted))
)]
#[case::paused_lead_with_a_person_interrupt(
    RunState::Paused,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    None,
    false,
    false,
    Some(interrupted(None))
)]
#[case::running_child(
    RunState::Running,
    true,
    &[],
    None,
    false,
    false,
    Some(failed_with_its_turn())
)]
#[case::step_limit_owed(
    RunState::Running,
    false,
    &[],
    Some(RunLimit::StepLimit),
    false,
    false,
    Some(interrupted(Some(InterruptReason::StepLimit)))
)]
#[case::helper_of_a_stopping_lead_running(
    RunState::Running,
    true,
    &[],
    None,
    false,
    true,
    Some(interrupted(Some(InterruptReason::DaemonRestart)))
)]
#[case::helper_of_a_stopping_lead_waiting_for_approval(
    RunState::WaitingForApproval,
    true,
    &[],
    None,
    false,
    true,
    Some(interrupted(Some(InterruptReason::DaemonRestart)))
)]
#[case::running(RunState::Running, false, &[], None, false, false, Some(failed_with_its_turn()))]
#[case::undo_interrupt(
    RunState::Running,
    false,
    &[r#"{"undoKey":"0190f2a0-0000-7000-8000-000000000006"}"#],
    None,
    false,
    false,
    Some(failed_with_its_turn())
)]
fn a_restart_settles_each_live_run_by_what_it_was_waiting_on(
    #[case] state: RunState,
    #[case] has_parent: bool,
    #[case] pending_records: &[&str],
    #[case] owed_limit: Option<RunLimit>,
    #[case] has_queued_item: bool,
    #[case] is_stopping: bool,
    #[case] expected: Option<RestartDecision>,
) {
    let run = live_run(state, has_parent);
    let facts = RestartFacts {
        pending_interrupts: pending_interrupts(pending_records),
        owed_limit,
        turn_cuts: Vec::new(),
        is_stopping,
        has_queued_item,
        is_refusal_waiting: false,
    };

    assert_eq!(decide_restart_settlement(&run, &facts), expected);
}

// The person's stop of the service, one case per row of its table; the Stop reads no lead's stop
// for a helper, so a helper beneath a stopping lead reads as `running` does. Killed by the queued
// arm keyed on a waiting message as the restart's is, or ending the run failed (`queued_*`); by a
// pausing lead paused (`pausing_lead`); by the refusal row read as interrupted
// (`waiting_on_the_refusal`); by a run's own stop dropped (`person_interrupt`, `step_limit_owed`);
// by a paused lead ended (`paused_lead`); and by the cause left `daemonRestart`, in the run's
// trigger or its turns'.
#[rstest]
#[case::running(RunState::Running, false, &[], None, false, false, Some(stop_interrupted()))]
#[case::waiting_for_approval(
    RunState::WaitingForApproval,
    false,
    &[],
    None,
    false,
    false,
    Some(stop_interrupted())
)]
#[case::pausing_lead(RunState::Pausing, false, &[], None, false, false, Some(stop_interrupted()))]
#[case::paused_child(RunState::Paused, true, &[], None, false, false, Some(stop_interrupted()))]
#[case::person_interrupt(
    RunState::Running,
    false,
    &[r#"{"pending":"nextTurn"}"#],
    None,
    false,
    false,
    Some(at_stop(interrupted(None)))
)]
#[case::step_limit_owed(
    RunState::Running,
    false,
    &[],
    Some(RunLimit::StepLimit),
    false,
    false,
    Some(at_stop(interrupted(Some(InterruptReason::StepLimit))))
)]
#[case::paused_lead(RunState::Paused, false, &[], None, false, false, None)]
#[case::queued_behind_a_message(
    RunState::Queued,
    false,
    &[],
    None,
    true,
    false,
    Some(stop_queued())
)]
#[case::queued_with_nothing_waiting(
    RunState::Queued,
    false,
    &[],
    None,
    false,
    false,
    Some(stop_queued())
)]
#[case::waiting_on_the_refusal(
    RunState::WaitingForInput,
    false,
    &[],
    None,
    false,
    true,
    Some(at_stop(ends(RestartSettlement::Refused, RestartTurnEnd::Interrupted)))
)]
fn a_stop_settles_each_live_run_by_its_table(
    #[case] state: RunState,
    #[case] has_parent: bool,
    #[case] pending_records: &[&str],
    #[case] owed_limit: Option<RunLimit>,
    #[case] has_queued_item: bool,
    #[case] is_refusal_waiting: bool,
    #[case] expected: Option<RestartDecision>,
) {
    let run = live_run(state, has_parent);
    let facts = RestartFacts {
        pending_interrupts: pending_interrupts(pending_records),
        owed_limit,
        turn_cuts: Vec::new(),
        is_stopping: false,
        has_queued_item,
        is_refusal_waiting,
    };

    assert_eq!(decide_stop_settlement(&run, &facts), expected);
}

fn stop_interrupted() -> RestartDecision {
    at_stop(interrupted(Some(InterruptReason::DaemonStop)))
}

fn stop_queued() -> RestartDecision {
    RestartDecision {
        settlement: RestartSettlement::Stopped {
            trigger: StopTrigger::DaemonStop,
        },
        open_turn_end: None,
        turn_cause: TurnEndCause::DaemonStop,
    }
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

// One case per row of how a stop meets a resume, through each answer the provider gives. Killed by
// the stopping arms placed after the pause arms (`stopping_paused_still_running` reads `Left`,
// `stopping_pausing_gone` reads `Paused`), by the exception for a turn still running dropped
// (`stopping_*_still_running` but `paused` read `TurnGone`), by the stopping waiting run left
// waiting (`stopping_waiting_*_still_running` read `Left`), by a queued run moved, by a run no
// stop waits on moved otherwise than before, and by `Waiting` folded into `Gone` (`*_waiting` read
// `TurnGone` or `Paused { is_turn_gone: true }`).
#[rstest]
#[case::stopping_starting_still_running(
    RunState::Starting,
    false,
    true,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::Running
)]
#[case::stopping_starting_ended(
    RunState::Starting,
    false,
    true,
    ProviderTurnAnswer::EndedByProvider,
    ResumedRunMove::TurnGone
)]
#[case::stopping_starting_gone(
    RunState::Starting,
    false,
    true,
    ProviderTurnAnswer::Gone,
    ResumedRunMove::TurnGone
)]
#[case::stopping_running_still_running(
    RunState::Running,
    false,
    true,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::Running
)]
#[case::stopping_running_ended(
    RunState::Running,
    false,
    true,
    ProviderTurnAnswer::EndedByProvider,
    ResumedRunMove::TurnGone
)]
#[case::stopping_running_gone(
    RunState::Running,
    false,
    true,
    ProviderTurnAnswer::Gone,
    ResumedRunMove::TurnGone
)]
#[case::stopping_waiting_for_approval_still_running(
    RunState::WaitingForApproval,
    false,
    true,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::Running
)]
#[case::stopping_waiting_for_approval_ended(
    RunState::WaitingForApproval,
    false,
    true,
    ProviderTurnAnswer::EndedByProvider,
    ResumedRunMove::TurnGone
)]
#[case::stopping_waiting_for_input_still_running(
    RunState::WaitingForInput,
    false,
    true,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::Running
)]
#[case::stopping_waiting_for_input_gone(
    RunState::WaitingForInput,
    false,
    true,
    ProviderTurnAnswer::Gone,
    ResumedRunMove::TurnGone
)]
#[case::stopping_helper_still_running(
    RunState::Running,
    true,
    true,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::Running
)]
#[case::stopping_helper_gone(
    RunState::Running,
    true,
    true,
    ProviderTurnAnswer::Gone,
    ResumedRunMove::TurnGone
)]
#[case::stopping_pausing_still_running(
    RunState::Pausing,
    false,
    true,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::Running
)]
#[case::stopping_pausing_ended(
    RunState::Pausing,
    false,
    true,
    ProviderTurnAnswer::EndedByProvider,
    ResumedRunMove::TurnGone
)]
#[case::stopping_pausing_gone(
    RunState::Pausing,
    false,
    true,
    ProviderTurnAnswer::Gone,
    ResumedRunMove::TurnGone
)]
#[case::stopping_paused_still_running(
    RunState::Paused,
    false,
    true,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::TurnGone
)]
#[case::stopping_paused_ended(
    RunState::Paused,
    false,
    true,
    ProviderTurnAnswer::EndedByProvider,
    ResumedRunMove::TurnGone
)]
#[case::stopping_paused_gone(
    RunState::Paused,
    false,
    true,
    ProviderTurnAnswer::Gone,
    ResumedRunMove::TurnGone
)]
#[case::queued_still_running(
    RunState::Queued,
    false,
    true,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::Left
)]
#[case::queued_ended(
    RunState::Queued,
    false,
    false,
    ProviderTurnAnswer::EndedByProvider,
    ResumedRunMove::Left
)]
#[case::queued_gone(
    RunState::Queued,
    false,
    true,
    ProviderTurnAnswer::Gone,
    ResumedRunMove::Left
)]
#[case::running_still_running(
    RunState::Running,
    false,
    false,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::Running
)]
#[case::running_ended(
    RunState::Running,
    false,
    false,
    ProviderTurnAnswer::EndedByProvider,
    ResumedRunMove::Left
)]
#[case::running_gone(
    RunState::Running,
    false,
    false,
    ProviderTurnAnswer::Gone,
    ResumedRunMove::TurnGone
)]
#[case::waiting_for_approval_still_running(
    RunState::WaitingForApproval,
    false,
    false,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::Left
)]
#[case::pausing_gone(
    RunState::Pausing,
    false,
    false,
    ProviderTurnAnswer::Gone,
    ResumedRunMove::Paused { is_turn_gone: true }
)]
#[case::paused_still_running(
    RunState::Paused,
    false,
    false,
    ProviderTurnAnswer::StillRunning,
    ResumedRunMove::Left
)]
#[case::paused_gone(
    RunState::Paused,
    false,
    false,
    ProviderTurnAnswer::Gone,
    ResumedRunMove::Left
)]
#[case::waiting_for_approval_waiting(
    RunState::WaitingForApproval,
    false,
    false,
    ProviderTurnAnswer::Waiting,
    ResumedRunMove::Left
)]
#[case::held_lead_running_waiting(
    RunState::Running,
    false,
    false,
    ProviderTurnAnswer::Waiting,
    ResumedRunMove::Left
)]
#[case::paused_child_waiting(
    RunState::Paused,
    true,
    false,
    ProviderTurnAnswer::Waiting,
    ResumedRunMove::Left
)]
#[case::moved_pausing_lead_waiting(
    RunState::Pausing,
    false,
    false,
    ProviderTurnAnswer::Waiting,
    ResumedRunMove::Left
)]
fn a_pending_stop_wins_over_the_resume_before_any_pause(
    #[case] state_before: RunState,
    #[case] is_child: bool,
    #[case] is_stopping: bool,
    #[case] answer: ProviderTurnAnswer,
    #[case] expected: ResumedRunMove,
) {
    assert_eq!(
        decide_resumed_move(state_before, is_child, is_stopping, answer),
        expected
    );
}

// A lead the person asked to stop: its provider's helper and that helper's own helper read
// stopping, while a run the lead reached through the bridge, a lead with no stop and its helper,
// and a lead with only an undo's interrupt left pending and its helper do not. Killed by the helper
// clause dropped (the helpers read not stopping), by the walk stopping at one level (the helper's
// helper does), by any child counted a helper (the bridged run does), by the run's own stops
// dropped (the lead does), and by the pending read keeping an undo's row (the undo's lead does).
#[test]
fn a_helper_of_a_stopping_lead_reads_stopping() {
    let database = TestDatabase::new(schema_parts());
    let reader = database.opener()().expect("the test creates its database");
    let session_id = test_session_id();
    let new_run = |parent: Option<RunId>, reached_by: Option<&str>| {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        reader
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version, parent_run_id,
                   reached_by)
                 VALUES (?1, ?2, 'running', 1, ?3, ?4)",
                params![
                    run_id.text().as_str(),
                    session_id.text().as_str(),
                    parent.map(|parent| parent.text().as_str().to_owned()),
                    reached_by,
                ],
            )
            .expect("the test writes the run");
        run_id
    };
    let stopping_lead = new_run(None, None);
    let helper = new_run(Some(stopping_lead), Some("providerSubagent"));
    let helpers_helper = new_run(Some(helper), Some("providerSubagent"));
    let bridged = new_run(Some(stopping_lead), Some("bridgeRun"));
    let lead = new_run(None, None);
    let lead_helper = new_run(Some(lead), Some("providerSubagent"));
    let undo_lead = new_run(None, None);
    let undo_lead_helper = new_run(Some(undo_lead), Some("providerSubagent"));
    for (run_id, record) in [
        (stopping_lead, r#"{"pending":"nextTurn"}"#),
        (
            undo_lead,
            r#"{"undoKey":"0190f2a0-0000-7000-8000-000000000007"}"#,
        ),
    ] {
        reader
            .execute(
                &format!(
                    "INSERT INTO interventions (id, target_run_id, type, state, payload,
                       expected_run_version, client_idempotency_key, created_at)
                     VALUES (?1, ?2, 'interrupt', 'accepted', ?3, 1, ?1, {DATABASE_NOW_SQL})"
                ),
                params![mint_uuid_v7().to_string(), run_id.text().as_str(), record],
            )
            .expect("the test records the pending interrupt");
    }

    for (run_id, is_stopping) in [
        (stopping_lead, true),
        (helper, true),
        (helpers_helper, true),
        (bridged, false),
        (lead, false),
        (lead_helper, false),
        (undo_lead, false),
        (undo_lead_helper, false),
    ] {
        assert_eq!(
            read_is_run_stopping(&reader, &run_id).expect("the stops read"),
            is_stopping,
            "{run_id}"
        );
    }
}
