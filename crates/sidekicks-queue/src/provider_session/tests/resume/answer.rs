//! A held lead continued once the person answered: the resume carries the answers owed it only
//! while the lead runs, each answer once, and owes it again to the next resume when the provider
//! refused the one that carried it or resumed without continuing the lead, never once the provider
//! carried it, though the resume's runs could not be settled or its binding recorded after. A
//! paused helper the person continued counts as answered, carrying its kept words, and a lead the
//! person continued behind a waiting helper goes on with that helper's answer, carrying its own.

use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::approval::{ApprovalDecision, ApprovalRequestId};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::controls::events::{ProviderWarningSource, SessionNotice};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::session_control::held_run_continue::{
    ContinueAnswer, ContinueEntry, HeldRunContinue,
};
use sidekicks_provider::driver::test_registry::new_run_id;
use sidekicks_session::run::engine::test_fixture::insert_running_run;
use sidekicks_std::mutex_lock::lock;
use tokio::time::timeout;

use super::super::{Opening, WAIT};
use super::{SUBAGENT_ID, insert_run_event};
use crate::provider_session::errors::ProviderSessionError;
use crate::provider_session::held_run_continue::{
    ContinuedWords, KeptMessages, KeptWords, OwedAnswer,
};
use crate::provider_session::test_opening::read_notices;

// The fixture with its later run ended, so the earlier one is the session's only lead, one card
// answered on that lead owed to its continue, and every continue a resume or restart carried.
async fn held_lead() -> (
    Opening,
    Arc<Mutex<Vec<Option<HeldRunContinue>>>>,
    ContinueEntry,
) {
    let carried = Arc::new(Mutex::new(Vec::new()));
    let opening = Opening::new(
        Box::new({
            let carried = Arc::clone(&carried);
            move |params| lock(&carried).push(params.held_run_continue.clone())
        }),
        Box::new(|| {}),
        |_, _| {},
    )
    .await;
    set_run_state(&opening, opening.run_id, "completed");
    let approval_request_id =
        ApprovalRequestId::try_from(mint_uuid_v7()).expect("a minted UUID is an ask's id");
    let answer = ContinueAnswer::Approval {
        approval_request_id,
        subject: "rm -rf build".to_owned(),
        tool_name: Some("Bash".to_owned()),
        decision: ApprovalDecision::Approved,
        decline_reason: None,
        edited_action: None,
    };
    opening.orphaned_approvals.owe(OwedAnswer {
        id: approval_request_id,
        run_id: opening.earlier_run_id,
        answer: answer.clone(),
    });
    let entry = ContinueEntry {
        run_id: opening.earlier_run_id,
        subagent_id: None,
        answer,
    };
    (opening, carried, entry)
}

fn set_run_state(opening: &Opening, run_id: RunId, state: &str) {
    opening
        .database
        .reader()
        .execute(
            "UPDATE runs SET state = ?1 WHERE run_id = ?2",
            params![state, run_id.text().as_str()],
        )
        .expect("the test moves the run");
}

async fn resume_after_answer(opening: &Opening) -> Result<(), ProviderSessionError> {
    let no_messages = DeliveredMessages::default();
    let continued_words = ContinuedWords {
        kept: HashMap::new(),
        messages: &no_messages,
    };
    resume_with_words(opening, &continued_words).await
}

// The person's answer's continue of the fixture's session, carrying `continued_words`.
async fn resume_with_words(
    opening: &Opening,
    continued_words: &ContinuedWords<'_>,
) -> Result<(), ProviderSessionError> {
    timeout(
        WAIT,
        opening
            .sessions
            .resume_after_answer(opening.session_id, continued_words),
    )
    .await
    .expect("the continue takes its own lock once")
}

