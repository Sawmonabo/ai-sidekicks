//! A held lead continued once the person answered: the resume carries the answers owed it only
//! while the lead runs, each answer once, and owes it again to the next resume when the provider
//! refused the one that carried it or resumed without continuing the lead.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use rusqlite::params;
use sidekicks_contracts::approval::{ApprovalDecision, ApprovalRequestId};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::events::{ProviderWarningSource, SessionNotice};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::session_control::held_run_continue::{
    ContinueAnswer, ContinueEntry, HeldRunContinue,
};
use sidekicks_std::mutex_lock::lock;
use tokio::time::timeout;

use super::super::{Opening, WAIT};
use crate::provider_session::errors::ProviderSessionError;
use crate::provider_session::held_run_continue::OwedAnswer;
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
    let answer = ContinueAnswer::Approval {
        subject: "rm -rf build".to_owned(),
        tool_name: Some("Bash".to_owned()),
        decision: ApprovalDecision::Approved,
        decline_reason: None,
        edited_action: None,
    };
    opening.kept_approvals.owe(OwedAnswer {
        id: ApprovalRequestId::try_from(mint_uuid_v7()).expect("a minted UUID is an ask's id"),
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
    timeout(
        WAIT,
        opening.sessions.resume_after_answer(opening.session_id),
    )
    .await
    .expect("the continue takes its own lock once")
}

// While the lead still waits on the person the answer resumes nothing; once it runs, one resume
// carries the answer, and neither a second answer's continue nor a restart carries it again.
// Killed by the member composed while the lead is held (a resume while it waits), by the claim
// skipped (the second continue or the restart carries the answer again), and by a continue run
// with no member (a resume carrying `None`).
#[tokio::test]
async fn a_kept_answer_continues_the_lead_once() {
    let (opening, carried, entry) = held_lead().await;
    set_run_state(&opening, opening.earlier_run_id, "waitingForApproval");

    resume_after_answer(&opening)
        .await
        .expect("a held lead's continue waits");
    assert!(lock(&carried).is_empty(), "a held lead was resumed");

    set_run_state(&opening, opening.earlier_run_id, "running");
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

// A resume the provider answered without running the lead on gives its answer back, so the next
// continue carries it again. Killed by the give-back on that arm dropped (the second continue
// resumes nothing).
#[tokio::test]
async fn a_continue_the_lead_never_took_owes_its_answer_to_the_next() {
    let (opening, carried, entry) = held_lead().await;
    opening.is_continue_dropped.store(true, Ordering::SeqCst);

    resume_after_answer(&opening)
        .await
        .expect("the resume answers without the lead");
    opening.is_continue_dropped.store(false, Ordering::SeqCst);
    resume_after_answer(&opening)
        .await
        .expect("the next continue resumes the lead");

    let entries: Vec<_> = lock(&carried)
        .iter()
        .map(|carried| carried.as_ref().map(|carried| carried.entries.clone()))
        .collect();
    assert_eq!(entries, [Some(vec![entry.clone()]), Some(vec![entry])]);
}
