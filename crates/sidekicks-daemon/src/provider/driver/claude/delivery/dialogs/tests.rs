use std::sync::{Arc, Mutex};

use futures::FutureExt;
use rstest::rstest;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{RunRefusalChoice, RunUsageCreditsChoice};
use sidekicks_contracts::session::id::SessionId;

use super::{ClaudeDialogSession, ClaudeProviderDialogs, MockClaudeDialogPorts};
use crate::provider::driver::claude::run::routes::ClaudeBoundRun;
use crate::provider::driver::claude::session::errors::{ClaudeSessionError, ClaudeUnansweredCause};
use crate::provider::driver::claude::session::transport::channel::MockClaudeProcessChannel;
use crate::provider::driver::claude::session::transport::control::ClaudeControlSubtype;
use crate::provider::driver::claude::session::transport::inbound::{
    ClaudeControlAnswer, ClaudeUserDialog,
};
use crate::provider::driver::claude::session::transport::user_message::{
    ClaudeWriteAttempt, ClaudeWriteDelivery,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ProviderChoiceAnswer,
};
use crate::session::run::inbound::rows::UnstampedRow;
use crate::session::run::inbound::{InboundDelivery, InboundOutcome};
use crate::uuid_v7::mint_uuid_v7;

// What each delivery was, in the order handed over: a row's kind or a move's target state.
type Delivered = Arc<Mutex<Vec<String>>>;

fn label(delivery: &InboundDelivery<'static>) -> String {
    match delivery {
        InboundDelivery::RunLifecycle { change, .. } => format!("{:?}", change.entry.state()),
        InboundDelivery::UnstampedRow { row, .. } => match row {
            UnstampedRow::AgentRunRefusalChoiceRequested(_) => "refusalRequested".to_owned(),
            UnstampedRow::AgentRunRefusalChoiceResolved(_) => "refusalResolved".to_owned(),
            UnstampedRow::AgentRunUsageCreditsChoiceRequested(_) => "creditsRequested".to_owned(),
            UnstampedRow::AgentRunUsageCreditsChoiceResolved(payload) => {
                format!("creditsResolved:{}", serde_json::json!(payload.choice))
            }
            UnstampedRow::PlanProposed(_) | UnstampedRow::ApprovalReviewerFlagged(_) => {
                "otherRow".to_owned()
            }
        },
        InboundDelivery::TurnBoundary { .. }
        | InboundDelivery::RunContinued { .. }
        | InboundDelivery::ChildRun { .. }
        | InboundDelivery::RunMarker { .. }
        | InboundDelivery::LiveRunState { .. }
        | InboundDelivery::ThinkingUpdate { .. }
        | InboundDelivery::SessionNotice { .. }
        | InboundDelivery::SessionEvent { .. }
        | InboundDelivery::PermissionAsk { .. }
        | InboundDelivery::SessionRow { .. } => "otherDelivery".to_owned(),
    }
}

fn dialogs(
    delivered: &Delivered,
    ends: &Delivered,
) -> ClaudeProviderDialogs<MockClaudeDialogPorts> {
    let mut ports = MockClaudeDialogPorts::new();
    let sink = Arc::clone(delivered);
    ports.expect_deliver().returning(move |delivery| {
        sink.lock()
            .expect("the sink is never poisoned")
            .push(label(&delivery));
        async { Some(InboundOutcome::Published) }.boxed()
    });
    ports
        .expect_event_ids_for_messages()
        .returning(|_, _| async { Vec::new() }.boxed());
    let (marked, confirmed, released) = (Arc::clone(ends), Arc::clone(ends), Arc::clone(ends));
    ports
        .expect_mark_daemon_ended()
        .returning(move |_, is_confirmed| {
            marked
                .lock()
                .expect("the sink is never poisoned")
                .push(format!("mark:{is_confirmed}"));
        });
    ports.expect_confirm_daemon_end().returning(move |_| {
        confirmed
            .lock()
            .expect("the sink is never poisoned")
            .push("confirm".to_owned());
    });
    ports.expect_release_daemon_end().returning(move |_| {
        released
            .lock()
            .expect("the sink is never poisoned")
            .push("release".to_owned());
    });
    ClaudeProviderDialogs::new(ports)
}

fn session(channel: &MockClaudeProcessChannel) -> ClaudeDialogSession<'_> {
    ClaudeDialogSession {
        session_id: SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id"),
        channel,
        running_model: "claude-opus-5",
        offered_models: &[],
        provider_account_id: None,
    }
}

