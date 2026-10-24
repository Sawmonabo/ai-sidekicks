//! What a turn's end does with the steers it still holds unechoed.

use rstest::rstest;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::take_blocked_codex_steers;
use crate::provider::driver::codex::delivery::frames::CodexTurnEnding;
use crate::provider::driver::codex::session::state::CodexUnechoedSteers;
use crate::provider::driver::codex::session::test_session::TestCodexSession;
use crate::provider::driver::test_registry::new_run_id;

/// How the turn holding an unechoed steer came to its end.
#[derive(Clone, Copy, Debug)]
enum TurnEnd {
    /// Codex ended it with no interrupt of the daemon's.
    ByItself,
    /// The run's interrupt stopped it, Codex's answer ahead of the end.
    Interrupted,
    /// The run's interrupt stopped it, the end ahead of Codex's answer.
    InterruptedAnsweredLate,
    /// A pause's interrupt stopped it.
    Paused,
    /// A faster-model retry stopped it.
    Retried,
}

// Kills: the turn's end keeping the steers no interrupt takes (by itself), letting go of those an
// interrupt or a retry still takes as dropped (interrupted, its answer after the end among them,
// and retried, which gives them back once its new turn runs), and a pause letting its steers go
// rather than dropping them for the queue.
#[rstest]
#[case::by_itself(TurnEnd::ByItself)]
#[case::interrupted(TurnEnd::Interrupted)]
#[case::interrupted_answered_late(TurnEnd::InterruptedAnsweredLate)]
#[case::paused(TurnEnd::Paused)]
#[case::retried(TurnEnd::Retried)]
#[tokio::test]
async fn a_turns_end_drops_or_lets_go_of_the_steers_no_interrupt_takes(#[case] end: TurnEnd) {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();
    let steer = QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id");
    let record = &mut session.task.record;
    record.add_active_turn("turn-1".to_owned(), run_id);
    record
        .unechoed_steers_by_turn_id
        .entry("turn-1".to_owned())
        .or_default()
        .register(steer);
    let ending = match end {
        TurnEnd::ByItself => CodexTurnEnding::Live,
        TurnEnd::Interrupted => {
            record
                .remember_interrupted_run("turn-1".to_owned(), run_id)
                .expect("the memory has room");
            CodexTurnEnding::Interrupted
        }
        TurnEnd::InterruptedAnsweredLate => {
            record.interrupting_turn_ids.insert("turn-1".to_owned());
            CodexTurnEnding::Live
        }
        TurnEnd::Paused => CodexTurnEnding::Paused,
        TurnEnd::Retried => CodexTurnEnding::Retried,
    };

    let steers = take_blocked_codex_steers(record, "turn-1", ending);

    assert!(steers.refused.is_empty(), "no hook blocked the steer");
    let kept = record
        .unechoed_steers_by_turn_id
        .get("turn-1")
        .map(CodexUnechoedSteers::message_ids);
    match end {
        TurnEnd::ByItself => {
            assert_eq!(steers.dropped, Vec::new(), "nothing takes the steer");
            assert_eq!(kept, None);
        }
        TurnEnd::Interrupted | TurnEnd::InterruptedAnsweredLate | TurnEnd::Retried => {
            assert_eq!(steers.dropped, Vec::new());
            assert_eq!(
                kept,
                Some(vec![steer]),
                "the interrupt or retry takes it as dropped"
            );
        }
        TurnEnd::Paused => {
            assert_eq!(steers.dropped, [steer], "the queue is given it back");
            assert_eq!(kept, None);
        }
    }
}