// While the lead still waits on an ask of its own the answer resumes nothing; once its every ask
// is answered, one resume carries the answer and moves the lead on from its wait, and neither a
// second answer's continue nor a restart carries it again. Killed by the member composed while
// the lead is held (a resume while it waits), by a waiting lead skipped though its asks are
// answered (no resume), by the claim skipped (the second continue or the restart carries the
// answer again), and by a continue run with no member (a resume carrying `None`).
#[tokio::test]
async fn an_orphaned_answer_continues_the_lead_once() {
    let (opening, carried, entry) = held_lead().await;
    set_run_state(&opening, opening.earlier_run_id, "waitingForApproval");
    opening
        .orphaned_approvals
        .set_open_ask(opening.earlier_run_id, true);

    resume_after_answer(&opening)
        .await
        .expect("a held lead's continue waits");
    assert!(lock(&carried).is_empty(), "a held lead was resumed");

    opening
        .orphaned_approvals
        .set_open_ask(opening.earlier_run_id, false);
    resume_after_answer(&opening)
        .await
        .expect("the lead's continue resumes it");
    resume_after_answer(&opening)
        .await
        .expect("a continue with nothing owed answers");
    timeout(WAIT, opening.sessions.restart(opening.session_id))
        .await
        .expect("the restart takes its own lock once")
        .expect("the restart answers");

    assert_eq!(
        opening.resumed_runs.continued(),
        [(opening.earlier_run_id, RunState::WaitingForApproval)]
    );
    let continued = lock(&carried).clone();
    let [Some(held_run_continue), None] = continued.as_slice() else {
        panic!("one resume carries the continue and the restart none: {continued:?}");
    };
    assert_eq!(held_run_continue.lead_run_id, opening.earlier_run_id);
    assert_eq!(held_run_continue.entries, [entry]);
}

// A continue the provider refused gives its answer back, so the next continue carries it again,
// and posts the provider's refusal in its own words as the session's provider warning. Killed by
// the refused arm keeping the claim (the second continue resumes nothing) and by the notice not
// posted (no provider warning reads back).
#[tokio::test]
async fn a_refused_continue_owes_its_answer_to_the_next() {
    let (opening, carried, entry) = held_lead().await;
    opening.is_refused.store(true, Ordering::SeqCst);

    let refused = resume_after_answer(&opening).await;
    assert!(
        matches!(refused, Err(ProviderSessionError::ResumeRefused { .. })),
        "the refusal is answered: {refused:?}"
    );
    assert_eq!(
        read_notices(&opening.database.reader()),
        [SessionNotice::ProviderWarning {
            session_id: opening.session_id,
            source: ProviderWarningSource::Refusal,
            text: FreeFormText::new("the conversation could not be read".to_owned())
                .expect("a failure detail"),
            details: None,
        }]
    );
    opening.is_refused.store(false, Ordering::SeqCst);
    resume_after_answer(&opening)
        .await
        .expect("the next continue resumes the lead");

    let entries: Vec<_> = lock(&carried)
        .iter()
        .map(|carried| carried.as_ref().map(|carried| carried.entries.clone()))
        .collect();
    assert_eq!(entries, [Some(vec![entry.clone()]), Some(vec![entry])]);
}

// A helper beneath the lead that waits on an answered ask is continued with the lead: the continue
// carries the helper's answer under its helper id beside the lead's, and moves the helper on from
// its wait. Killed by a helper's answer left out of the continue and by the helper's wait kept.
#[tokio::test]
async fn a_helper_owed_an_answer_is_continued_with_its_lead() {
    let (opening, carried, lead_entry) = held_lead().await;
    let (lead, helper) = (opening.earlier_run_id, opening.run_id);
    opening
        .database
        .reader()
        .execute(
            "UPDATE runs SET parent_run_id = ?1, reached_by = 'providerSubagent',
               state = 'waitingForApproval'
             WHERE run_id = ?2",
            params![lead.text().as_str(), helper.text().as_str()],
        )
        .expect("the test makes the run the lead's helper");
    insert_run_event(
        &opening.database,
        opening.session_id,
        100,
        (SessionEventType::AgentSubagentStarted, lead, None),
        &json!({
            "sessionId": opening.session_id.text().as_str(),
            "runId": lead.text().as_str(),
            "provider": PROVIDERS[0].id,
            "subagentId": SUBAGENT_ID,
            "childRunId": helper.text().as_str(),
        }),
    );
    let approval_request_id =
        ApprovalRequestId::try_from(mint_uuid_v7()).expect("a minted UUID is an ask's id");
    let answer = ContinueAnswer::Approval {
        approval_request_id,
        subject: "cargo publish".to_owned(),
        tool_name: Some("Bash".to_owned()),
        decision: ApprovalDecision::Approved,
        decline_reason: None,
        edited_action: None,
    };
    opening.orphaned_approvals.owe(OwedAnswer {
        id: approval_request_id,
        run_id: helper,
        answer: answer.clone(),
    });

    resume_after_answer(&opening)
        .await
        .expect("the lead's continue resumes it");

    let continued = lock(&carried).clone();
    let [Some(held_run_continue)] = continued.as_slice() else {
        panic!("one resume carries the continue: {continued:?}");
    };
    assert_eq!(
        held_run_continue.entries,
        [
            lead_entry,
            ContinueEntry {
                run_id: helper,
                subagent_id: Some(SubagentId::new(SUBAGENT_ID.to_owned()).expect("a helper id")),
                answer,
            }
        ]
    );
    assert_eq!(
        opening.resumed_runs.continued(),
        [(helper, RunState::WaitingForApproval)]
    );
}

