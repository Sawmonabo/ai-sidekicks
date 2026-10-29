//! A side question on Codex: a throwaway, read-only copy of the session's conversation answers it
//! in one turn, the answer is delivered as `session.sideQuestion.answered`, and the ask is answered
//! once the copy's turn ended: with the answer delivered, refused where Codex's policy refused the
//! turn, else refused `provider.unavailable` in Codex's words for why no answer came. The copy runs
//! under the daemon's read-only profile, which keeps the credential denies, asks nothing and
//! reaches no tool server. On a live session it is forked on the session's service and its frames
//! are diverted before the session's own routing; on a resting one it is forked from the stored
//! conversation on the account's service over a connection of its own, which only it reads. Its
//! cost is metered apart from the session's turns, and the copy is let go once it answered or its
//! session closed.

use std::collections::HashMap;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::failure_cause::{RunFailureCause, RunRefusedOrigin};
use sidekicks_contracts::session::controls::events::SessionSideQuestionAnsweredPayload;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SideQuestionId, SideQuestionText,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::text_cut::cut_to_code_points;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::{AskForApproval, ThreadForkParams};
use crate::driver::codex::attachments::compose_codex_text_input;
use crate::driver::codex::delivery::memory::read_codex_error_kind;
use crate::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_THREAD_TOKEN_USAGE_METHOD, CODEX_TURN_COMPLETED_METHOD,
};
use crate::driver::codex::permission_level::compose_codex_profile_name;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::routing::read_codex_frame_thread_id;
use crate::driver::codex::session::detached_conversation::{
    CodexDetachedFrame, CodexDetachedFrames, stop_detached_turn,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::CodexSessionEstablishment;
use crate::driver::codex::session::slots::let_go_codex_thread;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::thread::settings::{
    CodexThreadSettings, CodexTurnStartParams, compose_codex_relay_environments,
    compose_codex_thread_fork_params,
};
use crate::driver::codex::thread::view::{
    TURN_START_METHOD, assert_active_permission_profile, read_thread, read_turn_id,
};
use crate::driver::codex::token_usage::read_codex_token_usage;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::codex::transport::diagnostics::{CodexDeliveryPort, CodexTransportDiagnostic};
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::contract::{DriverError, bound_failure_detail};
use crate::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::driver::error_causes::{
    UNSPECIFIED_PROVIDER_FAILURE_DETAIL, provider_failure_refusal, side_question_refusal,
};
use crate::driver::session_control::{AskSideQuestionParams, ResumeSessionParams};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner, UsageSink};
use crate::run::delivery::{InboundDelivery, SessionScopedRow};
use crate::usage_delta_accountant::{ThreadBaseEstablishment, UsageDeltaAccountant};

const THREAD_FORK_METHOD: &str = "thread/fork";

/// The item type of the copy's reply.
const CODEX_AGENT_MESSAGE_ITEM_TYPE: &str = "agentMessage";

/// Why a copy's turn gave no answer when Codex named no error.
const NO_ANSWER_DETAIL: &str = "The copy's turn ended with no answer.";

/// The `codexErrorInfo` arms of a turn Codex's policy refused.
const CODEX_POLICY_REFUSALS: [&str; 2] = ["cyberPolicy", "misalignmentPolicyViolation"];

/// What came of a side question whose copy was forked: answered with its answer delivered, or why
/// none came. It closes unanswered when a close or the driver's shutdown stopped the copy.
pub(crate) type CodexSideQuestionAnswer = oneshot::Receiver<Result<(), CodexError>>;
/// A frame of a side question's copy, taken before the session's routing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexDivertedFrame {
    /// The cost the frame metered, where it was a usage reading, filed under the session's
    /// binding as the lead's own.
    pub(crate) usage: Option<MeteredUsage>,
}

/// One side question being answered on its copy.
struct CodexSideQuestion {
    service: Arc<CodexService>,
    session_id: SessionId,
    // The session's binding, which the copy's cost is filed under.
    binding_id: RuntimeBindingId,
    provider_account_id: ProviderAccountId,
    side_question_id: SideQuestionId,
    question: SideQuestionText,
    // The model the copy runs, which a refusal names.
    model: String,
    answer: Option<String>,
    // Where what came of the question goes.
    answered: oneshot::Sender<Result<(), CodexError>>,
    // Fresh for the copy, so its cost never takes the session's own counts as its base.
    accountant: UsageDeltaAccountant,
    // Fires once the copy's session closed or the driver shut down before its turn ended.
    stop: CancellationToken,
    // The copy's turn, once its start answered.
    turn_id: Option<String>,
}

