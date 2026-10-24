//! What a turn's end does with the steers it still holds unechoed.

use rstest::rstest;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tokio::sync::oneshot;

use super::take_blocked_codex_steers;
use crate::provider::driver::codex::run::control::record::{
    CodexRunControlCall, run_codex_run_control_call,
};
use crate::provider::driver::codex::session::test_session::TestCodexSession;
use crate::provider::driver::test_registry::new_run_id;

/// How the turn holding an unechoed steer came to its end.
#[derive(Clone, Copy, Debug)]
enum TurnEnd {
    /// Codex ended it with no interrupt of the daemon's.
    ByItself,
    /// The run's interrupt stopped it, Codex's answer ahead of the end.
    Interrupted,
    /// A pause's interrupt stopped it, the end ahead of Codex's answer.
    PausedAnsweredLate,
}

// Kills: the turn's end keeping the steers no interrupt takes (by itself), letting go of those an
// interrupt still takes as dropped (interrupted), and a pause answered after the end keeping them.
#[rstest]
#[case::by_itself(TurnEnd::ByItself)]
#[case::interrupted(TurnEnd::Interrupted)]
#[case::paused_answered_late(TurnEnd::PausedAnsweredLate)]
#[tokio::test]
async fn a_turns_end_lets_go_of_the_steers_no_interrupt_takes(#[case] end: TurnEnd) {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();
    let steer = QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id");
    let record = &mut session.task.record;
    record.add_active_turn("turn-1".to_owned(), run_id);
    record
        .unechoed_steers_by_turn_id
        .insert("turn-1".to_owned(), vec![steer]);
    match end {
        TurnEnd::ByItself => {}
        TurnEnd::Interrupted => {
            record
                .remember_interrupted_run("turn-1".to_owned(), run_id)
                .expect("the memory has room");
        }
        TurnEnd::PausedAnsweredLate => {
            record.interrupting_turn_ids.insert("turn-1".to_owned());
        }
    }

    let refused = take_blocked_codex_steers(record, "turn-1");
    record.remove_active_turn("turn-1");
    record.remember_settled_turn("turn-1".to_owned());

    assert!(refused.is_empty(), "no hook blocked the steer");
    let kept = record.unechoed_steers_by_turn_id.get("turn-1").cloned();
    match end {
        TurnEnd::ByItself => assert_eq!(kept, None, "nothing takes the steer"),
        TurnEnd::Interrupted => {
            assert_eq!(kept, Some(vec![steer]), "the interrupt takes it as dropped");
        }
        TurnEnd::PausedAnsweredLate => {
            assert_eq!(
                kept,
                Some(vec![steer]),
                "kept while the pause's interrupt is out"
            );
            let (reply, _waiting) = oneshot::channel();
            run_codex_run_control_call(
                CodexRunControlCall::SettlePauseInterrupt {
                    run_id,
                    turn_id: "turn-1".to_owned(),
                    is_stopped: true,
                    reply,
                },
                &mut session.task.record,
                &session.task.calls.runs,
            );
            assert_eq!(
                session.task.record.unechoed_steers_by_turn_id.get("turn-1"),
                None,
                "the pause takes no dropped steers, so its answer lets them go"
            );
        }
    }
}
