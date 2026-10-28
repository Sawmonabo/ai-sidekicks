//! What a turn's end does with the steers it still holds unechoed, and the place a steer keeps
//! among them when its send fails.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::queue::QueueItemId;

use super::{steer_codex_run, take_blocked_codex_steers};
use crate::driver::codex::delivery::frames::CodexTurnEnding;
use crate::driver::codex::session::state::CodexUnechoedSteers;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};
use crate::driver::contract::DriverError;
use crate::driver::test_registry::{new_message_id, new_run_id};

/// How the turn holding an unechoed steer came to its end.
#[derive(Clone, Copy, Debug)]
enum TurnEnd {
    /// Codex ended it with no interrupt of the daemon's.
    ByItself,
    /// The run's interrupt stopped it.
    Interrupted,
    /// A pause's interrupt stopped it.
    Paused,
    /// A faster-model retry stopped it.
    Retried,
}

// Kills: the turn's end keeping the steers no interrupt takes (by itself), letting go of those an
// interrupt still takes as dropped, and a pause or a retry letting its steers go rather than
// dropping them for the queue.
#[rstest]
#[case::by_itself(TurnEnd::ByItself)]
#[case::interrupted(TurnEnd::Interrupted)]
#[case::paused(TurnEnd::Paused)]
#[case::retried(TurnEnd::Retried)]
#[tokio::test]
async fn a_turns_end_drops_or_lets_go_of_the_steers_no_interrupt_takes(#[case] end: TurnEnd) {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();
    let steer = new_message_id();
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
        TurnEnd::Interrupted => {
            assert_eq!(steers.dropped, Vec::new());
            assert_eq!(kept, Some(vec![steer]), "the interrupt takes it as dropped");
        }
        TurnEnd::Paused | TurnEnd::Retried => {
            assert_eq!(steers.dropped, [steer], "the queue is given it back");
            assert_eq!(kept, None);
        }
    }
}

// Paused time, so the first steer's request runs out its deadline at once. A steer whose answer
// never came may have been taken and its prompt hook run, so it keeps its place, and the next
// steer's refusal pairs with its own prompt. Killed by taking a steer back on every failure (the
// second steer would pair with the first's prompt, which passed).
#[tokio::test(start_paused = true)]
async fn a_steer_whose_answer_never_came_keeps_its_place_among_the_turns_steers() {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();
    let (unanswered, blocked) = (new_message_id(), new_message_id());
    session
        .task
        .record
        .add_active_turn("turn-1".to_owned(), run_id);
    let inbound = session.task.record.inbound.clone();
    let script = &mut session.scripted.script;

    let first = steer_codex_run(&inbound, run_id, None, unanswered, async { Ok(Vec::new()) });
    let (first, ()) = session
        .task
        .drive(async {
            tokio::join!(first, async {
                let sent = script.next_sent().await;
                assert_eq!(sent["method"], "turn/steer");
            })
        })
        .await;
    let second = steer_codex_run(&inbound, run_id, None, blocked, async { Ok(Vec::new()) });
    let (second, ()) = session
        .task
        .drive(async {
            tokio::join!(second, async {
                let sent = script.next_sent().await;
                assert_eq!(sent["method"], "turn/steer");
                script.answer(&sent, &json!({"turnId": "turn-1"}));
            })
        })
        .await;
    // The opening prompt and the unanswered steer pass the hook; the second steer is blocked.
    for (status, words) in [
        ("completed", ""),
        ("completed", ""),
        ("blocked", "keys stay home"),
    ] {
        script.send(&prompt_hook_completed(status, words));
        session.task.handle_next().await;
    }
    let steers =
        take_blocked_codex_steers(&mut session.task.record, "turn-1", CodexTurnEnding::Live);

    assert!(
        matches!(first, Err(DriverError::Unanswered(_))),
        "no answer came for the first steer"
    );
    assert!(second.is_ok(), "Codex took the second steer");
    let refused: Vec<(QueueItemId, String)> = steers
        .refused
        .into_iter()
        .map(|(message_id, words)| (message_id, words.as_str().to_owned()))
        .collect();
    assert_eq!(refused, [(blocked, "keys stay home".to_owned())]);
}

// One run of the person's one `userPromptSubmit` hook handler on a prompt of `turn-1`, ending
// `status` with `words`.
fn prompt_hook_completed(status: &str, words: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "hook/completed",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": "turn-1",
            "run": {
                "id": "user-prompt-submit:0:/hooks.json",
                "eventName": "userPromptSubmit",
                "status": status,
                "entries": if words.is_empty() { json!([]) } else { json!([{"text": words}]) },
            },
        },
    })
}
