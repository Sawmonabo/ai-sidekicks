//! The session controls Codex carries on the conversation itself: Build or Plan as its
//! collaboration mode, sent with the session's model and effort; its own review of a set of
//! changes; and `Allow once` on a block its reviewer made at Reviewed. A review, and an
//! `Allow once` sent while no turn runs, start a turn, so each is started as the session's own
//! run; an `Allow once` goes into a turn only while that turn is live, and waits for a turn still
//! starting to run.

use std::sync::Arc;

use futures::FutureExt as _;
use serde_json::Value;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::controls::methods::{SessionMode, SessionReviewTarget};
use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::app_server_protocol::{
    ReviewStartParams, ReviewTarget, ThreadApproveGuardianDeniedActionParams, ThreadResumeParams,
};
use crate::provider::driver::codex::run::start::CodexRunStart;
use crate::provider::driver::codex::run::start::daemon_turns::{
    CodexDaemonTurnError, CodexDaemonTurnOpening,
};
use crate::provider::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::provider::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::slots::CodexSessionSlots;
use crate::provider::driver::codex::thread::settings::{
    CodexThreadSettingsUpdateParams, compose_codex_collaboration_mode,
};
use crate::provider::driver::codex::thread::view::read_turn_id;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::provider::driver::run_control::OverrideDenialParams;
use crate::provider::driver::session_control::StartReviewParams;
use crate::session::run::engine::RunEngineError;
use crate::session::run::inbound::{InboundDelivery, RunInboundDispatch};
use crate::session::run::refusals::RunRefusal;

const THREAD_SETTINGS_UPDATE_METHOD: &str = "thread/settings/update";
const REVIEW_START_METHOD: &str = "review/start";
const THREAD_RESUME_METHOD: &str = "thread/resume";
const APPROVE_GUARDIAN_DENIED_ACTION_METHOD: &str = "thread/approveGuardianDeniedAction";

/// Moves the conversation `thread_id` to `mode` from its next turn, as Codex's own collaboration
/// mode on `model` at `reasoning_effort`, with the mode's built-in instructions; the level and its
/// profile stay as they are. Fails as the request fails.
pub(crate) async fn update_codex_session_mode(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    mode: SessionMode,
    model: &str,
    reasoning_effort: Option<&str>,
) -> Result<(), CodexError> {
    connection
        .request(
            THREAD_SETTINGS_UPDATE_METHOD,
            &CodexThreadSettingsUpdateParams {
                thread_id: thread_id.to_owned(),
                collaboration_mode: Some(compose_codex_collaboration_mode(
                    mode,
                    model.to_owned(),
                    reasoning_effort,
                )),
                permissions: None,
                approval_policy: None,
                approvals_reviewer: None,
                service_tier: None,
            },
        )
        .await?;
    Ok(())
}

/// Starts Codex's own reviews and sends `Allow once` on its reviewer's blocks.
pub(crate) struct CodexSessionControls {
    slots: Arc<CodexSessionSlots>,
    run_start: Arc<CodexRunStart>,
    dispatch: Arc<RunInboundDispatch>,
}