fn bound_run() -> ClaudeBoundRun {
    ClaudeBoundRun {
        run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        binding_id: RuntimeBindingId::new("binding".to_owned()).expect("a binding id"),
    }
}

fn dialog(kind: &str, payload: &str) -> ClaudeUserDialog {
    ClaudeUserDialog {
        dialog_kind: Some(kind.to_owned()),
        payload: Some(RawValue::from_string(payload.to_owned()).expect("a JSON payload")),
        tool_use_id: None,
    }
}

fn answer_params(
    session: &ClaudeDialogSession<'_>,
    run: &ClaudeBoundRun,
    answer: ProviderChoiceAnswer,
) -> AnswerProviderChoiceParams {
    AnswerProviderChoiceParams {
        session_id: session.session_id,
        run_id: run.run_id,
        answer,
    }
}

fn taken(sink: &Delivered) -> Vec<String> {
    sink.lock().expect("the sink is never poisoned").clone()
}

const REFUSAL: (&str, &str) = (
    "refusal_fallback_prompt",
    r#"{"originalModel":"claude-fable-5","fallbackModel":"claude-opus-5"}"#,
);
const USAGE_CREDITS: (&str, &str) = (
    "fable_overage_consent_prompt",
    r#"{"overagesEnabled":true}"#,
);

// A channel whose every answer is written, each one recorded with its request id.
fn writing_channel(written: &Arc<Mutex<Vec<(String, String)>>>) -> MockClaudeProcessChannel {
    let mut channel = MockClaudeProcessChannel::new();
    let sink = Arc::clone(written);
    channel
        .expect_answer_inbound_request()
        .returning(move |request_id, answer| {
            sink.lock()
                .expect("the sink is never poisoned")
                .push((request_id, answer.get().to_owned()));
            async { ClaudeWriteAttempt::Written }.boxed()
        });
    channel
}

// Kills: a dialog sent again, before or after its answer, showing a second row and a second move
// (the seen ids removed), and an answer sent in the contract's spelling instead of Claude Code's.
#[rstest]
#[case::retry_fallback(
    REFUSAL,
    ProviderChoiceAnswer::Refusal { choice: RunRefusalChoice::RetryFallback },
    "retry_fallback",
    "refusalRequested"
)]
#[case::edit_prompt(
    REFUSAL,
    ProviderChoiceAnswer::Refusal { choice: RunRefusalChoice::EditPrompt },
    "edit_prompt",
    "refusalRequested"
)]
#[case::switch_default(
    USAGE_CREDITS,
    ProviderChoiceAnswer::UsageCredits { choice: RunUsageCreditsChoice::SwitchDefault },
    "switch_default",
    "creditsRequested"
)]
#[case::consent(
    USAGE_CREDITS,
    ProviderChoiceAnswer::UsageCredits { choice: RunUsageCreditsChoice::Consent },
    "consent",
    "creditsRequested"
)]
#[tokio::test]
async fn a_dialog_sent_again_shows_once_and_its_answer_goes_in_claude_codes_words(
    #[case] (kind, payload): (&str, &str),
    #[case] answer: ProviderChoiceAnswer,
    #[case] word: &str,
    #[case] requested: &str,
) {
    let (delivered, ends) = (Delivered::default(), Delivered::default());
    let dialogs = dialogs(&delivered, &ends);
    let written = Arc::new(Mutex::new(Vec::new()));
    let channel = writing_channel(&written);
    let session = session(&channel);
    let run = bound_run();
    let asked = dialog(kind, payload);

    for _ in 0..2 {
        dialogs
            .take_dialog(&session, "dialog-1".to_owned(), &asked, run.clone())
            .await;
    }
    let answered = dialogs
        .answer(&session, &answer_params(&session, &run, answer))
        .await
        .expect("the answer is written");
    // Replayed after the answer let the choice go, as a re-sent `initialize` replays it.
    dialogs
        .take_dialog(&session, "dialog-1".to_owned(), &asked, run.clone())
        .await;

    assert_eq!(taken(&delivered), [requested, "WaitingForInput"]);
    assert_eq!(answered, AnswerProviderChoiceResult::Answered {});
    assert_eq!(
        *written.lock().expect("the sink is never poisoned"),
        [(
            "dialog-1".to_owned(),
            format!(r#"{{"behavior":"completed","result":"{word}"}}"#)
        )]
    );
}

// Kills: a dialog with nothing to choose left unanswered while Claude Code waits on it, shown as
// a choice, given a settlement row it never showed, or ended without the daemon's end marked once
// and confirmed.
#[rstest]
#[case::a_refusal_with_no_fallback(
    "refusal_fallback_prompt",
    r#"{"originalModel":"claude-fable-5"}"#,
    "claude-opus-5",
    &["Failed"],
    &["mark:false", "confirm"]
)]
#[case::no_model_to_name(
    "fable_overage_consent_prompt",
    r#"{"overagesEnabled":true}"#,
    " ",
    &[],
    &[]
)]
#[tokio::test]
async fn a_dialog_with_nothing_to_choose_is_canceled(
    #[case] kind: &str,
    #[case] payload: &str,
    #[case] running_model: &str,
    #[case] delivered_labels: &[&str],
    #[case] end_labels: &[&str],
) {
    let (delivered, ends) = (Delivered::default(), Delivered::default());
    let dialogs = dialogs(&delivered, &ends);
    let mut channel = MockClaudeProcessChannel::new();
    channel
        .expect_answer_inbound_request()
        .withf(|request_id, answer| {
            request_id == "dialog-1" && answer.get() == r#"{"behavior":"cancelled"}"#
        })
        .times(1)
        .returning(|_, _| async { ClaudeWriteAttempt::Written }.boxed());
    let session = ClaudeDialogSession {
        running_model,
        ..session(&channel)
    };
    let run = bound_run();

    dialogs
        .take_dialog(
            &session,
            "dialog-1".to_owned(),
            &dialog(kind, payload),
            run.clone(),
        )
        .await;
    let answered = dialogs
        .answer(
            &session,
            &answer_params(
                &session,
                &run,
                ProviderChoiceAnswer::Refusal {
                    choice: RunRefusalChoice::RetryFallback,
                },
            ),
        )
        .await
        .expect("nothing is held");

    assert_eq!(taken(&delivered), delivered_labels);
    assert_eq!(taken(&ends), end_labels);
    assert_eq!(answered, AnswerProviderChoiceResult::NotPending {});
}