// The members of a copy's frame the side question reads.
#[derive(Deserialize)]
struct CopyFrame {
    item: Option<CopyItem>,
    turn: Option<CopyTurn>,
}

#[derive(Deserialize)]
struct CopyItem {
    #[serde(rename = "type")]
    item_type: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct CopyTurn {
    status: Option<String>,
    error: Option<Value>,
}

/// What one frame of a copy did.
enum CopyFrameTaken {
    /// The frame was kept, with the cost it metered where it was a usage reading.
    Kept(Option<MeteredUsage>),
    /// The copy's turn ended, as the frame's turn reads where it carried one.
    Ended(Option<CopyTurn>),
}

impl CodexSideQuestion {
    // The question asked as `params` on `service`'s copy `copy_thread_id` of a conversation on
    // `model`, its cost based fresh, stopped through `stop`, what came of it sent on `answered`.
    fn new(
        service: Arc<CodexService>,
        provider_account_id: ProviderAccountId,
        params: &AskSideQuestionParams,
        (copy_thread_id, model): (&str, String),
        stop: CancellationToken,
        answered: oneshot::Sender<Result<(), CodexError>>,
    ) -> Self {
        let mut accountant = UsageDeltaAccountant::new(DESCRIPTOR.provider_id());
        accountant.establish_thread(copy_thread_id.to_owned(), ThreadBaseEstablishment::Fresh);
        Self {
            service,
            session_id: params.session_id,
            binding_id: params.binding_id.clone(),
            provider_account_id,
            side_question_id: params.side_question_id,
            question: SideQuestionText(
                FreeFormText::new(params.question.clone())
                    .expect("a side question's text was checked where it came in"),
            ),
            model,
            answer: None,
            answered,
            accountant,
            stop,
            turn_id: None,
        }
    }

    // Reads one frame of the copy: its reply is kept, its usage metered, and its turn's end
    // answered.
    fn take_frame(&mut self, method: &str, params: &RawValue) -> CopyFrameTaken {
        match method {
            CODEX_ITEM_COMPLETED_METHOD => {
                if let Some(text) = read_codex_object::<CopyFrame>(params.get())
                    .and_then(|frame| frame.item)
                    .filter(|item| item.item_type.as_deref() == Some(CODEX_AGENT_MESSAGE_ITEM_TYPE))
                    .and_then(|item| item.text)
                    .filter(|text| !text.is_empty())
                {
                    self.answer = Some(text);
                }
                CopyFrameTaken::Kept(None)
            }
            CODEX_THREAD_TOKEN_USAGE_METHOD => CopyFrameTaken::Kept(
                read_codex_token_usage(params)
                    .and_then(|reading| self.accountant.meter_reading(reading))
                    .map(|delta| MeteredUsage {
                        session_id: self.session_id,
                        binding_id: self.binding_id.clone(),
                        owner: MeteredUsageOwner::SideQuestion,
                        delta,
                    }),
            ),
            CODEX_TURN_COMPLETED_METHOD => CopyFrameTaken::Ended(
                read_codex_object::<CopyFrame>(params.get()).and_then(|frame| frame.turn),
            ),
            _ => CopyFrameTaken::Kept(None),
        }
    }
}

/// The side questions of one Codex driver, by the copy's conversation.
pub(crate) struct CodexSideQuestions {
    /// Where an answer is delivered.
    dispatch: Arc<dyn InboundDispatch>,
    /// The driver's tasks, which its shutdown waits for; each answer is delivered on one.
    tasks: TaskTracker,
    /// The live copies answering, by the copy's conversation. Never held across an await.
    questions: Mutex<HashMap<String, CodexSideQuestion>>,
    /// Every copy from before its fork. Taken before `questions` where both are held. Never held
    /// across an await.
    copy_stops: Arc<Mutex<CodexCopyStops>>,
}

/// The copies a close or the driver's shutdown stops from before their fork on.
struct CodexCopyStops {
    /// By side question: a live copy's until its fork answered, a resting one's until its
    /// answer's task ended.
    copies: HashMap<SideQuestionId, CodexCopyStop>,
    /// Set once the driver stopped every copy, so a copy asked for after it is stopped at once.
    is_closed: bool,
}

/// What stops a side question's copy when its session closes or the driver shuts down first.
struct CodexCopyStop {
    session_id: SessionId,
    stop: CancellationToken,
}

impl CodexSideQuestions {
    /// The side questions, delivering each answer through `dispatch` as a task of `tasks`.
    pub(crate) fn new(dispatch: Arc<dyn InboundDispatch>, tasks: TaskTracker) -> Self {
        Self {
            dispatch,
            tasks,
            questions: Mutex::new(HashMap::new()),
            copy_stops: Arc::new(Mutex::new(CodexCopyStops {
                copies: HashMap::new(),
                is_closed: false,
            })),
        }
    }

