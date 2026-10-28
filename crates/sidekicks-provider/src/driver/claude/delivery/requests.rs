//! The requests a live Claude Code process holds a run on that the daemon's own hooks do not
//! answer: tool asks, the question tool (as an ask, or through the Sandboxed question hook), the
//! plan a plan turn proposes as it asks to leave plan mode, the reviewer's blocks, the choices, a
//! tool server's messages and the withdrawals. Each ask is recorded pending, attributed to its
//! run's execution on the session's task and handed to its service on a task of its own once
//! admitted; with no service registered it stays pending at Claude Code. The pending asks are the
//! session's open asks, which a `Send now` row waits out.

pub(crate) mod answers;
mod pending;

use std::error::Error;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::future::BoxFuture;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::question::{QuestionOption, QuestionPrompt};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use self::answers::{
    ClaudeAnswerRuleError, ClaudeAnswerRules, ClaudeAskAnswerError, ClaudeHeldAsk,
    ClaudeHeldQuestion, ClaudeQuestionRoute, compose_claude_ask_answer,
    compose_claude_question_answer, compose_claude_question_refusal, compose_pre_tool_use_allow,
};
use self::pending::{HeldRequest, PendingRequest, RequestTables};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::ask_action::read_claude_ask_action;
use crate::driver::claude::delivery::claude_delivery_origin;
use crate::driver::claude::delivery::dialogs::{ClaudeDialogSession, ClaudeProviderDialogs};
use crate::driver::claude::delivery::reviewer::{ClaudeReviewerCapture, read_claude_hook_denial};
use crate::driver::claude::delivery::stream::ClaudeSessionStream;
use crate::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::driver::claude::event_normalizer::{
    CLAUDE_PLAN_EXIT_TOOL_NAME, CLAUDE_QUESTION_TOOL_NAME,
};
use crate::driver::claude::hooks::callbacks::answer_claude_request;
use crate::driver::claude::hooks::registration::ClaudeHookCallback as RegisteredHook;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeRunRoute, ClaudeRunRoutes};
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::permission_level::claude_permission_mode_for;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::tool_server_calls::{
    ClaudeToolServerCallContext, ClaudeToolServerCalls,
};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::inbound::{
    ClaudeHookCallback, ClaudeInboundRequest, ClaudeInboundRequestBody, ClaudeInboundRequestEvent,
    ClaudeToolUseAsk,
};
use crate::driver::claude::session::transport::user_message::{
    ClaudeWriteAttempt, ClaudeWriteDelivery,
};
use crate::driver::claude::spawn::settings::matches_claude_reviewed_removal_rule;
use crate::driver::contract::{DriverError, ProviderRequestAnswer};
use crate::driver::delivery_dispatch::dispatch_delivery;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::port::in_process_tool_servers::InProcessToolServers;
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::permission_ask::{
    PermissionAskPort, ProviderAnswerRule, ProviderPermissionAnswer, ProviderPermissionAsk,
    ProviderPermissionAskWithdrawal, ProviderRuleNotKeptError,
};
use crate::port::plan::{PlanPort, ProviderPlan};
use crate::port::question::{
    ProviderQuestion, ProviderQuestionWithdrawal, QuestionLinePlace, QuestionPort,
    QuestionTurnError, take_question_in_turn,
};
use crate::record_readers::read_non_empty_string;
use crate::run::delivery::{DeliveryBinding, DeliveryOperation, InboundDelivery, InboundOutcome};
use sidekicks_std::port_registration::PortRegistration;

// The decision reason of an ask an ask rule sent to the host.
const CLAUDE_RULE_DECISION: &str = "rule";

/// What the requests attribute, hand on and answer through.
pub(crate) struct ClaudeInboundRequestsDependencies {
    /// The run engine's dispatch, which admits each ask on its run.
    pub(crate) dispatch: Arc<dyn InboundDispatch>,
    /// The runs bound to each session.
    pub(crate) routes: Arc<ClaudeRunRoutes>,
    /// The approval pipeline's intake.
    pub(crate) permission_asks: Arc<PortRegistration<Arc<dyn PermissionAskPort>>>,
    /// The questions card's intake.
    pub(crate) questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
    /// The plan record's intake.
    pub(crate) plans: Arc<PortRegistration<Arc<dyn PlanPort>>>,
    /// The choices Claude Code holds a run on.
    pub(crate) dialogs: Arc<ClaudeProviderDialogs<ClaudeStreamDialogPorts>>,
    /// The reviewer's blocks.
    pub(crate) reviewer: Arc<ClaudeReviewerCapture>,
    /// What a made rule is kept with.
    pub(crate) answer_rules: ClaudeAnswerRules,
}

