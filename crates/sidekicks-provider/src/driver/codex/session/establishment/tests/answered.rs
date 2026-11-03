//! A lead the restart held, continued once the person answered: the turn the adoption starts for
//! it holds Codex's continuation words and the answers, and a continuation Codex still runs for it
//! is held and owed a steer of the answers under the answered card's id.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::approval::{ApprovalDecision, ApprovalRequestId};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::continuation::{
    AdoptionScript, CONTINUATION_TURN, ROOT_TURN, adopt_continuing, cut_turn_listed, lead_run,
    page_turn,
};
use crate::driver::codex::service::supervisor::test_service::{
    start_scripted_codex_service, start_scripted_joined_service,
};
use crate::driver::codex::session::establishment::continuation::CODEX_CONTINUATION_TEXT;
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::session_control::ProviderTurnAnswer;
use crate::driver::session_control::continuation::{
    ContinueAnswer, ContinueEntry, HeldRunContinue,
};
use crate::driver::test_registry::new_run_id;

// The line the person's approval of `npm publish` reads as in the continuation.
const ANSWER_LINE: &str = "You asked to approve Bash: npm publish. The person approved it.";

// The continue of lead `run_id` the person's approval of its `npm publish` card `card` owes.
fn approved_publish(run_id: RunId, card: ApprovalRequestId) -> HeldRunContinue {
    HeldRunContinue {
        lead_run_id: run_id,
        entries: vec![ContinueEntry {
            run_id,
            subagent_id: None,
            answer: ContinueAnswer::Approval {
                approval_request_id: card,
                subject: "npm publish".to_owned(),
                tool_name: Some("Bash".to_owned()),
                decision: ApprovalDecision::Approved,
                decline_reason: None,
                edited_action: None,
            },
        }],
        missed_fires: Vec::new(),
    }
}

fn new_card() -> ApprovalRequestId {
    ApprovalRequestId::try_from(mint_uuid_v7()).expect("a minted UUID is an ask's id")
}

// A running lead whose turn a died service cut, or whose continuation a joined service already
// ended as the daemon's, is continued once the person answered in one turn holding Codex's
// continuation words, then the answer, and answers still running. Killed by the member dropped
// (the turn holds the words alone), and by the joined arm left out (no turn is sent and the lead
// reads gone).
#[rstest]
#[case::died_service(false, true)]
#[case::joined_service_after_its_continuation_ended(true, false)]
#[tokio::test(start_paused = true)]
async fn a_died_service_continues_a_lead_with_the_persons_answer(
    #[case] is_joined: bool,
    #[case] is_turn_open: bool,
) {
    let scripted = if is_joined {
        start_scripted_joined_service()
    } else {
        start_scripted_codex_service()
    };
    let mut session = TestCodexSession::start_on(scripted).await;
    let run_id = new_run_id();
    let mut lead = lead_run(run_id, RunState::Running);
    if !is_turn_open {
        lead.open_turns.clear();
    }

    let adoption = adopt_continuing(
        &mut session,
        vec![lead],
        Some(approved_publish(run_id, new_card())),
        AdoptionScript::unloaded(
            json!([cut_turn_listed()]),
            json!({"turn": {"id": CONTINUATION_TURN, "items": [], "status": "inProgress"}}),
        ),
    )
    .await;

    let [turn_start] = adoption.turn_starts.as_slice() else {
        panic!("one turn is sent: {:?}", adoption.turn_starts);
    };
    let text = turn_start["params"]["input"][0]["text"]
        .as_str()
        .expect("the turn holds words");
    assert!(text.starts_with(CODEX_CONTINUATION_TEXT), "{text}");
    assert!(text.ends_with(ANSWER_LINE), "{text}");
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
    let established = adoption.established.expect("the session is established");
    assert_eq!(
        established.record.active_turn_run(CONTINUATION_TURN),
        Some(run_id)
    );
}

// A running lead whose continuation Codex still runs on a joined service is sent no turn: the
// continuation is held, so its end leaves the lead live, and the adoption owes it a steer of the
// answer under the answered card's id. Killed by the key minted afresh, and by the hold left off
// (the continuation's end would end the run before the answer reached it).
#[tokio::test(start_paused = true)]
async fn an_answer_reaches_a_running_continuation_as_a_keyed_steer() {
    let mut session = TestCodexSession::start_on(start_scripted_joined_service()).await;
    let run_id = new_run_id();
    let card = new_card();
    let mut lead = lead_run(run_id, RunState::Running);
    lead.open_turns[0].provider_turn_id =
        Some(ProviderTurnId::new(CONTINUATION_TURN.to_owned()).expect("a turn id"));

    let adoption = adopt_continuing(
        &mut session,
        vec![lead],
        Some(approved_publish(run_id, card)),
        AdoptionScript::loaded_active(
            json!([page_turn(CONTINUATION_TURN, "inProgress", ROOT_TURN)]),
            page_turn(CONTINUATION_TURN, "inProgress", ROOT_TURN),
        ),
    )
    .await;

    assert_eq!(adoption.turn_starts, Vec::<Value>::new());
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
    let mut established = adoption.established.expect("the session is established");
    assert!(
        established
            .record
            .held_continuation_turn_ids
            .contains(CONTINUATION_TURN)
    );
    let steer = established
        .take_answer_steer()
        .expect("the continuation is owed the answer");
    assert_eq!(steer.run_id, run_id);
    assert_eq!(steer.turn_id, CONTINUATION_TURN);
    assert_eq!(
        steer.message_id,
        QueueItemId::new(card.text().as_str()).expect("a card's id is a UUID")
    );
    assert!(steer.answer_text.ends_with(ANSWER_LINE));
}
