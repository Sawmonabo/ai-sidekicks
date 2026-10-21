//! A side question on Codex: a throwaway, read-only copy of the session's conversation answers it
//! in one turn, and the answer is delivered as `session.sideQuestion.answered`. The copy runs under
//! the daemon's read-only profile, which keeps the credential denies, asks nothing and reaches no
//! tool server. Its frames are diverted before the session's own routing, its cost is metered
//! apart from the session's turns, and the copy is let go once it answered.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::controls::events::SessionSideQuestionAnsweredPayload;
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SideQuestionId, SideQuestionText,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::app_server_protocol::{
    AskForApproval, ThreadUnsubscribeParams,
};
use crate::provider::driver::codex::attachments::compose_codex_text_input;
use crate::provider::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_THREAD_TOKEN_USAGE_METHOD, CODEX_TURN_COMPLETED_METHOD,
};
use crate::provider::driver::codex::permission_level::compose_codex_profile_name;
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::service::supervisor::routing::read_codex_frame_thread_id;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::thread::settings::{
    CodexTurnStartParams, compose_codex_thread_fork_params,
};
use crate::provider::driver::codex::thread::view::{assert_active_permission_profile, read_thread};
use crate::provider::driver::codex::token_usage::read_codex_token_usage;
use crate::provider::driver::codex::transport::connection::read_codex_object;
use crate::provider::driver::codex::transport::diagnostics::{
    CodexTeardownStep, CodexTransportDiagnostic,
};
use crate::provider::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::provider::driver::session_control::AskSideQuestionParams;
use crate::provider::usage_delta_accountant::{
    MeteredUsageDelta, ThreadBaseEstablishment, UsageDeltaAccountant,
};
use crate::session::run::inbound::rows::SessionScopedRow;
use crate::session::run::inbound::{InboundDelivery, RunInboundDispatch};

const THREAD_FORK_METHOD: &str = "thread/fork";

const TURN_START_METHOD: &str = "turn/start";

const THREAD_UNSUBSCRIBE_METHOD: &str = "thread/unsubscribe";

/// The item type of the copy's reply.
const CODEX_AGENT_MESSAGE_ITEM_TYPE: &str = "agentMessage";

/// The turn status of a copy that answered.
const CODEX_COMPLETED_TURN_STATUS: &str = "completed";

/// Why a copy's turn gave no answer when Codex named no error.
const NO_ANSWER_DETAIL: &str = "The copy's turn ended with no answer.";

/// The cost one frame of a side question's copy metered, for the session's account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexSideQuestionUsage {
    /// The session the question was asked in, whose cost it is.
    pub(crate) session_id: SessionId,
    /// The account the copy ran on, `None` on the machine's default home.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The copy's metered turn; it belongs to no run.
    pub(crate) delta: MeteredUsageDelta,
}

/// A frame of a side question's copy, taken before the session's routing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexDivertedFrame {
    /// The cost the frame metered, where it was a usage reading.
    pub(crate) usage: Option<CodexSideQuestionUsage>,
}

/// One side question being answered on its copy.
struct CodexSideQuestion {
    service: Arc<CodexService>,
    session_id: SessionId,
    provider_account_id: Option<ProviderAccountId>,
    side_question_id: SideQuestionId,
    question: SideQuestionText,
    answer: Option<String>,
    // Fresh for the copy, so its cost never takes the session's own counts as its base.
    accountant: UsageDeltaAccountant,
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
    error: Option<CopyTurnError>,
}

#[derive(Deserialize)]
struct CopyTurnError {
    message: Option<String>,
}

/// The side questions of one Codex driver, by the copy's conversation.
pub(crate) struct CodexSideQuestions {
    /// Where an answer is delivered.
    dispatch: Arc<RunInboundDispatch>,
    /// Never held across an await.
    questions: Mutex<HashMap<String, CodexSideQuestion>>,
}