/// The live session a request event came from, as the requests read it.
pub(crate) struct ClaudeRequestSession<'a> {
    /// The session's stream, which holds the permission mode its process reported.
    pub(crate) stream: &'a ClaudeSessionStream,
    /// The session as the dialogs read it.
    pub(crate) dialog: ClaudeDialogSession<'a>,
    /// Its process.
    pub(crate) channel: Arc<dyn ClaudeProcessChannel>,
    /// The level the session runs at.
    pub(crate) level: Option<PermissionLevel>,
    /// The process's in-process tool-server calls still running.
    pub(crate) tool_server_calls: &'a ClaudeToolServerCalls,
    /// The in-process tool servers, once registered.
    pub(crate) tool_servers: Option<Arc<dyn InProcessToolServers>>,
}

/// Why an answer to a held request could not go back.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeRequestAnswerError {
    /// The session holds no such request open.
    #[error("Claude Code holds no request {request_id} of this session open")]
    NotHeld {
        /// The request.
        request_id: String,
    },
    /// The answer is of another kind than the request.
    #[error("the answer is of another kind than Claude Code's request")]
    KindMismatch,
    /// The ask's answer could not be composed; nothing was written.
    #[error(transparent)]
    Compose(#[from] ClaudeAskAnswerError),
    /// The answer could not be written; the request stays held.
    #[error(transparent)]
    Session(#[from] ClaudeSessionError),
    /// The answer's write was cut short, so Claude Code can never read it; its process is ended.
    #[error("the answer's write to the Claude Code process was cut short")]
    WriteCut(#[source] io::Error),
    /// The answer went, but the rule it made could not be kept.
    #[error(transparent)]
    RuleNotKept(#[from] ProviderRuleNotKeptError),
}

impl From<ClaudeRequestAnswerError> for DriverError {
    /// An unwritable answer is the session's failure; a rule not kept stays its own error, which
    /// the approval pipeline reads; anything else is the driver's.
    fn from(error: ClaudeRequestAnswerError) -> Self {
        match error {
            ClaudeRequestAnswerError::Session(error) => error.into(),
            ClaudeRequestAnswerError::RuleNotKept(error) => Self::Internal(Box::new(error)),
            error @ (ClaudeRequestAnswerError::NotHeld { .. }
            | ClaudeRequestAnswerError::KindMismatch
            | ClaudeRequestAnswerError::Compose(_)
            | ClaudeRequestAnswerError::WriteCut(_)) => Self::Internal(Box::new(error)),
        }
    }
}

/// Handles the requests a Claude Code process holds runs on, and answers them.
pub(crate) struct ClaudeInboundRequests {
    dependencies: ClaudeInboundRequestsDependencies,
    tables: Arc<Mutex<RequestTables>>,
}

impl ClaudeInboundRequests {
    /// Requests handled through `dependencies`.
    pub(crate) fn new(dependencies: ClaudeInboundRequestsDependencies) -> Self {
        Self {
            dependencies,
            tables: Arc::new(Mutex::new(RequestTables::default())),
        }
    }

    /// Takes one request event the daemon's own hooks did not answer, on the session's task. A
    /// withdrawal settles what it withdrew: a tool server's call is canceled, a pending ask's card
    /// settles canceled, and a choice is recorded by the dialogs.
    pub(crate) async fn take_request(
        &self,
        session: &ClaudeRequestSession<'_>,
        event: ClaudeInboundRequestEvent,
    ) {
        let request = match event {
            ClaudeInboundRequestEvent::Cancel { request_id } => {
                if !session.tool_server_calls.cancel(&request_id) {
                    self.withdraw(session, &request_id).await;
                }
                return;
            }
            ClaudeInboundRequestEvent::Request(request) => request,
        };
        let ClaudeInboundRequest { request_id, body } = request;
        match body {
            ClaudeInboundRequestBody::CanUseTool(ask) => {
                self.take_tool_ask(session, request_id, ask).await;
            }
            ClaudeInboundRequestBody::HookCallback(callback) => {
                self.take_hook_callback(session, request_id, &callback)
                    .await;
            }
            ClaudeInboundRequestBody::RequestUserDialog(dialog) => {
                let session_id = session.stream.session_id();
                match self.dependencies.routes.lead_run_on(session_id) {
                    Some(run) => {
                        self.dependencies
                            .dialogs
                            .take_dialog(&session.dialog, request_id, &dialog, run)
                            .await;
                    }
                    None => record_unattributed(session, "request_user_dialog", &request_id),
                }
            }
            ClaudeInboundRequestBody::McpMessage(message) => {
                session.tool_server_calls.start(
                    ClaudeToolServerCallContext {
                        session_id: session.stream.session_id(),
                        provider_account_id: session.stream.provider_account_id().clone(),
                        channel: Arc::clone(&session.channel),
                        servers: session.tool_servers.clone(),
                    },
                    request_id,
                    message,
                );
            }
            ClaudeInboundRequestBody::Unrouted { subtype } => {
                record_unattributed(session, &subtype, &request_id);
            }
        }
    }

    /// Answers one request a run is held on under its own id: a question with its answers, one per
    /// question in order, composed into the question tool's own answer; an ask with the approval
    /// pipeline's answer, then the rule it made kept. The request stays held when nothing was
    /// written; the session's open asks close once its answer went. Fails for a request the
    /// session no longer holds or an answer of the other kind, as the answer's write fails, and
    /// with [`ProviderRuleNotKeptError`] once the call is answered but its rule was not kept.
    pub(crate) async fn respond(
        &self,
        live: &LiveClaudeSession,
        request_id: &str,
        response: ProviderRequestAnswer,
    ) -> Result<(), ClaudeRequestAnswerError> {
        let (held, admission) = self
            .lock()
            .held(live.session_id, request_id)
            .map(|pending| (pending.held.clone(), pending.admission))
            .ok_or_else(|| ClaudeRequestAnswerError::NotHeld {
                request_id: request_id.to_owned(),
            })?;
        let (answer, made_rule) = match (&held, response) {
            (HeldRequest::Question(question), ProviderRequestAnswer::Question { answers }) => {
                (compose_claude_question_answer(question, &answers), None)
            }
            (HeldRequest::Ask(ask), ProviderRequestAnswer::Permission(answer)) => {
                let composed = compose_claude_ask_answer(
                    ask,
                    &answer,
                    self.dependencies.answer_rules.path_rules,
                )?;
                (composed, made_rule_of(answer))
            }
            (HeldRequest::Question(_), ProviderRequestAnswer::Permission(_))
            | (HeldRequest::Ask(_), ProviderRequestAnswer::Question { .. }) => {
                return Err(ClaudeRequestAnswerError::KindMismatch);
            }
        };
        write_answer(
            &self.tables,
            &*live.channel,
            live.session_id,
            request_id,
            admission,
            &answer,
        )
        .await?;
        let Some(made_rule) = made_rule else {
            return Ok(());
        };
        self.dependencies
            .answer_rules
            .keep(live, &made_rule)
            .await
            .map_err(|error: ClaudeAnswerRuleError| ProviderRuleNotKeptError {
                source: Box::new(error),
            })?;
        Ok(())
    }

    /// Whether the session holds an ask or a question open, and a receiver told once the last one
    /// closes; the receiver fails when the session's process ends first. `None` when none is open.
    pub(crate) fn wait_asks_closed(&self, session_id: SessionId) -> Option<oneshot::Receiver<()>> {
        self.lock().wait_closed(session_id)
    }

    /// How many asks and questions the session holds open, each one a reason it stays awake.
    pub(crate) fn open_request_count(&self, session_id: SessionId) -> u32 {
        u32::try_from(self.lock().open_count(session_id)).unwrap_or(u32::MAX)
    }

    /// Forgets the requests of a session whose process is gone; each one a service holds is
    /// withdrawn there, since nothing can answer it any more, and every waiter on its open asks
    /// is let go unanswered.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        let requests = self.lock().take_session(session_id);
        for (request_id, pending) in requests {
            self.hand_on_withdrawal(session_id, request_id, &pending);
        }
    }

    // Claude Code settled a request itself: an ask it withdrew goes to the approval pipeline, a
    // question to the questions card, and a choice it withdrew is recorded by the dialogs. One not
    // handed on yet is only dropped, so it never reaches its service.
    async fn withdraw(&self, session: &ClaudeRequestSession<'_>, request_id: &str) {
        let session_id = session.stream.session_id();
        let closed = self.lock().close(session_id, request_id);
        match closed {
            Some(pending) => self.hand_on_withdrawal(session_id, request_id.to_owned(), &pending),
            None => {
                self.dependencies
                    .dialogs
                    .withdraw(session_id, request_id)
                    .await;
            }
        }
    }

    fn hand_on_withdrawal(
        &self,
        session_id: SessionId,
        request_id: String,
        pending: &PendingRequest,
    ) {
        if !pending.is_handed_on {
            return;
        }
        let kind = pending.held.kind();
        let handed_on: Option<BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>>> =
            match pending.held {
                HeldRequest::Ask(_) => self.dependencies.permission_asks.port().cloned().map(
                    |port| -> BoxFuture<'static, _> {
                        Box::pin(async move {
                            port.withdraw_ask(ProviderPermissionAskWithdrawal {
                                session_id,
                                request_id,
                            })
                            .await
                        })
                    },
                ),
                HeldRequest::Question(_) => self.dependencies.questions.port().cloned().map(
                    |port| -> BoxFuture<'static, _> {
                        Box::pin(async move {
                            port.withdraw_question(ProviderQuestionWithdrawal {
                                session_id,
                                request_id,
                            })
                            .await
                        })
                    },
                ),
            };
        if let Some(handed_on) = handed_on {
            tokio::spawn(async move {
                if let Err(error) = handed_on.await {
                    record_hand_off_failure(session_id, kind, error.as_ref());
                }
            });
        }
    }

    async fn take_tool_ask(
        &self,
        session: &ClaudeRequestSession<'_>,
        request_id: String,
        ask: ClaudeToolUseAsk,
    ) {
        let session_id = session.stream.session_id();
        let run = attribute_claude_request(
            &self.dependencies.routes,
            session_id,
            ask.agent_id.as_deref(),
        );
        let (Some(tool_name), Some(run)) = (ask.tool_name.filter(|name| !name.is_empty()), run)
        else {
            record_unattributed(session, "can_use_tool", &request_id);
            return;
        };
        let input = read_input(ask.input.as_deref());
        if tool_name == CLAUDE_QUESTION_TOOL_NAME {
            self.ask_question(session, request_id, &run, ClaudeQuestionRoute::Ask, input)
                .await;
            return;
        }
        // The plan is recorded from the request itself, which stays held on its ask until answered.
        if tool_name == CLAUDE_PLAN_EXIT_TOOL_NAME {
            self.record_plan(session_id, &run, &input);
        }
        // At Reviewed only Claude Code's own removal check reaches the person: a removal the
        // level's removal rule sent while the process reviews in auto mode is the level's to
        // allow, which the approval pipeline does, and every other rule's ask goes to the person.
        let is_sent_by_level_rule = session.level == Some(PermissionLevel::Reviewed)
            && ask.decision_reason_type.as_deref() == Some(CLAUDE_RULE_DECISION)
            && matches_claude_reviewed_removal_rule(&tool_name, &input)
            && session
                .stream
                .permission_mode()
                .is_some_and(|mode| is_reviewed_mode(&mode));
        let flags = Map::from_iter([(
            "suppress_always_allow_rule".to_owned(),
            Value::Bool(ask.suppress_always_allow_rule == Some(true)),
        )]);
        let reading = read_claude_ask_action(&tool_name, &input, &flags);
        let tool_call_id = ask.tool_use_id.filter(|id| !id.is_empty());
        let prompt = ask.title.filter(|title| !title.is_empty()).or(ask
            .description
            .filter(|description| !description.is_empty()));
        let held = HeldRequest::Ask(ClaudeHeldAsk {
            input: input.clone(),
            action: reading.action.clone(),
        });
        let Some((admitted, _admission, _let_go)) = self
            .admit(
                session,
                &request_id,
                &run,
                tool_call_id.as_deref(),
                held,
                "control_request/can_use_tool",
            )
            .await
        else {
            return;
        };
        let Some(port) = self.dependencies.permission_asks.port().cloned() else {
            return;
        };
        let permission_ask = ProviderPermissionAsk {
            session_id,
            run_id: run.run_id,
            request_id,
            tool_name,
            input: Value::Object(input),
            action: reading.action,
            rule_scopes: reading.rule_scopes,
            is_provider_flagged: reading.is_provider_flagged,
            is_sent_by_level_rule,
            tool_call_id,
            prompt,
            correction_of: None,
        };
        tokio::spawn(async move {
            if let Err(error) = port.take_ask(permission_ask).await {
                record_hand_off_failure(session_id, admitted, error.as_ref());
            }
        });
    }

    async fn take_hook_callback(
        &self,
        session: &ClaudeRequestSession<'_>,
        request_id: String,
        callback: &ClaudeHookCallback,
    ) {
        let session_id = session.stream.session_id();
        let input = read_input(callback.input.as_deref());
        let run = attribute_claude_request(
            &self.dependencies.routes,
            session_id,
            read_non_empty_string(&input, "agent_id"),
        );
        match callback.callback_id.as_deref().and_then(RegisteredHook::of) {
            Some(RegisteredHook::QuestionBridge) => {
                if input.get("tool_name").and_then(Value::as_str) != Some(CLAUDE_QUESTION_TOOL_NAME)
                {
                    // A daemon tool at Sandboxed runs only on this hook's allow.
                    self.answer(session, request_id, &compose_pre_tool_use_allow(None))
                        .await;
                    return;
                }
                let Some(run) = run else {
                    record_unattributed(session, "hook_callback", &request_id);
                    return;
                };
                let tool_input = input
                    .get("tool_input")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                self.ask_question(
                    session,
                    request_id,
                    &run,
                    ClaudeQuestionRoute::Hook,
                    tool_input,
                )
                .await;
            }
            Some(RegisteredHook::PermissionDenied) => {
                if let (Some(report), Some(run)) = (read_claude_hook_denial(&input), run) {
                    self.dependencies
                        .reviewer
                        .capture(session_id, run.run_id, report);
                }
                self.answer(session, request_id, &Value::Object(Map::new()))
                    .await;
            }
            Some(
                RegisteredHook::PauseBeforeTool
                | RegisteredHook::PauseAfterBatch
                | RegisteredHook::HelperLimit
                | RegisteredHook::BackgroundWork
                | RegisteredHook::HelperSteerAfterTool
                | RegisteredHook::HelperSteerAtStop,
            )
            | None => record_unattributed(session, "hook_callback", &request_id),
        }
    }

    // A plan the agent proposes is recorded from the ask's own input, Claude Code's `plan` text and
    // the plan file it wrote beside it; the ask itself goes on to the approval pipeline.
    fn record_plan(&self, session_id: SessionId, run: &ClaudeBoundRun, input: &Map<String, Value>) {
        let Some(text) = input
            .get("plan")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        else {
            return;
        };
        let Some(port) = self.dependencies.plans.port().cloned() else {
            return;
        };
        let plan = ProviderPlan {
            session_id,
            run_id: run.run_id,
            text: text.to_owned(),
            plan_file_path: read_non_empty_string(input, "planFilePath")
                .and_then(|path| FilesystemPath::new(path.to_owned()).ok()),
            holds_request: false,
        };
        tokio::spawn(async move {
            if let Err(error) = port.take_plan(plan).await {
                record_hand_off_failure(session_id, "plan", error.as_ref());
            }
        });
    }

    async fn ask_question(
        &self,
        session: &ClaudeRequestSession<'_>,
        request_id: String,
        run: &ClaudeBoundRun,
        route: ClaudeQuestionRoute,
        input: Map<String, Value>,
    ) {
        let session_id = session.stream.session_id();
        let questions = read_question_prompts(&input);
        let held = HeldRequest::Question(ClaudeHeldQuestion {
            route,
            input,
            questions: questions.clone(),
        });
        let wire = match route {
            ClaudeQuestionRoute::Ask => "control_request/can_use_tool",
            ClaudeQuestionRoute::Hook => "control_request/hook_callback",
        };
        let Some((admitted, admission, let_go)) = self
            .admit(session, &request_id, run, None, held, wire)
            .await
        else {
            return;
        };
        let Some(port) = self.dependencies.questions.port().cloned() else {
            return;
        };
        let question = ProviderQuestion {
            session_id,
            run_id: run.run_id,
            request_id,
            questions,
            is_agent_waiting: true,
        };
        // Taken in its run's turn, its place in the run's line taken before its task runs: asked
        // while the run waits on something else, it waits on the card for the run; withdrawn or
        // ended with its run meanwhile, it is never taken, and once Claude Code let it go its take
        // withdraws it after its record's write.
        let place = QuestionLinePlace::line_up(question.run_id);
        let request_id = question.request_id.clone();
        let (tables, channel) = (Arc::clone(&self.tables), Arc::clone(&session.channel));
        tokio::spawn(async move {
            let taken = take_question_in_turn(
                port.as_ref(),
                question,
                None,
                place,
                let_go.clone().cancelled_owned(),
            )
            .await;
            let Err(error) = taken else {
                return;
            };
            record_hand_off_failure(session_id, admitted, &error);
            // Withdrawn from the card by its take, so the agent is answered refused rather than
            // left waiting on a request no card holds; one Claude Code let go of meanwhile is not
            // answered, since its id may already name a new request.
            if let QuestionTurnError::Take { .. } = error
                && !let_go.is_cancelled()
            {
                let refusal = compose_claude_question_refusal(route);
                let refused = write_answer(
                    &tables,
                    &*channel,
                    session_id,
                    &request_id,
                    admission,
                    &refusal,
                )
                .await;
                if let Err(refused_error) = refused {
                    record_hand_off_failure(session_id, admitted, &refused_error);
                }
            }
        });
    }

    // Records the request pending and admits it on its run's execution; `Some` with its kind, its
    // recording's number and its letting go once admitted and still pending, so it is handed on.
    // An ask from before an undo's cut is absorbed and never shown, and one withdrawn before it was
    // admitted never reaches its service.
    async fn admit(
        &self,
        session: &ClaudeRequestSession<'_>,
        request_id: &str,
        run: &ClaudeBoundRun,
        tool_call_id: Option<&str>,
        held: HeldRequest,
        wire: &str,
    ) -> Option<(&'static str, u64, CancellationToken)> {
        let session_id = session.stream.session_id();
        let kind = held.kind();
        let admission = self.lock().record(session_id, request_id, held);
        let delivery = InboundDelivery::PermissionAsk {
            binding: DeliveryBinding {
                binding_id: run.binding_id.clone(),
                operation: tool_call_id.map(|correlation_key| DeliveryOperation {
                    correlation_key,
                    is_opening: false,
                }),
            },
        };
        let origin = claude_delivery_origin(
            Some(session.stream.provider_account_id().clone()),
            Some(wire),
        );
        let outcome = dispatch_delivery(&*self.dependencies.dispatch, origin, delivery).await;
        let is_admitted = outcome == Some(InboundOutcome::AskAdmitted);
        let mut tables = self.lock();
        if is_admitted {
            return tables
                .mark_handed_on(session_id, request_id, admission)
                .map(|let_go| (kind, admission, let_go));
        }
        if tables.is_pending(session_id, request_id, admission) {
            tables.close(session_id, request_id);
        }
        None
    }

    // Answers a hook's request on the session's process.
    async fn answer(&self, session: &ClaudeRequestSession<'_>, request_id: String, answer: &Value) {
        answer_claude_request(
            &*session.channel,
            &session.stream.session_id(),
            session.stream.provider_account_id(),
            request_id,
            answer,
        )
        .await;
    }

    fn lock(&self) -> MutexGuard<'_, RequestTables> {
        lock(&self.tables)
    }
}