    /// Asks `params`' question on a read-only copy of `record`'s conversation and answers, once
    /// Codex took its turn, where what came of it will go; it is never awaited on the session's
    /// task, which reads the copy's frames. A copy whose session closed while it was forked is let
    /// go with no turn started, one stopped while its turn started has the turn stopped, and one
    /// asked for after the driver stopped every copy is never forked; each closes its answer
    /// unanswered. Fails as the fork or the turn's request fails, and with
    /// `CodexError::Transport` when the copy does not run read-only; the copy is let go either way.
    pub(crate) async fn ask(
        &self,
        record: &CodexSessionRecord,
        params: &AskSideQuestionParams,
    ) -> Result<CodexSideQuestionAnswer, CodexError> {
        let (answered, answer) = oneshot::channel();
        let stop = self.enter_copy(params);
        if stop.is_cancelled() {
            return Ok(answer);
        }
        let service = Arc::clone(&record.service);
        let (fork, read_only_profile) =
            compose_copy_fork(&record.thread_settings, record.thread_id.clone());
        // Frames of the copy that arrive before it is registered are held for it.
        let claim = service.begin_thread_claim();
        let forked = async {
            let connection = service.connection()?;
            let reply = connection.request(THREAD_FORK_METHOD, &fork).await?;
            let copy_thread_id = read_thread(&reply, THREAD_FORK_METHOD)?.id;
            Ok::<_, CodexError>((connection, reply, copy_thread_id))
        }
        .await;
        let (connection, reply, copy_thread_id) = match forked {
            Ok(forked) => forked,
            Err(error) => {
                self.remove_copy_stop(params.side_question_id);
                return Err(error);
            }
        };
        let question = CodexSideQuestion::new(
            Arc::clone(&service),
            record.provider_account_id.clone(),
            params,
            (&copy_thread_id, record.thread_settings.model.clone()),
            stop,
            answered,
        );
        if !self.hand_over_live_copy(params.side_question_id, &copy_thread_id, question) {
            drop(claim);
            let_go_codex_thread(&service, &copy_thread_id).await;
            return Ok(answer);
        }
        service.register_side_question_thread(copy_thread_id.clone(), params.session_id);
        drop(claim);
        let started = match assert_active_permission_profile(
            &reply,
            &read_only_profile,
            THREAD_FORK_METHOD,
        ) {
            Ok(()) => {
                start_turn(
                    &connection,
                    &copy_thread_id,
                    &record.thread_settings.working_directory,
                    &params.question,
                )
                .await
            }
            Err(error) => Err(error),
        };
        let turn_id = match started {
            Ok(turn_id) => turn_id,
            Err(error) => {
                let question = self.lock().remove(&copy_thread_id);
                if let Some(question) = question {
                    let_go_codex_thread(&question.service, &copy_thread_id).await;
                }
                return Err(error);
            }
        };
        self.keep_live_turn(&copy_thread_id, turn_id).await;
        Ok(answer)
    }

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

    /// Takes a frame of a side question's copy, `None` when it belongs to none. The copy's reply
    /// is kept, its usage metered, and its turn's end delivers the answer and lets the copy go
    /// off the caller's task. Never fails.
    pub(crate) fn divert(&self, method: &str, params: &RawValue) -> Option<CodexDivertedFrame> {
        let thread_id = read_codex_frame_thread_id(method, params)?;
        let mut questions = self.lock();
        let question = questions.get_mut(&thread_id)?;
        match question.take_frame(method, params) {
            CopyFrameTaken::Kept(usage) => Some(CodexDivertedFrame { usage }),
            CopyFrameTaken::Ended(turn) => {
                let question = questions
                    .remove(&thread_id)
                    .expect("the question was found under this lock");
                self.tasks.spawn(finish(
                    Arc::clone(&self.dispatch),
                    thread_id,
                    question,
                    turn,
                ));
                Some(CodexDivertedFrame { usage: None })
            }
        }
    }