// A resume the provider answered without running the lead on gives its answer back, so the next
// continue carries it again, and leaves the waiting lead it answered in its wait until a continue
// is carried. Killed by the give-back on that arm dropped (the second continue resumes nothing) and
// by the answered lead moved on though the provider did not run it.
#[tokio::test]
async fn a_continue_the_lead_never_took_owes_its_answer_to_the_next() {
    let (opening, carried, entry) = held_lead().await;
    set_run_state(&opening, opening.earlier_run_id, "waitingForApproval");
    opening.is_continue_dropped.store(true, Ordering::SeqCst);

    resume_after_answer(&opening)
        .await
        .expect("the resume answers without the lead");
    assert_eq!(opening.resumed_runs.continued(), []);
    opening.is_continue_dropped.store(false, Ordering::SeqCst);
    resume_after_answer(&opening)
        .await
        .expect("the next continue resumes the lead");

    let entries: Vec<_> = lock(&carried)
        .iter()
        .map(|carried| carried.as_ref().map(|carried| carried.entries.clone()))
        .collect();
    assert_eq!(entries, [Some(vec![entry.clone()]), Some(vec![entry])]);
    assert_eq!(
        opening.resumed_runs.continued(),
        [(opening.earlier_run_id, RunState::WaitingForApproval)]
    );
}

// Where a resume the provider accepted fails on the daemon's side.
#[derive(Clone, Copy, Debug)]
enum AcceptedResumeFailure {
    // Settling the runs the resume named fails.
    RunsUnsettled,
    // Recording the binding the resume ran under fails.
    BindingUnrecorded,
    // Settling the runs fails where the process was already up and answered on its own binding.
    RunsUnsettledOnProcessUp,
}

// A continue the provider carried, whose runs could not be settled or whose binding could not be
// recorded after, keeps its answer claimed, so no later continue sends it again, a process already
// up included. Killed by a give-back on that path (the second continue carries the answer again).
#[rstest]
#[case::runs_unsettled(AcceptedResumeFailure::RunsUnsettled)]
#[case::binding_unrecorded(AcceptedResumeFailure::BindingUnrecorded)]
#[case::runs_unsettled_on_process_up(AcceptedResumeFailure::RunsUnsettledOnProcessUp)]
#[tokio::test]
async fn a_carried_continue_that_fails_after_keeps_its_answer_claimed(
    #[case] failure: AcceptedResumeFailure,
) {
    let (opening, carried, entry) = held_lead().await;
    let fail = |is_failing: bool| match failure {
        AcceptedResumeFailure::RunsUnsettled => opening.resumed_runs.set_refused(is_failing),
        AcceptedResumeFailure::BindingUnrecorded => {
            opening.is_row_taken.store(is_failing, Ordering::SeqCst);
        }
        AcceptedResumeFailure::RunsUnsettledOnProcessUp => {
            *lock(&opening.came_up_on) = Some(opening.predecessor_id.clone());
            opening.resumed_runs.set_refused(is_failing);
        }
    };
    fail(true);

    resume_after_answer(&opening)
        .await
        .expect_err("the continue fails after its resume");
    fail(false);
    resume_after_answer(&opening)
        .await
        .expect("the next continue answers with nothing owed");

    let entries: Vec<_> = lock(&carried)
        .iter()
        .map(|carried| carried.as_ref().map(|carried| carried.entries.clone()))
        .collect();
    assert_eq!(entries, [Some(vec![entry])]);
}

