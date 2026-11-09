//! The copy of a Codex session at rest a side question runs on: forked from the stored
//! conversation on the account's service over a connection of its own, which only it reads, its
//! frames read until its turn ended and its answer delivered.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::{mpsc, oneshot};

use super::{
    CodexCopyStops, CodexSideQuestion, CodexSideQuestionAnswer, CodexSideQuestions, CopyFrameTaken,
    THREAD_FORK_METHOD, deliver_answer, file_copy_usage, request_copy_fork, start_turn,
};
use crate::driver::codex::permission_level::compose_codex_profile_name;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::routing::read_codex_frame_thread_id;
use crate::driver::codex::session::detached_conversation::{
    CodexDetachedFrame, CodexDetachedFrames, stop_detached_turn,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::CodexSessionEstablishment;
use crate::driver::codex::session::side_questions::copy_turn::CopyTurn;
use crate::driver::codex::thread::view::{assert_active_permission_profile, read_thread};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::session_control::{AskSideQuestionParams, ResumeSessionParams};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::usage_sink::UsageSink;

impl CodexSideQuestions {
    /// Asks `params`' question on a read-only copy of the resting session's stored conversation,
    /// which `resume` names with the session's settings and account: forked on the account's
    /// service, started now, over a connection of its own, its cost filed through `usage`; answers,
    /// once Codex took its turn, where what came of it will go. The copy is let go with its
    /// connection once its turn ended, or once [`Self::forget_session`] or
    /// [`Self::stop_every_copy`] stopped it, its turn stopped where it started; a copy stopped
    /// closes its answer unanswered. Fails as `establishment` cannot compose the settings or start
    /// the service, as the connection, the fork or the turn's request fails, and with
    /// `CodexError::Transport` when the copy does not run read-only.
    pub(crate) async fn ask_at_rest(
        &self,
        establishment: &CodexSessionEstablishment,
        resume: &ResumeSessionParams,
        params: &AskSideQuestionParams,
        usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    ) -> Result<CodexSideQuestionAnswer, CodexError> {
        let (answered, answer) = oneshot::channel();
        let stop = self.enter_copy(params);
        if stop.is_cancelled() {
            return Ok(answer);
        }
        // A stop before the copy's turn is asked for drops the connection, which ends the copy.
        let forked = stop
            .run_until_cancelled(fork_resting_copy(establishment, resume))
            .await;
        let (service, copy) = match forked {
            Some(Ok(forked)) => forked,
            Some(Err(error)) => {
                self.remove_copy_stop(params.side_question_id);
                return Err(error);
            }
            None => return Ok(answer),
        };
        let started = {
            let start = start_turn(
                &copy.connection,
                &copy.thread_id,
                &copy.working_directory,
                &params.question,
            );
            tokio::pin!(start);
            tokio::select! {
                biased;
                started = &mut start => started,
                // Once asked for, the turn starts whatever the stop: wait for its id, then stop it.
                () = stop.cancelled() => {
                    stop_detached_turn(&copy.connection, &copy.thread_id, start).await;
                    return Ok(answer);
                }
            }
        };
        let turn_id = match started {
            Ok(turn_id) => turn_id,
            Err(error) => {
                self.remove_copy_stop(params.side_question_id);
                return Err(error);
            }
        };
        let mut question = CodexSideQuestion::new(
            service,
            resume.provider_account_id.clone(),
            params,
            (&copy.thread_id, copy.model.clone()),
            stop,
            answered,
        );
        question.turn_id = Some(turn_id.clone());
        self.tasks.spawn(answer_at_rest(
            Arc::clone(&self.dispatch),
            usage,
            question,
            copy,
            turn_id,
            Arc::clone(&self.copy_stops),
        ));
        Ok(answer)
    }
}

/// Forks the resting session's stored conversation that `resume` names into a read-only copy on the
/// account's service, over a connection of its own; the service and the copy. Fails as
/// `ask_at_rest` fails.
pub(crate) async fn fork_resting_copy(
    establishment: &CodexSessionEstablishment,
    resume: &ResumeSessionParams,
) -> Result<(Arc<CodexService>, CodexRestingCopy), CodexError> {
    let (service, settings) = establishment.compose_resting_conversation(resume).await?;
    let (events, frames) = CodexDetachedFrames::new();
    let connection = service.open_detached_connection(events).await?;
    // An error from here drops the connection, which ends the copy.
    let reply = request_copy_fork(&connection, &settings, &resume.resume_handle).await?;
    let thread_id = read_thread(&reply, THREAD_FORK_METHOD)?.id;
    let read_only_profile =
        compose_codex_profile_name(PermissionLevel::Readonly, &settings.profile_folders);
    assert_active_permission_profile(&reply, &read_only_profile, THREAD_FORK_METHOD)?;
    Ok((
        service,
        CodexRestingCopy {
            connection,
            frames,
            thread_id,
            model: settings.model,
            working_directory: settings.working_directory,
        },
    ))
}

/// A resting session's copy: the connection of its own it runs on, where that connection's
/// notifications arrive, its conversation and the model it runs.
pub(crate) struct CodexRestingCopy {
    pub(crate) connection: CodexAppServerConnection,
    pub(crate) frames: mpsc::UnboundedReceiver<CodexDetachedFrame>,
    pub(crate) thread_id: String,
    pub(crate) model: String,
    pub(crate) working_directory: PathBuf,
}

// Reads a resting session's copy's frames until its turn ended and delivers its answer, its cost
// filed through `usage`; once its connection dropped the ask fails with no answer, and once the
// question's stop fired its turn is stopped and nothing is delivered. The copy leaves `copy_stops`
// and is let go with its connection.
async fn answer_at_rest(
    dispatch: Arc<dyn InboundDispatch>,
    usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    mut question: CodexSideQuestion,
    mut copy: CodexRestingCopy,
    turn_id: String,
    copy_stops: Arc<Mutex<CodexCopyStops>>,
) {
    let stop = question.stop.clone();
    let read = stop
        .run_until_cancelled(read_copy_turn(&mut question, &mut copy, &usage))
        .await;
    lock(&copy_stops).copies.remove(&question.side_question_id);
    if let Some(turn) = read {
        deliver_answer(&*dispatch, question, turn).await;
    } else {
        stop_detached_turn(&copy.connection, &copy.thread_id, async { Ok(turn_id) }).await;
    }
}

// Reads the copy's frames until its turn ended, as the turn's end reads, or `None` once its
// connection dropped; each usage reading is filed through `usage`, a refused one reported.
async fn read_copy_turn(
    question: &mut CodexSideQuestion,
    copy: &mut CodexRestingCopy,
    usage: &PortRegistration<Arc<dyn UsageSink>>,
) -> Option<CopyTurn> {
    while let Some((method, params)) = copy.frames.recv().await {
        if read_codex_frame_thread_id(&method, &params).as_deref() != Some(copy.thread_id.as_str())
        {
            continue;
        }
        match question.take_frame(&method, &params) {
            CopyFrameTaken::Kept(Some(metered)) => {
                file_copy_usage(usage, *metered, &question.provider_account_id).await;
            }
            CopyFrameTaken::Kept(None) => {}
            CopyFrameTaken::Ended(turn) => return turn,
        }
    }
    None
}
