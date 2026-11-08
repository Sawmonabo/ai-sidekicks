//! Where a steer's landing moves its binding's cursor.

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::run::delivery::{
    DeliveryOperation, InboundDelivery, InboundOutcome, LateAppendableRow, LateEventAbsorbReason,
};

use super::Harness;
use crate::run::engine::tests::{minted_item, send, turn};
use crate::run::epochs::ConfirmedCut;

// The steer the provider reports taken.
#[derive(Clone, Copy)]
enum Steer {
    // A message the person sent.
    Sent,
    // An id the log holds no sent message for, as the daemon's own words written into the turn.
    NeverSent,
    // A message the person sent, reported once a fork and restart froze the binding.
    OnFrozenBinding,
}

// A sent steer moves its binding to the next run position once its row is written, so a tool call
// opened after it and cut back to the opening's position is stamped at the steer's position; an
// unsent message moves nothing; a frozen binding's steer is absorbed as from before the cut.
// Killed by the arm moving no cursor (the sent case's late row at (0, 1)), by the frozen check
// skipped (a steer row written for the cut execution) and by the cursor moved without the write
// (the unsent case's late row at (0, 2)).
#[rstest]
#[case::sent(Steer::Sent)]
#[case::never_sent(Steer::NeverSent)]
#[case::on_a_frozen_binding(Steer::OnFrozenBinding)]
#[tokio::test]
async fn a_landed_steer_moves_its_binding_to_the_next_position(#[case] steer: Steer) {
    let harness = Harness::new(RunState::Running).await;
    let (session_id, run_id) = (harness.session_id(), harness.run_id);
    let appender = &harness.dispatch.appender;
    let [opening, steered] = [(); 2].map(|()| minted_item());
    send(appender, session_id, run_id, opening).await;
    if !matches!(steer, Steer::NeverSent) {
        send(appender, session_id, run_id, steered).await;
    }
    let cut_at = |point| SourcePosition(SafeInt::new(point).expect("a small position"));
    assert_eq!(
        harness
            .dispatched(InboundDelivery::TurnBoundary {
                binding_id: harness.binding_id.clone(),
            })
            .await,
        InboundOutcome::TurnOpened
    );
    let started = harness
        .engine
        .start_turn(run_id, None, None, None, Some(opening))
        .await
        .expect("the turn's start is written")
        .map(|started| started.turn_number);
    assert_eq!(started, Some(turn(1)));
    if let Steer::OnFrozenBinding = steer {
        harness
            .epochs
            .lock()
            .expect("no test thread panics holding the cursors")
            .fence_cut(ConfirmedCut::ForkRestart {
                binding_id: harness.binding_id.clone(),
                point: cut_at(1),
                new_binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string())
                    .expect("a UUID is a binding id"),
            })
            .expect("the cursor is open and not frozen");
    }

    let outcome = harness
        .dispatched(InboundDelivery::TurnSteered {
            binding_id: harness.binding_id.clone(),
            turn_number: turn(1),
            message_id: steered,
        })
        .await;

    let steered_rows = harness
        .stored_event_types()
        .into_iter()
        .filter(|event_type| event_type == "agent.turn.steered")
        .count();
    match steer {
        Steer::Sent => {
            assert!(
                matches!(outcome, InboundOutcome::Appended { .. }),
                "{outcome:?}"
            );
            assert_eq!(steered_rows, 1);
        }
        Steer::NeverSent => {
            assert_eq!(outcome, InboundOutcome::NotSentByPerson);
            assert_eq!(steered_rows, 0);
        }
        Steer::OnFrozenBinding => {
            assert_eq!(
                outcome,
                InboundOutcome::Absorbed {
                    reason: LateEventAbsorbReason::BeforeCut,
                }
            );
            assert_eq!(steered_rows, 0);
            return;
        }
    }

    // A tool call opens after the steer, an in-place cut goes back to the opening's position, and
    // the call's late row is stamped with the position it opened at.
    let call = json!({
        "sessionId": session_id,
        "runId": run_id,
        "toolName": "Bash",
        "toolCallId": "call-1",
    });
    let on_call = |is_opening| {
        Some(DeliveryOperation {
            correlation_key: "call-1",
            is_opening,
        })
    };
    harness
        .dispatched(InboundDelivery::SessionRow {
            binding: harness.on_binding(on_call(true)),
            row: LateAppendableRow::AgentToolCallInvoked(
                serde_json::from_value(call.clone()).expect("the test writes a call's payload"),
            ),
            content: Some("npm test".to_owned()),
        })
        .await;
    harness
        .epochs
        .lock()
        .expect("no test thread panics holding the cursors")
        .fence_cut(ConfirmedCut::InPlace {
            binding_id: harness.binding_id.clone(),
            point: cut_at(1),
        })
        .expect("the cursor is open and not frozen");
    let late = harness
        .dispatched(InboundDelivery::SessionRow {
            binding: harness.on_binding(on_call(false)),
            row: LateAppendableRow::AgentToolCallCompleted(
                serde_json::from_value(call).expect("the test writes a completion's payload"),
            ),
            content: None,
        })
        .await;
    let InboundOutcome::Appended { event_id } = late else {
        panic!("the late row is appended with its stamp: {late:?}");
    };
    let stamp: (Option<i64>, Option<i64>) = harness
        .database
        .reader()
        .query_row(
            "SELECT json_extract(payload, '$.sourceEpoch'), json_extract(payload, '$.sourcePosition')
             FROM session_events WHERE id = ?1",
            [event_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the test reads the late row's stamp");
    let opened_at = match steer {
        Steer::Sent => 2,
        Steer::NeverSent | Steer::OnFrozenBinding => 1,
    };
    assert_eq!(stamp, (Some(0), Some(opened_at)));
}
