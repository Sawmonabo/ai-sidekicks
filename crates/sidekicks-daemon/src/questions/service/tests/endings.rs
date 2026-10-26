//! Each way a held question ends unanswered: withdrawn by its provider, or settled by its run's
//! end, an answer racing that end among them.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::question::QuestionSettledState;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{Fixture, choice_page, failed};
use crate::provider::port::question::ProviderQuestionWithdrawal;
use crate::session::run::engine::tests::stored_run_state;
use crate::session::run::read::{LiveRun, RunRead};
use crate::session::run::state_change::{RunStateChange, RunStateChangeCompanions, RunStateEntry};

/// How a held question ends unanswered.
#[derive(Clone, Copy, Debug)]
enum QuestionEnd {
    /// The provider withdraws it.
    Withdrawn,
    /// The provider withdraws it after an interrupt of its run was asked for.
    WithdrawnUnderInterrupt,
    /// Its run is interrupted.
    RunInterrupted,
    /// Its run fails, as any end but an interrupt.
    RunFailed,
    /// A restart finds its run waiting and ends it.
    Restart,
}

// A held question that ends unanswered is canceled once, in the write that moves or ends its run,
// with the reason the run's own state gives: a withdrawal `withdrawn` and the run back to
// `running`, unless an interrupt of the run is recorded, which makes it `interrupted`; an
// interrupted end `interrupted`; any other end, a restart's among them, `runEnded`. Killed by a
// cancellation in a second write, by a reason read from the report rather than the run, and by a
// run left waiting.
#[rstest]
#[case::withdrawn(QuestionEnd::Withdrawn, "withdrawn", "running")]
#[case::withdrawn_under_an_interrupt(
    QuestionEnd::WithdrawnUnderInterrupt,
    "interrupted",
    "running"
)]
#[case::run_interrupted(QuestionEnd::RunInterrupted, "interrupted", "interrupted")]
#[case::run_failed(QuestionEnd::RunFailed, "runEnded", "failed")]
#[case::restart(QuestionEnd::Restart, "runEnded", "failed")]
#[tokio::test]
async fn a_held_question_ends_canceled_with_its_runs_reason(
    #[case] end: QuestionEnd,
    #[case] reason: &str,
    #[case] run_state: &str,
) {
    let fixture = Fixture::new().await;
    let question_id = fixture.ask("request-1", json!([choice_page()]), true).await;
    let withdrawal = ProviderQuestionWithdrawal {
        session_id: fixture.session_id,
        request_id: "request-1".to_owned(),
    };

    match end {
        QuestionEnd::Withdrawn => {}
        QuestionEnd::WithdrawnUnderInterrupt => {
            fixture
                .database
                .reader()
                .execute(
                    "INSERT INTO interventions (id, target_run_id, type, state, payload,
                       expected_run_version, client_idempotency_key, created_at)
                     VALUES (?1, ?2, 'interrupt', 'requested', '{}', 1, ?1, '')",
                    [
                        mint_uuid_v7().to_string(),
                        fixture.run_id.text().as_str().to_owned(),
                    ],
                )
                .expect("the test records the interrupt");
        }
        QuestionEnd::RunInterrupted | QuestionEnd::RunFailed => {
            let entry = if matches!(end, QuestionEnd::RunInterrupted) {
                RunStateEntry::Interrupted {
                    intended_close: None,
                    trigger: None,
                }
            } else {
                failed()
            };
            fixture
                .engine
                .transition(
                    RunStateChange::new(fixture.run_id, entry),
                    RunStateChangeCompanions::default(),
                )
                .await
                .expect("the run ends");
        }
        QuestionEnd::Restart => {
            let (_, version) = stored_run_state(&fixture.database, &fixture.run_id);
            fixture
                .engine
                .settle_run_after_restart(
                    &LiveRun {
                        run_id: fixture.run_id,
                        run: RunRead {
                            version,
                            session_id: fixture.session_id,
                            state: RunState::WaitingForInput,
                        },
                        parent_run_id: None,
                        reached_by: None,
                    },
                    "not resumed",
                    None,
                )
                .await
                .expect("the restart ends the run");
        }
    }
    // A withdrawal after the run's end finds the question settled and writes nothing.
    fixture
        .questions
        .withdraw_question(withdrawal)
        .await
        .expect("the withdrawal is taken");

    let canceled = fixture.payloads("question.canceled");
    assert_eq!(canceled.len(), 1);
    assert_eq!(canceled[0]["reason"], reason);
    assert_eq!(fixture.state(question_id), "canceled");
    assert_eq!(fixture.run_state(), run_state);
}

// A run that ends while its driver takes a held question's answer settles the question `canceled`
// in its end's write; the answer reads that state back and lets the request go, with no turn
// written. Killed by reading the state back only on the settle's refusal, and by keeping the
// request held.
#[tokio::test]
async fn an_answer_whose_run_ends_meanwhile_reads_canceled_and_lets_the_request_go() {
    let fixture = Fixture::with_driver(true).await;
    let question_id = fixture.ask("request-1", json!([choice_page()]), true).await;

    let state = fixture
        .answer(
            question_id,
            json!([{ "kind": "picked", "labels": ["Alpha"] }]),
        )
        .await;

    assert_eq!(
        state.expect("the answer reads the run's end"),
        QuestionSettledState::Canceled
    );
    assert_eq!(fixture.handed_count(), 1);
    assert!(fixture.questions.held_request(&question_id).is_none());
    assert_eq!(fixture.state(question_id), "canceled");
    assert_eq!(
        fixture.payloads("question.canceled")[0]["reason"],
        "runEnded"
    );
    assert_eq!(fixture.payloads("user.message.sent"), Vec::<Value>::new());
    assert_eq!(fixture.run_state(), "failed");
}