// Writes `answer` to the request Claude Code holds under `request_id`, recorded as `admission`,
// and closes that recording once it went, never a later one under the same id; a write cut short
// closes it too and ends the process, which can never read it.
async fn write_answer(
    tables: &Mutex<RequestTables>,
    channel: &dyn ClaudeProcessChannel,
    session_id: SessionId,
    request_id: &str,
    admission: u64,
    answer: &Value,
) -> Result<(), ClaudeRequestAnswerError> {
    let answer = serde_json::value::to_raw_value(answer)
        .expect("an answer the daemon composes always serializes");
    match channel
        .answer_inbound_request(request_id.to_owned(), answer)
        .await
    {
        ClaudeWriteAttempt::Written => {}
        ClaudeWriteAttempt::Failed {
            delivery: ClaudeWriteDelivery::Unsent,
            cause,
        } => return Err(ClaudeSessionError::InputUnwritable(cause).into()),
        ClaudeWriteAttempt::Failed {
            delivery: ClaudeWriteDelivery::Indeterminate,
            cause,
        } => {
            close_recording(tables, session_id, request_id, admission);
            channel.terminate().await;
            return Err(ClaudeRequestAnswerError::WriteCut(cause));
        }
    }
    close_recording(tables, session_id, request_id, admission);
    Ok(())
}