// Kills: an answer cut mid-write written again once the check shows Claude Code took it, or not
// written again while the check still lists its id.
#[rstest]
#[case::taken(&[], 1)]
#[case::still_pending(&["dialog-1"], 2)]
#[tokio::test]
async fn an_answer_cut_mid_write_is_written_again_only_while_its_id_is_pending(
    #[case] pending: &'static [&'static str],
    #[case] writes: usize,
) {
    let (delivered, ends) = (Delivered::default(), Delivered::default());
    let dialogs = dialogs(&delivered, &ends);
    let mut channel = MockClaudeProcessChannel::new();
    let mut attempts = 0;
    channel
        .expect_answer_inbound_request()
        .times(writes)
        .returning(move |_, _| {
            attempts += 1;
            let first = attempts == 1;
            async move {
                if first {
                    ClaudeWriteAttempt::Failed {
                        delivery: ClaudeWriteDelivery::Indeterminate,
                        cause: std::io::Error::other("the pipe broke mid-line"),
                    }
                } else {
                    ClaudeWriteAttempt::Written
                }
            }
            .boxed()
        });
    channel
        .expect_send_control_request()
        .times(1)
        .returning(move |_| {
            async move {
                Ok(ClaudeControlAnswer {
                    response: None,
                    pending_user_dialog_requests: Some(
                        pending.iter().map(|&id| id.to_owned()).collect(),
                    ),
                })
            }
            .boxed()
        });
    let session = session(&channel);
    let run = bound_run();
    let (kind, payload) = USAGE_CREDITS;
    dialogs
        .take_dialog(
            &session,
            "dialog-1".to_owned(),
            &dialog(kind, payload),
            run.clone(),
        )
        .await;

    let answered = dialogs
        .answer(
            &session,
            &answer_params(
                &session,
                &run,
                ProviderChoiceAnswer::UsageCredits {
                    choice: RunUsageCreditsChoice::Consent,
                },
            ),
        )
        .await;

    assert_eq!(
        answered.expect("the check settled the answer"),
        AnswerProviderChoiceResult::Answered {}
    );
}