    /// Lets go of every copy `session_id`'s side questions still hold, once its conversation
    /// closed: a live session's turn stopped and the copy let go off its service, a resting one's
    /// turn stopped on its own task, and one still forking or starting its turn let go by its ask,
    /// its turn stopped once started.
    pub(crate) async fn forget_session(&self, session_id: SessionId) {
        lock(&self.copy_stops)
            .copies
            .retain(|_side_question_id, copy| {
                let is_kept = copy.session_id != session_id;
                if !is_kept {
                    copy.stop.cancel();
                }
                is_kept
            });
        // Together, so a wedged service holds the close one let-go's bound, not one per copy.
        let let_go = self
            .take_live_copies(|question| question.session_id == session_id)
            .into_iter()
            .map(|(thread_id, question)| let_go_live_copy(thread_id, question));
        futures::future::join_all(let_go).await;
    }

    /// Stops every copy, as the driver shuts down, and every copy asked for after it, since their
    /// services may outlive the daemon, and nothing is delivered: a live one whose turn started
    /// has it stopped and is let go before this answers; a resting one's turn is stopped by its
    /// own task; one still forking or starting its turn is let go by its ask, which stops the turn
    /// once started while its service still has a connection, and logs the turn it cannot stop.
    pub(crate) async fn stop_every_copy(&self) {
        {
            let mut copy_stops = lock(&self.copy_stops);
            copy_stops.is_closed = true;
            for (_side_question_id, copy) in copy_stops.copies.drain() {
                copy.stop.cancel();
            }
        }
        let let_go = self
            .take_live_copies(|_question| true)
            .into_iter()
            .map(|(thread_id, question)| let_go_live_copy(thread_id, question));
        futures::future::join_all(let_go).await;
    }

    // Stops the live copies `is_stopped` picks, and takes out each whose turn started, to be let
    // go; one whose turn is still starting stays for its ask, which stops the turn once started.
    fn take_live_copies(
        &self,
        is_stopped: impl Fn(&CodexSideQuestion) -> bool,
    ) -> Vec<(String, CodexSideQuestion)> {
        self.lock()
            .extract_if(|_thread_id, question| {
                if !is_stopped(question) {
                    return false;
                }
                question.stop.cancel();
                question.turn_id.is_some()
            })
            .collect()
    }

    // Keeps the live copy's started turn `turn_id` in its entry; where a close or the driver's
    // shutdown stopped the copy while its turn started, stops the turn and lets the copy go.
    async fn keep_live_turn(&self, copy_thread_id: &str, turn_id: String) {
        let stopped = {
            let mut questions = self.lock();
            // A copy whose turn already ended was let go as it ended.
            let Some(question) = questions.get_mut(copy_thread_id) else {
                return;
            };
            question.turn_id = Some(turn_id);
            if !question.stop.is_cancelled() {
                return;
            }
            questions.remove(copy_thread_id)
        };
        if let Some(question) = stopped {
            let_go_live_copy(copy_thread_id.to_owned(), question).await;
        }
    }

    // Takes the live copy of `side_question_id` out of `copy_stops` and enters it as `question`
    // under that lock, so a close after it finds it there; `false` when a close took it first.
    fn hand_over_live_copy(
        &self,
        side_question_id: SideQuestionId,
        copy_thread_id: &str,
        question: CodexSideQuestion,
    ) -> bool {
        let mut copy_stops = lock(&self.copy_stops);
        let is_entered = copy_stops.copies.remove(&side_question_id).is_some();
        if is_entered {
            self.lock().insert(copy_thread_id.to_owned(), question);
        }
        is_entered
    }

    // Enters `params`' copy under its session before its fork, so a close meanwhile stops it; a
    // stop already fired, entering nothing, once the driver stopped every copy.
    fn enter_copy(&self, params: &AskSideQuestionParams) -> CancellationToken {
        let stop = CancellationToken::new();
        let mut copy_stops = lock(&self.copy_stops);
        if copy_stops.is_closed {
            stop.cancel();
            return stop;
        }
        copy_stops.copies.insert(
            params.side_question_id,
            CodexCopyStop {
                session_id: params.session_id,
                stop: stop.clone(),
            },
        );
        stop
    }