// Closes the recording `admission` of `request_id`, if it is the one still pending.
fn close_recording(
    tables: &Mutex<RequestTables>,
    session_id: SessionId,
    request_id: &str,
    admission: u64,
) {
    let mut tables = lock(tables);
    if tables.is_pending(session_id, request_id, admission) {
        tables.close(session_id, request_id);
    }
}

/// The run a request or a block belongs to: the helper's child run by its `agent_id`, else the
/// lead's; `None` for a helper with no child run, or a session no run holds.
pub(crate) fn attribute_claude_request(
    routes: &ClaudeRunRoutes,
    session_id: SessionId,
    agent_id: Option<&str>,
) -> Option<ClaudeBoundRun> {
    let Some(agent_id) = agent_id.filter(|id| !id.is_empty()) else {
        return routes.lead_run_on(session_id);
    };
    let run_id: RunId = routes.child_run_for(session_id, agent_id)?;
    match routes.route_of(run_id)? {
        ClaudeRunRoute::Child(route) => Some(ClaudeBoundRun {
            run_id,
            binding_id: route.binding_id,
        }),
        ClaudeRunRoute::Lead { .. } | ClaudeRunRoute::Apart => None,
    }
}

// The rule an ask's answer made, kept once the answer went.
fn made_rule_of(answer: ProviderPermissionAnswer) -> Option<ProviderAnswerRule> {
    match answer {
        ProviderPermissionAnswer::Allow { made_rule, .. }
        | ProviderPermissionAnswer::Refuse { made_rule, .. } => made_rule,
    }
}

