use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::state::RunState;
use sidekicks_provider::driver::registry::test_provider;
use sidekicks_provider::run::delivery::{
    InboundDelivery, InboundOutcome, LateAppendableRow, LateEventAbsorbReason,
};
use sidekicks_provider::runtime_binding::store::CreateRuntimeBindingInput;
use sidekicks_provider::runtime_binding::test_store::{
    binding_input, open_store, spawn_config_on, spawned_build, test_provider_account_id,
};
use sidekicks_std::pause_point::ArmedPause;
use sidekicks_store::database::writer::test_file::insert_test_event;
use sidekicks_store::events::test_log::AT;

use super::Harness;

// What the row's run's cursor holds when its row lands.
#[derive(Clone, Copy)]
enum CursorState {
    // Open as the run's start left it.
    Open,
    // Dropped with its binding, as a run's cursors drop once it ended.
    Dropped,
}

// When the undo's rollback lands.
#[derive(Clone, Copy)]
enum RollbackLanding {
    // Before the row arrives.
    BeforeRow,
    // Between the read of the row's opening turn and the row's append.
    BeforeAppend,
}

// The row that lands after its run.
#[derive(Clone, Copy)]
enum LateRow {
    // A held call's close, completed with a body or stopped with none.
    ToolCallClose,
    // The ending of the command `call-1` started.
    CommandEnding,
}