    fn remove_copy_stop(&self, side_question_id: SideQuestionId) {
        lock(&self.copy_stops).copies.remove(&side_question_id);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, CodexSideQuestion>> {
        lock(&self.questions)
    }
}

// The fork of `thread_id` a side question's copy runs on, and the read-only profile it must answer
// it runs under: ephemeral, its turns left out, asking nothing. A fork keeps none of the thread's
// inline profiles, so the copy carries the settings again; no route is passed, so it reaches no
// tool server.
fn compose_copy_fork(
    settings: &CodexThreadSettings,
    thread_id: String,
) -> (ThreadForkParams, String) {
    let read_only_profile =
        compose_codex_profile_name(PermissionLevel::Readonly, &settings.profile_folders);
    let mut fork = compose_codex_thread_fork_params(settings, None, thread_id);
    fork.ephemeral = Some(true);
    fork.exclude_turns = Some(true);
    fork.permissions = Some(read_only_profile.clone());
    fork.approval_policy = Some(AskForApproval::Never);
    (fork, read_only_profile)
}

// Starts the copy's one turn on `question`, its commands on the daemon's relay in
// `working_directory` as the session's own, and answers the turn's id.
async fn start_turn(
    connection: &CodexAppServerConnection,
    copy_thread_id: &str,
    working_directory: &Path,
    question: &str,
) -> Result<String, CodexError> {
    let reply = connection
        .request(
            TURN_START_METHOD,
            &CodexTurnStartParams {
                thread_id: copy_thread_id.to_owned(),
                input: vec![compose_codex_text_input(question.to_owned())],
                approvals_reviewer: None,
                collaboration_mode: None,
                model: None,
                client_user_message_id: None,
                output_schema: None,
                effort: None,
                service_tier: None,
                service_tier_for_turn: None,
                environments: Some(compose_codex_relay_environments(working_directory)),
            },
        )
        .await?;
    read_turn_id(&reply, TURN_START_METHOD)
}

// Forks the resting session's stored conversation that `resume` names into a read-only copy on the
// account's service, over a connection of its own; the service and the copy. Fails as
// `ask_at_rest` fails.
async fn fork_resting_copy(
    establishment: &CodexSessionEstablishment,
    resume: &ResumeSessionParams,
) -> Result<(Arc<CodexService>, CodexRestingCopy), CodexError> {
    let (service, settings) = establishment.compose_resting_conversation(resume).await?;
    let (events, frames) = CodexDetachedFrames::new();
    let connection = service.open_detached_connection(events).await?;
    let (fork, read_only_profile) = compose_copy_fork(&settings, resume.resume_handle.clone());
    // An error from here drops the connection, which ends the copy.
    let reply = connection.request(THREAD_FORK_METHOD, &fork).await?;
    let thread_id = read_thread(&reply, THREAD_FORK_METHOD)?.id;
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
struct CodexRestingCopy {
    connection: CodexAppServerConnection,
    frames: mpsc::UnboundedReceiver<CodexDetachedFrame>,
    thread_id: String,
    model: String,
    working_directory: PathBuf,
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
                if let Some(sink) = usage.port()
                    && let Err(error) = sink.record_metered(metered).await
                {
                    CodexTransportDiagnostic::PortDeliveryFailed {
                        provider_account_id: Some(question.provider_account_id.clone()),
                        port: CodexDeliveryPort::Usage,
                        session_id: Some(question.session_id),
                        error,
                    }
                    .report();
                }
            }
            CopyFrameTaken::Kept(None) => {}
            CopyFrameTaken::Ended(turn) => return turn,
        }
    }
    None
}

// Takes the live copy off its session's routing, stops its turn where it started, as a throwaway
// turn is stopped, then lets the copy go off its session's service.
async fn let_go_live_copy(thread_id: String, question: CodexSideQuestion) {
    // The copy's frames, its stopped turn's end among them, reach no session.
    question.service.release_thread(&thread_id);
    if let Some(turn_id) = question.turn_id {
        match question.service.connection() {
            Ok(connection) => {
                stop_detached_turn(&connection, &thread_id, async { Ok(turn_id) }).await;
            }
            // A service the daemon stopped runs no turn of the copy's; a lasting one may.
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                thread_id,
                turn_id,
                "a side question's copy has no connection left to stop its turn on"
            ),
        }
    }
    let_go_codex_thread(&question.service, &thread_id).await;
}

// Delivers the copy's answer and lets the copy go off its session's service.
async fn finish(
    dispatch: Arc<dyn InboundDispatch>,
    thread_id: String,
    question: CodexSideQuestion,
    turn: Option<CopyTurn>,
) {
    let service = Arc::clone(&question.service);
    deliver_answer(&*dispatch, question, turn).await;
    let_go_codex_thread(&service, &thread_id).await;
}