// Kills: a turn frame reporting a settled hold as a taken answer, or one taken answer twice.
#[tokio::test]
async fn a_turn_frame_reports_only_an_unsettled_answer_and_once() {
    let (delivered, ends) = (Delivered::default(), Delivered::default());
    let dialogs = dialogs(&delivered, &ends);
    let mut channel = MockClaudeProcessChannel::new();
    channel.expect_answer_inbound_request().returning(|_, _| {
        async {
            ClaudeWriteAttempt::Failed {
                delivery: ClaudeWriteDelivery::Indeterminate,
                cause: std::io::Error::other("the pipe broke mid-line"),
            }
        }
        .boxed()
    });
    channel.expect_send_control_request().returning(|_| {
        async {
            Err(ClaudeSessionError::Unanswered {
                subtype: ClaudeControlSubtype::Initialize,
                cause: ClaudeUnansweredCause::Deadline,
            })
        }
        .boxed()
    });
    let session = session(&channel);
    let (cut_run, held_run) = (bound_run(), bound_run());
    let (kind, payload) = USAGE_CREDITS;
    for (request_id, run) in [("dialog-1", &cut_run), ("dialog-2", &held_run)] {
        dialogs
            .take_dialog(
                &session,
                request_id.to_owned(),
                &dialog(kind, payload),
                run.clone(),
            )
            .await;
    }
    let cut = dialogs
        .answer(
            &session,
            &answer_params(
                &session,
                &cut_run,
                ProviderChoiceAnswer::UsageCredits {
                    choice: RunUsageCreditsChoice::Consent,
                },
            ),
        )
        .await;
    assert!(matches!(cut, Err(DriverError::Unanswered(_))));

    assert!(!dialogs.observe_turn_frame(held_run.run_id));
    assert!(dialogs.observe_turn_frame(cut_run.run_id));
    assert!(!dialogs.observe_turn_frame(cut_run.run_id));
}

// Kills: an unsettled answer that a check finds gone answering `Answered` (the provider took
// the earlier answer), and an indeterminate write with an unanswered check answering anything
// but `Unanswered`.
#[tokio::test]
async fn an_unsettled_answer_is_not_pending_once_the_check_finds_its_id_gone() {
    let (delivered, ends) = (Delivered::default(), Delivered::default());
    let dialogs = dialogs(&delivered, &ends);
    let mut channel = MockClaudeProcessChannel::new();
    channel
        .expect_answer_inbound_request()
        .times(1)
        .returning(|_, _| {
            async {
                ClaudeWriteAttempt::Failed {
                    delivery: ClaudeWriteDelivery::Indeterminate,
                    cause: std::io::Error::other("the pipe broke mid-line"),
                }
            }
            .boxed()
        });
    let mut checks = 0;
    channel
        .expect_send_control_request()
        .times(2)
        .returning(move |_| {
            checks += 1;
            let first = checks == 1;
            async move {
                if first {
                    Err(ClaudeSessionError::Unanswered {
                        subtype: ClaudeControlSubtype::Initialize,
                        cause: ClaudeUnansweredCause::Deadline,
                    })
                } else {
                    Ok(ClaudeControlAnswer {
                        response: None,
                        pending_user_dialog_requests: Some(Vec::new()),
                    })
                }
            }
            .boxed()
        });
    let session = session(&channel);
    let run = bound_run();
    dialogs
        .take_dialog(
            &session,
            "dialog-1".to_owned(),
            &dialog(
                "fable_overage_consent_prompt",
                r#"{"overagesEnabled":false}"#,
            ),
            run.clone(),
        )
        .await;
    let consent = answer_params(
        &session,
        &run,
        ProviderChoiceAnswer::UsageCredits {
            choice: RunUsageCreditsChoice::Consent,
        },
    );

    let first = dialogs.answer(&session, &consent).await;
    let second = dialogs.answer(&session, &consent).await;

    assert!(matches!(first, Err(DriverError::Unanswered(_))));
    assert_eq!(
        second.expect("the check answered"),
        AnswerProviderChoiceResult::NotPending {}
    );
    assert_eq!(taken(&delivered), ["creditsRequested", "WaitingForInput"]);
}

// Kills: `consent_unanswered` leaving the credits choice held, recording it as anything but
// `unanswered` with the run running again, or recording it twice.
#[tokio::test]
async fn consent_unanswered_records_the_credits_choice_unanswered_once() {
    let (delivered, ends) = (Delivered::default(), Delivered::default());
    let dialogs = dialogs(&delivered, &ends);
    let channel = MockClaudeProcessChannel::new();
    let session = session(&channel);
    let run = bound_run();
    dialogs
        .take_dialog(
            &session,
            "dialog-1".to_owned(),
            &dialog(
                "fable_overage_consent_prompt",
                r#"{"overagesEnabled":true}"#,
            ),
            run.clone(),
        )
        .await;

    for _ in 0..2 {
        dialogs
            .observe_assistant_error(run.run_id, Some("consent_unanswered"))
            .await;
    }

    assert_eq!(
        taken(&delivered),
        [
            "creditsRequested",
            "WaitingForInput",
            r#"creditsResolved:"unanswered""#,
            "Running"
        ]
    );
}