// Whether the mode the process reported is the one Reviewed runs in.
fn is_reviewed_mode(mode: &str) -> bool {
    serde_json::to_value(claude_permission_mode_for(Some(PermissionLevel::Reviewed)))
        .is_ok_and(|reviewed| reviewed == mode)
}

// A request's relayed input as an object; any other JSON reads as none.
fn read_input(input: Option<&RawValue>) -> Map<String, Value> {
    input
        .and_then(|input| serde_json::from_str::<Map<String, Value>>(input.get()).ok())
        .unwrap_or_default()
}

// The question tool's questions as the questions card asks them; a malformed one is left out.
fn read_question_prompts(input: &Map<String, Value>) -> Vec<QuestionPrompt> {
    let Some(questions) = input.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    questions
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|question| {
            let text = read_non_empty_text(question, "question")?;
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_object)
                .filter_map(|option| {
                    Some(QuestionOption {
                        label: read_non_empty_text(option, "label")?,
                        description: read_non_empty_string(option, "description")
                            .map(str::to_owned),
                        preview: None,
                    })
                })
                .collect();
            Some(QuestionPrompt {
                header: read_non_empty_text(question, "header"),
                text,
                heading: None,
                description: None,
                options,
                several_answers: question.get("multiSelect") == Some(&Value::Bool(true)),
                secret: false,
                required: None,
                default: None,
                minimum: None,
                maximum: None,
                step: None,
                unit: None,
                placeholder: None,
            })
        })
        .collect()
}