// Delivers the copy's answer when its turn completed with one, and answers the ask with what came
// of it. A NUL the answer holds is dropped, since the row's text carries none.
async fn deliver_answer(
    dispatch: &dyn InboundDispatch,
    question: CodexSideQuestion,
    turn: Option<CopyTurn>,
) {
    let CodexSideQuestion {
        session_id,
        provider_account_id,
        side_question_id,
        question,
        model,
        answer,
        answered,
        ..
    } = question;
    let answer = answer.and_then(|answer| FreeFormText::new(answer.replace('\0', "")).ok());
    let is_completed = turn.as_ref().is_some_and(|turn| {
        turn.status.as_deref().and_then(CodexTurnStatus::read) == Some(CodexTurnStatus::Completed)
    });
    let outcome = match answer {
        Some(answer) if is_completed => {
            Box::pin(dispatch_delivery(
                dispatch,
                DeliveryOrigin {
                    provider: DESCRIPTOR.provider_id(),
                    provider_account_id: Some(provider_account_id),
                    raw_wire_type: Some(CODEX_TURN_COMPLETED_METHOD),
                },
                InboundDelivery::SessionEvent {
                    row: SessionScopedRow::SideQuestionAnswered(
                        SessionSideQuestionAnsweredPayload {
                            session_id,
                            side_question_id,
                            question,
                            answer,
                        },
                    ),
                },
            ))
            .await;
            Ok(())
        }
        Some(_) | None => Err(unanswered(
            session_id,
            side_question_id,
            &model,
            turn.and_then(|turn| turn.error).as_ref(),
        )),
    };
    // An ask whose caller stopped waiting has no one left to tell.
    let _unheard = answered.send(outcome);
}

// Why a copy's turn on `model` gave no answer: refused `session.sideQuestion.refused` with Codex's
// error as the cause where Codex's policy refused the turn, else Codex's failure refused
// `provider.unavailable` in Codex's words.
fn unanswered(
    session_id: SessionId,
    side_question_id: SideQuestionId,
    model: &str,
    error: Option<&Value>,
) -> CodexError {
    let words = |member: &str| {
        error
            .and_then(|error| error.get(member))
            .and_then(Value::as_str)
            .filter(|words| !words.trim().is_empty())
    };
    let refusal = read_codex_error_kind(error)
        .filter(|kind| CODEX_POLICY_REFUSALS.contains(&kind.as_str()))
        .map(|kind| RunFailureCause::Refused {
            origin: RunRefusedOrigin::Provider,
            // A model name no handle can carry names the provider instead, so a refusal stays one.
            model: wire_handle(model).unwrap_or_else(|| {
                wire_handle(DESCRIPTOR.provider_id().as_str())
                    .expect("a provider's id is a wire handle")
            }),
            sentence: words("message").map(failure_detail),
            explanation: words("additionalDetails").map(failure_detail),
            safety_category: wire_handle(&kind),
        });
    match refusal {
        Some(cause) => CodexError::Driver(DriverError::Refused(side_question_refusal(
            session_id,
            side_question_id,
            &cause,
        ))),
        None => CodexError::Driver(DriverError::Refused(provider_failure_refusal(
            &DESCRIPTOR.provider_id(),
            "Codex gave the side question no answer",
            RefusalCode::ProviderUnavailable,
            CopyTurnFailure(words("message").unwrap_or(NO_ANSWER_DETAIL).to_owned()),
        ))),
    }
}

/// Codex's own words for a copy's turn that ended with no answer.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct CopyTurnFailure(String);

fn failure_detail(words: &str) -> FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN> {
    bound_failure_detail(words, UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone())
}

// `text` cut to a wire handle's cap; `None` where it is blank.
fn wire_handle(text: &str) -> Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>> {
    FreeFormText::new(cut_to_code_points(text, PROVIDER_WIRE_HANDLE_MAX_LEN).to_owned()).ok()
}

/// Waits for what came of a side question: `Ok` once its answer was delivered, and once a close
/// or the driver's shutdown stopped its copy, with nothing delivered. Fails as the copy's turn gave
/// no answer: refused `session.sideQuestion.refused` where Codex's policy refused it.
pub(crate) async fn wait_for_side_question_answer(
    answer: CodexSideQuestionAnswer,
) -> Result<(), CodexError> {
    // A stopped copy drops its question unanswered.
    answer.await.unwrap_or(Ok(()))
}

#[cfg(test)]
pub(crate) mod test_copies;
#[cfg(test)]
mod tests;