// The kept messages a carried continue delivered, by helper run.
#[derive(Default)]
struct DeliveredMessages(Mutex<Vec<(RunId, Vec<QueueItemId>)>>);

impl KeptMessages for DeliveredMessages {
    fn deliver_carried(
        &self,
        run_id: RunId,
        message_ids: Vec<QueueItemId>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.0).push((run_id, message_ids));
        async { Ok(()) }.boxed()
    }
}

// Makes `run_id` a helper of `lead` named `subagent_id` in `state`, its newest turn end the
// restart's cut, its log rows at `sequence` and the one after.
fn make_cut_helper(
    opening: &Opening,
    (lead, run_id): (RunId, RunId),
    subagent_id: &str,
    state: &str,
    sequence: i64,
) {
    opening
        .database
        .reader()
        .execute(
            "UPDATE runs SET parent_run_id = ?1, reached_by = 'providerSubagent', state = ?2
             WHERE run_id = ?3",
            params![lead.text().as_str(), state, run_id.text().as_str()],
        )
        .expect("the test makes the run the lead's helper");
    insert_run_event(
        &opening.database,
        opening.session_id,
        sequence,
        (SessionEventType::AgentSubagentStarted, lead, None),
        &json!({
            "sessionId": opening.session_id.text().as_str(),
            "runId": lead.text().as_str(),
            "provider": PROVIDERS[0].id,
            "subagentId": subagent_id,
            "childRunId": run_id.text().as_str(),
        }),
    );
    insert_run_event(
        &opening.database,
        opening.session_id,
        sequence + 1,
        (SessionEventType::AgentTurnInterrupted, run_id, Some(1)),
        &json!({ "cause": "daemonRestart" }),
    );
}

// Two paused helpers the person continues one after the other: the first continue resumes
// nothing while the second still holds the lead, and the second's carries one member naming both
// helpers, the first with its kept words, whose messages are delivered with it. Killed by the lead
// continued after the first helper's continue (a resume before the second), and by a continued
// helper left out of the member.
#[tokio::test]
async fn two_paused_helpers_continue_their_lead_once_both_are_continued() {
    let carried = Arc::new(Mutex::new(Vec::new()));
    let opening = Opening::new(
        Box::new({
            let carried = Arc::clone(&carried);
            move |params| lock(&carried).push(params.held_run_continue.clone())
        }),
        Box::new(|| {}),
        |_, _| {},
    )
    .await;
    let lead = opening.earlier_run_id;
    let (first, second) = (opening.run_id, new_run_id());
    insert_running_run(&opening.database, opening.session_id, second);
    make_cut_helper(&opening, (lead, first), "helper-1", "running", 100);
    make_cut_helper(&opening, (lead, second), "helper-2", "paused", 102);
    let message_id =
        QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an item id");
    let delivered = DeliveredMessages::default();
    let continued_words = ContinuedWords {
        kept: HashMap::from([(
            first,
            KeptWords {
                message_ids: vec![message_id],
                words: "check the tests first".to_owned(),
            },
        )]),
        messages: &delivered,
    };

    timeout(
        WAIT,
        opening
            .sessions
            .resume_after_answer(opening.session_id, &continued_words),
    )
    .await
    .expect("the continue takes its own lock once")
    .expect("a held lead's continue waits");
    assert!(
        lock(&carried).is_empty(),
        "the lead was continued past a paused helper"
    );

    set_run_state(&opening, second, "running");
    timeout(
        WAIT,
        opening
            .sessions
            .resume_after_answer(opening.session_id, &continued_words),
    )
    .await
    .expect("the continue takes its own lock once")
    .expect("the lead's continue resumes it");

    let continued = lock(&carried).clone();
    let [Some(held_run_continue)] = continued.as_slice() else {
        panic!("one resume carries the continue: {continued:?}");
    };
    assert_eq!(held_run_continue.lead_run_id, lead);
    let mut entries = held_run_continue.entries.clone();
    entries.sort_by_key(|entry| entry.subagent_id.clone().map(|id| id.as_str().to_owned()));
    let helper_id = |id: &str| Some(SubagentId::new(id.to_owned()).expect("a helper id"));
    assert_eq!(
        entries,
        [
            ContinueEntry {
                run_id: first,
                subagent_id: helper_id("helper-1"),
                answer: ContinueAnswer::Continued {
                    words: Some("check the tests first".to_owned()),
                },
            },
            ContinueEntry {
                run_id: second,
                subagent_id: helper_id("helper-2"),
                answer: ContinueAnswer::Continued { words: None },
            },
        ]
    );
    assert_eq!(*lock(&delivered.0), [(first, vec![message_id])]);
}