impl CodexSideQuestions {
    /// The side questions, delivering each answer through `dispatch`.
    #[expect(
        dead_code,
        reason = "the Codex driver builds the side questions its sessions share"
    )]
    pub(crate) fn new(dispatch: Arc<RunInboundDispatch>) -> Self {
        Self {
            dispatch,
            questions: Mutex::new(HashMap::new()),
        }
    }

    /// Asks `params`' question on a read-only copy of `record`'s conversation and answers once
    /// Codex took its turn. Fails as the fork or the turn's request fails, and with
    /// `CodexError::Transport` when the copy does not run read-only; the copy is let go either way.
    #[expect(dead_code, reason = "the Codex driver's side question asks through it")]
    pub(crate) async fn ask(
        &self,
        record: &CodexSessionRecord,
        params: &AskSideQuestionParams,
    ) -> Result<(), CodexError> {
        let service = Arc::clone(&record.service);
        let read_only_profile = compose_codex_profile_name(
            PermissionLevel::Readonly,
            &record.thread_settings.profile_folders,
        );
        // A fork keeps none of the thread's inline profiles, so the copy carries the settings
        // again; no route is passed, so it reaches no tool server.
        let mut fork = compose_codex_thread_fork_params(
            &record.thread_settings,
            None,
            record.thread_id.clone(),
        );
        fork.ephemeral = Some(true);
        fork.exclude_turns = Some(true);
        fork.permissions = Some(read_only_profile.clone());
        fork.approval_policy = Some(AskForApproval::Never);
        // Frames of the copy that arrive before it is registered are held for it.
        let claim = service.begin_thread_claim();
        let reply = service
            .connection()?
            .request(THREAD_FORK_METHOD, &fork)
            .await?;
        let copy_thread_id = read_thread(&reply, THREAD_FORK_METHOD)?.id;
        let mut accountant = UsageDeltaAccountant::new(DESCRIPTOR.provider_id());
        accountant.establish_thread(copy_thread_id.clone(), ThreadBaseEstablishment::Fresh);
        self.lock().insert(
            copy_thread_id.clone(),
            CodexSideQuestion {
                service: Arc::clone(&service),
                session_id: params.session_id,
                provider_account_id: record.provider_account_id.clone(),
                side_question_id: params.side_question_id,
                question: SideQuestionText(
                    FreeFormText::new(params.question.clone())
                        .expect("a side question's text was checked where it came in"),
                ),
                answer: None,
                accountant,
            },
        );
        service.register_thread(copy_thread_id.clone(), params.session_id);
        drop(claim);
        let started = match assert_active_permission_profile(
            &reply,
            &read_only_profile,
            THREAD_FORK_METHOD,
        ) {
            Ok(()) => start_turn(&service, &copy_thread_id, &params.question).await,
            Err(error) => Err(error),
        };
        if let Err(error) = started {
            if let Some(question) = self.lock().remove(&copy_thread_id) {
                let_go(&question.service, &copy_thread_id).await;
            }
            return Err(error);
        }
        Ok(())
    }

    /// Takes a frame of a side question's copy, `None` when it belongs to none. The copy's reply
    /// is kept, its usage metered, and its turn's end delivers the answer and lets the copy go
    /// off the caller's task. Never fails.
    #[expect(
        dead_code,
        reason = "the Codex session's frame routing diverts each copy's frame through it"
    )]
    pub(crate) fn divert(&self, method: &str, params: &RawValue) -> Option<CodexDivertedFrame> {
        let thread_id = read_codex_frame_thread_id(method, params)?;
        let mut questions = self.lock();
        let question = questions.get_mut(&thread_id)?;
        let mut diverted = CodexDivertedFrame { usage: None };
        match method {
            CODEX_ITEM_COMPLETED_METHOD => {
                if let Some(text) = read_codex_object::<CopyFrame>(params.get())
                    .and_then(|frame| frame.item)
                    .filter(|item| item.item_type.as_deref() == Some(CODEX_AGENT_MESSAGE_ITEM_TYPE))
                    .and_then(|item| item.text)
                    .filter(|text| !text.is_empty())
                {
                    question.answer = Some(text);
                }
            }
            CODEX_THREAD_TOKEN_USAGE_METHOD => {
                diverted.usage = read_codex_token_usage(params)
                    .and_then(|reading| question.accountant.meter_reading(reading))
                    .map(|delta| CodexSideQuestionUsage {
                        session_id: question.session_id,
                        provider_account_id: question.provider_account_id.clone(),
                        delta,
                    });
            }
            CODEX_TURN_COMPLETED_METHOD => {
                let question = questions
                    .remove(&thread_id)
                    .expect("the question was found under this lock");
                let turn =
                    read_codex_object::<CopyFrame>(params.get()).and_then(|frame| frame.turn);
                tokio::spawn(finish(
                    Arc::clone(&self.dispatch),
                    thread_id,
                    question,
                    turn,
                ));
            }
            _ => {}
        }
        Some(diverted)
    }

    /// Lets go of every copy `session_id`'s side questions still hold, once its conversation
    /// closed.
    #[expect(
        dead_code,
        reason = "the Codex session's close lets go of its side questions' copies"
    )]
    pub(crate) async fn forget_session(&self, session_id: SessionId) {
        let copies: Vec<(String, CodexSideQuestion)> = {
            let mut questions = self.lock();
            let thread_ids: Vec<String> = questions
                .iter()
                .filter(|(_, question)| question.session_id == session_id)
                .map(|(thread_id, _)| thread_id.clone())
                .collect();
            thread_ids
                .into_iter()
                .filter_map(|thread_id| {
                    questions
                        .remove(&thread_id)
                        .map(|question| (thread_id, question))
                })
                .collect()
        };
        for (thread_id, question) in copies {
            let_go(&question.service, &thread_id).await;
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, CodexSideQuestion>> {
        self.questions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

async fn start_turn(
    service: &CodexService,
    copy_thread_id: &str,
    question: &str,
) -> Result<(), CodexError> {
    service
        .connection()?
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
                service_tier: None,
                service_tier_for_turn: None,
            },
        )
        .await?;
    Ok(())
}

// Delivers the copy's answer when its turn completed with one, else reports why none came, then
// lets the copy go.
async fn finish(
    dispatch: Arc<RunInboundDispatch>,
    thread_id: String,
    question: CodexSideQuestion,
    turn: Option<CopyTurn>,
) {
    let answer = question
        .answer
        .and_then(|answer| FreeFormText::new(answer).ok());
    let is_completed = turn
        .as_ref()
        .is_some_and(|turn| turn.status.as_deref() == Some(CODEX_COMPLETED_TURN_STATUS));
    match answer {
        Some(answer) if is_completed => {
            dispatch_delivery(
                &dispatch,
                DeliveryOrigin {
                    provider: DESCRIPTOR.provider_id(),
                    provider_account_id: question.provider_account_id.clone(),
                    raw_wire_type: Some(CODEX_TURN_COMPLETED_METHOD),
                },
                InboundDelivery::SessionEvent {
                    row: SessionScopedRow::SideQuestionAnswered(
                        SessionSideQuestionAnsweredPayload {
                            session_id: question.session_id,
                            side_question_id: question.side_question_id,
                            question: question.question,
                            answer,
                        },
                    ),
                },
            )
            .await;
        }
        Some(_) | None => {
            let detail = turn
                .and_then(|turn| turn.error)
                .and_then(|error| error.message)
                .filter(|message| !message.trim().is_empty())
                .unwrap_or_else(|| NO_ANSWER_DETAIL.to_owned());
            CodexTransportDiagnostic::SideQuestionUnanswered {
                session_id: question.session_id,
                error: detail.into(),
            }
            .report();
        }
    }
    let_go(&question.service, &thread_id).await;
}

// Forgets the copy and unsubscribes from it while its service runs; a refused unsubscribe is
// reported, since the copy is ephemeral and unloads with the service anyway.
async fn let_go(service: &CodexService, thread_id: &str) {
    service.release_thread(thread_id);
    let Ok(connection) = service.connection() else {
        return;
    };
    let unsubscribed = connection
        .request(
            THREAD_UNSUBSCRIBE_METHOD,
            &ThreadUnsubscribeParams {
                thread_id: thread_id.to_owned(),
            },
        )
        .await;
    if let Err(error) = unsubscribed {
        CodexTransportDiagnostic::TeardownStepFailed {
            step: CodexTeardownStep::ThreadUnsubscribe,
            error: Box::new(error),
        }
        .report();
    }
}
