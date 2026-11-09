use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_platforms::PathRules;
use sidekicks_std::port_registration::PortRegistration;

use super::ClaudeConversationCuts;
use crate::driver::claude::session::scripted::channel::ScriptedAnswer;
use crate::driver::claude::session::scripted::held_calls::init;
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
};
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::driver::rewind::RewindConversationResult;
use crate::run::state_entry::RunStateEntry;
use crate::run::turn_end::TurnOutcome;

// The person's message every test cuts back to.
const TARGET_MESSAGE_ID: &str = "target-message";

// The cuts over the scripted session's own routes, prompts, dialogs and streams.
fn cuts_of(session: &ScriptedSession) -> Arc<ClaudeConversationCuts> {
    Arc::new(ClaudeConversationCuts {
        routes: Arc::clone(&session.start.routes),
        prompts: Arc::clone(&session.start.prompts),
        dialogs: Arc::clone(&session.parts.run_controls.dialogs),
        streams: Arc::clone(&session.start.streams),
    })
}

// Scripts the answers of the session's next cuts, in order.
fn script_cut_answers(session: &ScriptedSession, answers: &[Value]) {
    for answer in answers {
        session
            .channel
            .answer("rewind_conversation", ScriptedAnswer::Reply(answer.clone()));
    }
}

// The cuts written so far, in order.
fn cut_requests(session: &ScriptedSession) -> Vec<Value> {
    session
        .channel
        .control_requests()
        .into_iter()
        .filter(|request| request["subtype"] == "rewind_conversation")
        .collect()
}

// Runs the person's undo back to the target off the test's task, with no approvals registered.
fn spawn_rewind(session: &ScriptedSession) -> tokio::task::JoinHandle<RewindConversationResult> {
    let cuts = cuts_of(session);
    let live = Arc::clone(&session.live);
    tokio::spawn(async move {
        cuts.rewind(
            &live,
            TARGET_MESSAGE_ID,
            &PortRegistration::new("reviewer denials"),
        )
        .await
        .expect("the cut is answered")
    })
}

// Killed by sending no second cut, by sending it before the turn settles, and by sending it with
// another target.
#[tokio::test(start_paused = true)]
async fn a_refusal_claude_code_marks_sendable_is_sent_once_more_after_the_turn_settles() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    script_cut_answers(
        &session,
        &[
            json!({"rewound": false, "reason": "turn_running"}),
            json!({"rewound": true}),
        ],
    );

    let rewind = spawn_rewind(&session);
    settle().await;
    assert_eq!(cut_requests(&session).len(), 1);

    session.start.routes.settle_turn_holds(session.session_id);
    let result = rewind.await.expect("the undo's task ends");

    let targets: Vec<Value> = cut_requests(&session)
        .into_iter()
        .map(|request| request["target_message_uuid"].clone())
        .collect();
    assert_eq!(
        targets,
        [json!(TARGET_MESSAGE_ID), json!(TARGET_MESSAGE_ID)]
    );
    assert_eq!(
        result,
        RewindConversationResult::Applied {
            fork: None,
            cut_message_text: None,
        }
    );
}

// Killed by sending again a refusal Claude Code marks final, by a third send, and by sending again
// a word outside the set.
#[rstest]
#[case::final_code(&[json!({"rewound": false, "reason": "stale_target"})], 1, "stale_target")]
#[case::second_refusal(
    &[
        json!({"rewound": false, "reason": "turn_running"}),
        json!({"rewound": false, "reason": "turn_running"}),
    ],
    2,
    "turn_running"
)]
#[case::usage_limited_target_missing(
    &[json!({"rewound": false, "reason": "usage_limited", "target_not_found": true})],
    1,
    "usage_limited"
)]
#[case::target_missing(
    &[json!({"rewound": false, "reason": "target_not_found"})],
    1,
    "target_not_found"
)]
#[case::unknown_word(&[json!({"rewound": false, "reason": "cut_too_soon"})], 1, "cut_too_soon")]
#[tokio::test(start_paused = true)]
async fn a_final_refusal_or_a_second_one_is_never_sent_again(
    #[case] answers: &[Value],
    #[case] sends: usize,
    #[case] reason: &str,
) {
    let session = ScriptedSession::new().await;
    script_cut_answers(&session, answers);
    // A third send would be answered as applied.
    script_cut_answers(&session, &[json!({"rewound": true})]);

    let result = spawn_rewind(&session).await.expect("the undo's task ends");

    assert_eq!(cut_requests(&session).len(), sends);
    assert_eq!(
        result,
        RewindConversationResult::Degraded {
            fallback_action: Some(format!("rewind-refused: {reason}")),
        }
    );
}