// A lead the person continued while a helper beneath it waited on them, the lead's waiting message
// kept, goes on once the helper's ask is answered: one continue carries the helper's answer, then
// the lead's own words, and delivers the lead's kept message with it; a continue after it, the
// message no longer kept, carries nothing. Killed by the lead left out of the continue (no lead
// member, nothing delivered), by its member before the helper's, by the answered helper counted
// as continued too (a third member), and by the lead continued while its helper still waits.
#[tokio::test]
async fn a_continue_of_a_lead_held_behind_a_waiting_helper_goes_once_the_helper_is_answered() {
    let carried = Arc::new(Mutex::new(Vec::new()));
    let opening = Opening::new(
        Box::new({
            let carried = Arc::clone(&carried);
            move |params| lock(&carried).push(params.held_run_continue.clone())
        }),
        Box::new(|| {}),
        |_, _| {},
    )
    .await;
    let (lead, helper) = (opening.earlier_run_id, opening.run_id);
    make_cut_helper(
        &opening,
        (lead, helper),
        "helper-1",
        "waitingForApproval",
        100,
    );
    let approval_request_id =
        ApprovalRequestId::try_from(mint_uuid_v7()).expect("a minted UUID is an ask's id");
    let answer = ContinueAnswer::Approval {
        approval_request_id,
        subject: "cargo test".to_owned(),
        tool_name: Some("Bash".to_owned()),
        decision: ApprovalDecision::Approved,
        decline_reason: None,
        edited_action: None,
    };
    opening.orphaned_approvals.owe(OwedAnswer {
        id: approval_request_id,
        run_id: helper,
        answer: answer.clone(),
    });
    opening.orphaned_approvals.set_open_ask(helper, true);
    let message_id =
        QueueItemId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an item id");
    let delivered = DeliveredMessages::default();
    let continued_words = ContinuedWords {
        kept: HashMap::from([(
            lead,
            KeptWords {
                message_ids: vec![message_id],
                words: "check the logs".to_owned(),
            },
        )]),
        messages: &delivered,
    };

    resume_with_words(&opening, &continued_words)
        .await
        .expect("a lead held behind its helper waits");
    assert!(
        lock(&carried).is_empty(),
        "the lead was continued while its helper waited"
    );
    opening.orphaned_approvals.set_open_ask(helper, false);
    resume_with_words(&opening, &continued_words)
        .await
        .expect("the helper's answer continues the lead");
    let nothing_kept = ContinuedWords {
        kept: HashMap::new(),
        messages: &delivered,
    };
    resume_with_words(&opening, &nothing_kept)
        .await
        .expect("a continue with nothing owed answers");

    let continued = lock(&carried).clone();
    let [Some(held_run_continue)] = continued.as_slice() else {
        panic!("one resume carries the continue: {continued:?}");
    };
    assert_eq!(held_run_continue.lead_run_id, lead);
    assert_eq!(
        held_run_continue.entries,
        [
            ContinueEntry {
                run_id: helper,
                subagent_id: Some(SubagentId::new("helper-1".to_owned()).expect("a helper id")),
                answer,
            },
            ContinueEntry {
                run_id: lead,
                subagent_id: None,
                answer: ContinueAnswer::Continued {
                    words: Some("check the logs".to_owned()),
                },
            },
        ]
    );
    assert_eq!(*lock(&delivered.0), [(lead, vec![message_id])]);
}