fn read_non_empty_text(source: &Map<String, Value>, key: &str) -> Option<NonEmptyText> {
    read_non_empty_string(source, key).and_then(|text| NonEmptyText::new(text.to_owned()))
}

fn record_hand_off_failure(session_id: SessionId, kind: &str, error: &(dyn Error + 'static)) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: None,
        kind: DriverDiagnosticKind::DeliveryDispatchFailed,
        raw_wire_type: None,
        disposition_reason: describe_error(error),
        details: Map::from_iter([
            ("deliveryKind".to_owned(), Value::from(kind)),
            ("sessionId".to_owned(), Value::from(session_id.to_string())),
        ]),
    });
}

// A request with no run to hold, or of a kind the daemon does not answer, stays pending at Claude
// Code; the record says so.
fn record_unattributed(session: &ClaudeRequestSession<'_>, subtype: &str, request_id: &str) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: Some(session.stream.provider_account_id().clone()),
        kind: DriverDiagnosticKind::UnmappedWireKind,
        raw_wire_type: Some(format!("control_request/{subtype}")),
        disposition_reason: "a request Claude Code holds no daemon run on, or of a kind the \
                             daemon does not answer, is left pending at the provider"
            .to_owned(),
        details: Map::from_iter([
            (
                "sessionId".to_owned(),
                Value::from(session.stream.session_id().to_string()),
            ),
            ("requestId".to_owned(), Value::from(request_id)),
        ]),
    });
}

#[cfg(test)]
mod tests;