// Which of a merged command's three members the undo goes back to.
#[derive(Clone, Copy, Debug)]
enum MergedMember {
    First,
    Middle,
    // The member whose uuid the command's entry carries.
    Last,
}

// Claude Code's conversation file holds the three messages as one command, `user` entry `u-3`, and
// finds no entry for the earlier two. The first member's undo is cut once more before the command;
// the middle one's is not, since that cut would also take the first member, which its undo keeps;
// the last member's lands on its first send, as before. Killed by no second send, by a second send
// under the target's own id or under any id but the command entry's own, by a middle member
// mapped, and by the mapping read from an entry that is no `user` one.
#[rstest]
#[case::first(MergedMember::First)]
#[case::middle(MergedMember::Middle)]
#[case::last(MergedMember::Last)]
#[tokio::test(start_paused = true)]
async fn an_undo_to_a_merged_message_is_cut_before_its_command_from_its_first_member(
    #[case] member: MergedMember,
) {
    let session = ScriptedSession::new().await;
    let config_folder = claude_config_folder(
        &session.live.signed_in_spawn_environment(),
        PathRules::NATIVE,
    )
    .expect("the scripted session's home is known");
    // No read reaches the person's own `~/.claude`: the home lies in the fixture's own folder.
    let fixture_folder = session.home.parent().expect("the home sits in a folder");
    assert!(
        config_folder.starts_with(fixture_folder),
        "{config_folder:?}"
    );
    let (command_uuid, earlier_members) = match member {
        MergedMember::First => ("u-3", [TARGET_MESSAGE_ID, "u-2"]),
        MergedMember::Middle => ("u-3", ["u-1", TARGET_MESSAGE_ID]),
        MergedMember::Last => (TARGET_MESSAGE_ID, ["u-1", "u-2"]),
    };
    let project_folder = config_folder.join("projects").join("-work");
    std::fs::create_dir_all(&project_folder).expect("the project folder is made");
    let entries = [
        // A summary naming the target first, which no `user` entry is.
        json!({"type": "system", "uuid": "s-1", "mergedSendUuids": [TARGET_MESSAGE_ID]}),
        json!({
            "type": "user",
            "uuid": command_uuid,
            "mergedSendUuids": earlier_members,
            "message": {"role": "user", "content": "one\ntwo\nthree"},
        }),
    ];
    // One entry a line, each line ended, as Claude Code writes them.
    let lines = format!("{}\n{}\n", entries[0], entries[1]);
    std::fs::write(
        project_folder.join(format!("{}.jsonl", session.live.provider_session_id)),
        lines,
    )
    .expect("the conversation file is written");
    let applied = json!({"rewound": true, "prefillText": "one\ntwo\nthree"});
    let missing = json!({"rewound": false, "reason": "target_not_found"});
    match member {
        MergedMember::First | MergedMember::Middle => {
            script_cut_answers(&session, &[missing, applied]);
        }
        MergedMember::Last => script_cut_answers(&session, &[applied]),
    }

    let result = spawn_rewind(&session).await.expect("the undo's task ends");

    let targets: Vec<Value> = cut_requests(&session)
        .into_iter()
        .map(|request| request["target_message_uuid"].clone())
        .collect();
    let applied_result = RewindConversationResult::Applied {
        fork: None,
        cut_message_text: Some("one\ntwo\nthree".to_owned()),
    };
    match member {
        MergedMember::First => {
            assert_eq!(targets, [json!(TARGET_MESSAGE_ID), json!("u-3")]);
            assert_eq!(result, applied_result);
        }
        MergedMember::Middle => {
            assert_eq!(targets, [json!(TARGET_MESSAGE_ID)]);
            assert_eq!(
                result,
                RewindConversationResult::Degraded {
                    fallback_action: Some("rewind-refused: target_not_found".to_owned()),
                }
            );
        }
        MergedMember::Last => {
            assert_eq!(targets, [json!(TARGET_MESSAGE_ID)]);
            assert_eq!(result, applied_result);
        }
    }
}