impl CodexSessionControls {
    /// Controls reaching each session through `slots`, starting turns through `run_start` and
    /// recording a review's start through `dispatch`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the Codex driver builds its session controls")
    )]
    pub(crate) fn new(
        slots: Arc<CodexSessionSlots>,
        run_start: Arc<CodexRunStart>,
        dispatch: Arc<RunInboundDispatch>,
    ) -> Self {
        Self {
            slots,
            run_start,
            dispatch,
        }
    }

    /// Starts Codex's own review of `params.target` in the session's conversation as the
    /// session's own run and records its start; the review's end is recorded when Codex leaves
    /// review mode. Fails as the run's start fails.
    #[expect(dead_code, reason = "the Codex driver's review start")]
    pub(crate) async fn start_review(
        &self,
        params: StartReviewParams,
    ) -> Result<(), CodexDaemonTurnError> {
        let session_id = params.session_id;
        let target = params.target;
        let dispatch = Arc::clone(&self.dispatch);
        let opening: CodexDaemonTurnOpening = Arc::new(move |connection, thread_id| {
            let dispatch = Arc::clone(&dispatch);
            async move {
                let reply = connection
                    .request(
                        REVIEW_START_METHOD,
                        &ReviewStartParams {
                            delivery: None,
                            target: compose_review_target(target),
                            thread_id,
                        },
                    )
                    .await?;
                record_review_started(&dispatch, session_id, target).await;
                read_turn_id(&reply, REVIEW_START_METHOD).map(Some)
            }
            .boxed()
        });
        self.run_start
            .start_daemon_turn(session_id, opening)
            .await
            .map(drop)
    }

    /// Sends `Allow once` for a block Codex's reviewer made, with the review Codex sent as the
    /// block, on the conversation it was made in: into the turn running there, or, on the
    /// session's own conversation with no live turn, as the session's own run, since Codex then
    /// starts a turn for it. A conversation the service has not loaded is resumed first. A turn the
    /// daemon is stopping is waited out first, and a turn still starting is waited for to run, all
    /// within one request deadline, past which this fails with `CodexError::SessionTurnInFlight`,
    /// nothing sent. Fails as the requests fail and as the run's start fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex driver's `Allow once` on a reviewer's block"
        )
    )]
    pub(crate) async fn override_denial(
        &self,
        params: OverrideDenialParams,
    ) -> Result<(), CodexDaemonTurnError> {
        let event: Value = serde_json::from_str(params.provider_denial.get()).map_err(|error| {
            CodexError::Transport {
                detail: "The stored reviewer block does not read as JSON.".to_owned(),
                cause: Some(Box::new(error)),
            }
        })?;
        let session_id = params.session_id;
        let inbound = self.slots.require_live(session_id)?;
        let denial_thread_id = event
            .get("threadId")
            .and_then(Value::as_str)
            .filter(|thread_id| !thread_id.is_empty())
            .map(str::to_owned);
        let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: denial_thread_id.clone(),
            reply,
        })
        .await?;
        let thread_id = denial_thread_id.unwrap_or_else(|| reading.thread_id.clone());
        let approval = compose_approval(thread_id.clone(), event, !reading.is_thread_loaded);
        if thread_id != reading.thread_id {
            approval(reading.connection?, reading.thread_id).await?;
            return Ok(());
        }
        self.approve_on_session_thread(session_id, &inbound, approval)
            .await
    }

    // Sends the approval into the session's live turn, or as its own run while none is in
    // flight, waiting out a stopping turn and for a starting one within one request deadline.
    async fn approve_on_session_thread(
        &self,
        session_id: SessionId,
        inbound: &CodexSessionInboundSender,
        approval: CodexDaemonTurnOpening,
    ) -> Result<(), CodexDaemonTurnError> {
        let deadline = CodexTurnEndDeadline::for_request();
        let turn_held = || CodexError::SessionTurnInFlight { session_id };
        loop {
            // Sent into a turn still ending, it would start a turn no run holds once that ends.
            if !wait_for_codex_turns(inbound, CodexTurnWait::StoppedTurns, Some(&deadline)).await? {
                return Err(turn_held().into());
            }
            let reading = call_codex_session(inbound, |reply| CodexSessionCall::ReadSession {
                thread_id: None,
                reply,
            })
            .await?;
            if !reading.live_turn_runs.is_empty() {
                approval(reading.connection?, reading.thread_id).await?;
                return Ok(());
            }
            // A turn starting on the session, or a lead run the session's next turn is held for,
            // runs next, and the answer goes into it once it does.
            if !reading.is_turn_in_flight {
                match self
                    .run_start
                    .start_daemon_turn(session_id, Arc::clone(&approval))
                    .await
                {
                    Ok(_) => return Ok(()),
                    Err(
                        CodexDaemonTurnError::Engine(RunEngineError::Refused(
                            RunRefusal::SessionTurnHeld { .. },
                        ))
                        | CodexDaemonTurnError::Codex(CodexError::SessionTurnInFlight { .. }),
                    ) => {}
                    Err(error) => return Err(error),
                }
            }
            if !wait_for_codex_turns(inbound, CodexTurnWait::LiveTurn, Some(&deadline)).await? {
                return Err(turn_held().into());
            }
        }
    }
}

