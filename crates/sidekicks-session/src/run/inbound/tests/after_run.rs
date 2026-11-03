use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::registry::test_provider;
use sidekicks_provider::run::delivery::{InboundDelivery, InboundOutcome, LateAppendableRow};
use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;

use super::Harness;
use crate::run::epochs::{ConfirmedCut, EpochBinding};

// What the row's run's cursor holds when its row lands.
#[derive(Clone, Copy)]
enum CursorState {
    // Open as the run's start left it.
    Open,
    // Frozen by a fork and restart onto a new binding.
    FrozenByAForkRestart,
    // Dropped with its binding.
    Dropped,
}

// Killed by the arm attributing on its binding's cursor: a dropped cursor fails `NotOpen`, a frozen
// one stamps the frozen pair (`AppendedStamped`) or absorbs the row as from before the cut; and by
// a body dropped, or one written for a row that has none.
#[rstest]
#[case::open(CursorState::Open, Some("Exported 3 files"))]
#[case::frozen_by_a_fork_restart(CursorState::FrozenByAForkRestart, None)]
#[case::dropped(CursorState::Dropped, None)]
#[tokio::test]
async fn inbound_appends_an_after_run_row_as_it_is_whatever_its_cursor_holds(
    #[case] cursor: CursorState,
    #[case] body: Option<&'static str>,
) {
    // The run has ended, as a held call's run has by the time the call closes.
    let harness = Harness::new(RunState::Completed).await;
    {
        let mut epochs = harness
            .epochs
            .lock()
            .expect("no test thread panics holding the cursors");
        match cursor {
            CursorState::Open => {}
            CursorState::FrozenByAForkRestart => epochs
                .fence_cut(ConfirmedCut::ForkRestart {
                    binding_id: harness.binding_id.clone(),
                    point: SourcePosition(SafeInt::new(1).expect("a small turn")),
                    new_binding: EpochBinding {
                        id: RuntimeBindingId::new(mint_uuid_v7().to_string())
                            .expect("a UUID is a binding id"),
                        run_id: harness.run_id,
                        provider_name: test_provider(),
                        provider_account_id: test_provider_account_id(),
                    },
                })
                .expect("the cursor is open and not frozen"),
            CursorState::Dropped => epochs.close_binding(&harness.binding_id),
        }
    }
    let mut call = json!({
        "sessionId": harness.session_id(),
        "runId": harness.run_id,
        "toolName": "export",
        "toolCallId": "call-1",
    });
    // A call that closes with a body completed; one that closes with none was stopped.
    let row = if body.is_some() {
        LateAppendableRow::AgentToolCallCompleted(
            serde_json::from_value(call).expect("the test writes a completion's payload"),
        )
    } else {
        call["endCause"] = json!("stopped");
        LateAppendableRow::AgentToolCallFailed(
            serde_json::from_value(call).expect("the test writes a failure's payload"),
        )
    };

    let outcome = harness
        .dispatched(InboundDelivery::AfterRunRow {
            binding_id: harness.binding_id.clone(),
            row,
            content: body.map(str::to_owned),
        })
        .await;

    let InboundOutcome::Appended { event_id } = outcome else {
        panic!("the row is appended as it is: {outcome:?}");
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