// How the undo's cut settles in the run-end test.
#[derive(Clone, Copy, Debug)]
enum CutSettling {
    // Applied, with no turn end Claude Code sent before the answer.
    Applied,
    // Applied, after Claude Code sent the interrupted turn's `result` ahead of the answer.
    AppliedAfterResult,
    // Refused for good.
    Refused,
}

// Killed by ending the lead run through the superseded run's `Failed` end, by dropping the end's
// dispatch rather than awaiting it, by writing no turn end, by leaving the ended turn open on the
// stream, by delivering a held `result` as a second end, by losing the number of a turn whose
// `result` came first, and by leaving the hold unreleased on a refusal.
#[rstest]
#[case::applied(CutSettling::Applied)]
#[case::applied_after_result(CutSettling::AppliedAfterResult)]
#[case::refused(CutSettling::Refused)]
#[tokio::test(start_paused = true)]
async fn an_undo_cut_settles_the_lead_runs_end_as_its_answer_says(#[case] settling: CutSettling) {
    let session = ScriptedSession::new().await;
    let lead = session.hold_lead_turn("lead");
    session.frame(&init());
    settle().await;
    let open_turn_number = session
        .stream
        .open_turn()
        .0
        .and_then(|turn| turn.turn_number)
        .expect("the lead's turn is open and numbered");
    let result = json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "result": "done",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    });
    let answer = match settling {
        CutSettling::Applied | CutSettling::AppliedAfterResult => json!({"rewound": true}),
        CutSettling::Refused => json!({"rewound": false, "reason": "stale_target"}),
    };
    script_cut_answers(&session, &[answer]);
    let release_answer = session.channel.hold_next_control("rewind_conversation");

    let rewind = spawn_rewind(&session);
    settle().await;
    if matches!(settling, CutSettling::AppliedAfterResult) {
        session.frame(&result);
        settle().await;
        assert_eq!(session.engine.moves_of_run(lead), []);
    }
    release_answer.send(()).unwrap_or(());
    rewind.await.expect("the undo's task ends");

    if matches!(settling, CutSettling::Refused) {
        session.frame(&result);
        settle().await;
        assert_eq!(
            session.engine.moves_of_run(lead),
            [RunStateEntry::Completed {
                intended_close: None
            }]
        );
        assert_eq!(session.engine.daemon_interrupt_ends_of_run(lead), [false]);
        return;
    }
    // Read at the undo's return, with nothing settled after it.
    assert_eq!(
        session.engine.moves_of_run(lead),
        [RunStateEntry::Interrupted {
            intended_close: None,
            trigger: None,
        }]
    );
    assert_eq!(session.engine.daemon_interrupt_ends_of_run(lead), [true]);
    let ended_turns: Vec<_> = session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "runLifecycle")
        .map(|delivery| (delivery.turn_end, delivery.ended_turn_number))
        .collect();
    assert_eq!(
        ended_turns,
        [(Some(TurnOutcome::Interrupted(None)), Some(open_turn_number))]
    );
    assert_eq!(session.stream.open_turn().0, None);

    session.frame(&result);
    settle().await;
    assert_eq!(session.engine.moves_of_run(lead).len(), 1);
}