// The approval of `event` on `thread_id`, the conversation resumed first where the service has not
// loaded it; it names no turn, which Codex's own `turn/started` names where it starts one.
fn compose_approval(thread_id: String, event: Value, needs_resume: bool) -> CodexDaemonTurnOpening {
    Arc::new(
        move |connection: Arc<CodexAppServerConnection>, _session_thread_id| {
            let thread_id = thread_id.clone();
            let event = event.clone();
            async move {
                if needs_resume {
                    connection
                        .request(
                            THREAD_RESUME_METHOD,
                            &compose_bare_resume(thread_id.clone()),
                        )
                        .await?;
                }
                connection
                    .request(
                        APPROVE_GUARDIAN_DENIED_ACTION_METHOD,
                        &ThreadApproveGuardianDeniedActionParams { event, thread_id },
                    )
                    .await?;
                Ok(None)
            }
            .boxed()
        },
    )
}

// A resume that loads the conversation as it stands, its turns left out of the reply.
fn compose_bare_resume(thread_id: String) -> ThreadResumeParams {
    ThreadResumeParams {
        approval_policy: None,
        approvals_reviewer: None,
        base_instructions: None,
        config: None,
        cwd: None,
        developer_instructions: None,
        exclude_turns: Some(true),
        history: None,
        initial_turns_page: None,
        model: None,
        model_provider: None,
        path: None,
        permissions: None,
        personality: None,
        runtime_workspace_roots: None,
        sandbox: None,
        service_tier: None,
        thread_id,
    }
}

// What each review target asks Codex for. Codex names no staged set and the daemon holds no base
// branch for the session, so both are asked in words with the git command that reads them.
fn compose_review_target(target: SessionReviewTarget) -> ReviewTarget {
    match target {
        SessionReviewTarget::WorkingTree => ReviewTarget::UncommittedChanges,
        SessionReviewTarget::Staged => ReviewTarget::Custom {
            instructions: "Review the changes staged for commit, as `git diff --cached` shows \
                           them."
                .to_owned(),
        },
        SessionReviewTarget::Branch => ReviewTarget::Custom {
            instructions: "Review the commits on the current branch that its upstream does not \
                           have, as `git diff @{upstream}...HEAD` shows them."
                .to_owned(),
        },
    }
}

async fn record_review_started(
    dispatch: &RunInboundDispatch,
    session_id: SessionId,
    target: SessionReviewTarget,
) {
    Box::pin(dispatch_delivery(
        dispatch,
        DeliveryOrigin {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: None,
            raw_wire_type: Some(REVIEW_START_METHOD),
        },
        InboundDelivery::SessionNotice {
            session_id,
            notice: SessionNoticePostedPayload::Notice(SessionNotice::ReviewStarted {
                session_id,
                target,
            }),
        },
    ))
    .await;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use serde_json::value::RawValue;

    use super::CodexSessionControls;
    use crate::provider::driver::codex::session::test_session::{TestCodexSession, new_run_id};
    use crate::provider::driver::run_control::OverrideDenialParams;

    // Kills: the resume dropped, which Codex answers with "thread not found".
    #[tokio::test]
    async fn allow_once_on_a_conversation_the_service_has_not_loaded_resumes_it_first() {
        let mut session = TestCodexSession::start().await;
        let controls = CodexSessionControls::new(
            Arc::clone(&session.slots),
            Arc::clone(&session.run_start),
            Arc::clone(&session.dispatch),
        );
        let denial = json!({
            "threadId": "thread-left",
            "turnId": "turn-3",
            "action": {"type": "command", "command": "rm -rf build"},
        });
        let allow = controls.override_denial(OverrideDenialParams {
            session_id: session.task.record.session_id,
            run_id: new_run_id(),
            provider_denial: RawValue::from_string(denial.to_string()).expect("the denial is JSON"),
        });
        let task = &mut session.task;
        let script = &mut session.scripted.script;
        let flow = async {
            task.handle_next().await;
            let resumed = script.next_sent().await;
            assert_eq!(
                resumed["method"], "thread/resume",
                "the conversation is loaded first"
            );
            assert_eq!(resumed["params"]["threadId"], "thread-left");
            script.answer(&resumed, &json!({"thread": {"id": "thread-left"}}));
            let approved = script.next_sent().await;
            assert_eq!(approved["method"], "thread/approveGuardianDeniedAction");
            assert_eq!(approved["params"]["threadId"], "thread-left");
            assert_eq!(
                approved["params"]["event"], denial,
                "the stored block goes as sent"
            );
            script.answer(&approved, &json!({}));
        };
        let (allowed, ()) = tokio::time::timeout(
            Duration::from_secs(10),
            Box::pin(async { tokio::join!(allow, flow) }),
        )
        .await
        .expect("the approval settles");
        allowed.expect("Codex takes the approval");
    }
}