// The run opens `call-1` in turn `opening_turn` of two, then an undo cuts it back to turn 1, and
// the row lands after the run ended. Killed by the opening's turn not read, which appends the cut
// turn's rows; by that read taken outside the append's write, which appends a cut turn's row when
// the rollback lands in between; by an absorb of a kept turn's row; by a command ending that does
// not find its call; by a read of the binding's cursor, which fails once it dropped; by a stamp
// on an appended row; and by a body dropped, or one written for a row that has none.
#[rstest]
#[case::kept_turn_close(
    1,
    LateRow::ToolCallClose,
    CursorState::Open,
    Some("Exported 3 files"),
    RollbackLanding::BeforeRow
)]
#[case::kept_turn_close_dropped_cursor(
    1,
    LateRow::ToolCallClose,
    CursorState::Dropped,
    None,
    RollbackLanding::BeforeRow
)]
#[case::kept_turn_close_rollback_before_append(
    1,
    LateRow::ToolCallClose,
    CursorState::Open,
    Some("Exported 3 files"),
    RollbackLanding::BeforeAppend
)]
#[case::cut_turn_close(
    2,
    LateRow::ToolCallClose,
    CursorState::Open,
    None,
    RollbackLanding::BeforeRow
)]
#[case::cut_turn_close_dropped_cursor(
    2,
    LateRow::ToolCallClose,
    CursorState::Dropped,
    None,
    RollbackLanding::BeforeRow
)]
#[case::cut_turn_command(
    2,
    LateRow::CommandEnding,
    CursorState::Dropped,
    None,
    RollbackLanding::BeforeRow
)]
#[case::cut_turn_close_rollback_before_append(
    2,
    LateRow::ToolCallClose,
    CursorState::Open,
    None,
    RollbackLanding::BeforeAppend
)]
#[case::cut_turn_command_rollback_before_append(
    2,
    LateRow::CommandEnding,
    CursorState::Dropped,
    None,
    RollbackLanding::BeforeAppend
)]
#[tokio::test]
async fn inbound_absorbs_an_after_run_row_only_from_a_cut_turn(
    #[case] opening_turn: u64,
    #[case] late_row: LateRow,
    #[case] cursor: CursorState,
    #[case] body: Option<&'static str>,
    #[case] rollback_landing: RollbackLanding,
) {
    // The run has ended, as a held call's run has by the time the call closes.
    let harness = Harness::new(RunState::Completed).await;
    let session_id = harness.session_id();
    let run_id = harness.run_id;
    open_store(&harness.database)
        .await
        .create(CreateRuntimeBindingInput {
            id: harness.binding_id.clone(),
            run_id,
            provider_name: test_provider(),
            ..binding_input(
                spawn_config_on(test_provider_account_id()),
                spawned_build("1.0.0", "/opt/provider/bin"),
            )
        })
        .await
        .expect("the run's binding is recorded");
    let writer = harness.database.reader();
    let write = |event: Value, body: Option<&str>| {
        insert_test_event(&writer, session_id, event, body, AT);
    };
    for turn_number in 1..=2 {
        write(
            json!({
                "type": "agent.turn.started",
                "payload": {
                    "sessionId": session_id,
                    "runId": run_id,
                    "runVersion": 1,
                    "turnNumber": turn_number,
                },
            }),
            None,
        );
        if turn_number == opening_turn {
            write(
                json!({
                    "type": "agent.toolCall.invoked",
                    "payload": {
                        "sessionId": session_id,
                        "runId": run_id,
                        "toolName": "Bash",
                        "toolCallId": "call-1",
                    },
                }),
                Some("npm run export"),
            );
        }
    }
    let roll_back = || {
        write(
            json!({
                "type": "agent.run.rolledBack",
                "payload": {
                    "sessionId": session_id,
                    "runId": run_id,
                    "runVersion": 2,
                    "targetPosition": 1,
                },
            }),
            None,
        );
    };
    if let RollbackLanding::BeforeRow = rollback_landing {
        roll_back();
    }
    if let CursorState::Dropped = cursor {
        harness
            .epochs
            .lock()
            .expect("no test thread panics holding the cursors")
            .close_binding(&harness.binding_id);
    }
    let call = json!({
        "sessionId": session_id,
        "runId": run_id,
        "toolName": "Bash",
        "toolCallId": "call-1",
    });
    let row = match (late_row, body) {
        (LateRow::ToolCallClose, Some(_)) => LateAppendableRow::AgentToolCallCompleted(
            serde_json::from_value(call).expect("the test writes a completion's payload"),
        ),
        (LateRow::ToolCallClose, None) => {
            let mut stopped = call;
            stopped["endCause"] = json!("stopped");
            LateAppendableRow::AgentToolCallFailed(
                serde_json::from_value(stopped).expect("the test writes a failure's payload"),
            )
        }
        (LateRow::CommandEnding, _) => LateAppendableRow::AgentCommandEnded(
            serde_json::from_value(json!({
                "sessionId": session_id,
                "runId": run_id,
                "commandId": "task-1",
                "toolCallId": "call-1",
                "ending": "endedByPerson",
                "durationMs": 5,
            }))
            .expect("the test writes a command ending's payload"),
        ),
    };
    let stored_before = harness.stored_event_count();
    let held_append = match rollback_landing {
        RollbackLanding::BeforeRow => None,
        RollbackLanding::BeforeAppend => Some(harness.dispatch.after_run_append_pause.arm()),
    };
    let roll_back_before_append = async {
        let Some(ArmedPause { reached, release }) = held_append else {
            return;
        };
        reached.await.expect("the row's opening turn is read");
        roll_back();
        release.send(()).expect("the row's append waits");
    };

    let (outcome, ()) = tokio::join!(
        harness.dispatched(InboundDelivery::AfterRunRow {
            binding_id: harness.binding_id.clone(),
            row,
            content: body.map(str::to_owned),
        }),
        roll_back_before_append,
    );

    if opening_turn == 2 {
        assert_eq!(
            outcome,
            InboundOutcome::Absorbed {
                reason: LateEventAbsorbReason::BeforeCut,
            }
        );
        let rolled_back_since = match rollback_landing {
            RollbackLanding::BeforeRow => 0,
            RollbackLanding::BeforeAppend => 1,
        };
        assert_eq!(
            harness.stored_event_count(),
            stored_before + rolled_back_since
        );
        return;
    }
    let InboundOutcome::Appended { event_id } = outcome else {
        panic!("a kept turn's row is appended as it is: {outcome:?}");
    };
    let (source_epoch, source_position, content) = harness
        .database
        .reader()
        .query_row(
            "SELECT json_extract(payload, '$.sourceEpoch'), json_extract(payload, '$.sourcePosition'),
                    content_payload
             FROM session_events WHERE id = ?1",
            [event_id.as_str()],
            |stored| {
                Ok((
                    stored.get::<_, Option<i64>>(0)?,
                    stored.get::<_, Option<i64>>(1)?,
                    stored.get::<_, Option<Vec<u8>>>(2)?,
                ))
            },
        )
        .expect("the test reads the appended row");
    assert_eq!((source_epoch, source_position), (None, None));
    // A body under a kibibyte is stored as its UTF-8 bytes.
    assert_eq!(content.as_deref(), body.map(str::as_bytes));
}
