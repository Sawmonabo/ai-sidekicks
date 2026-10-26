//! Codex's approvals and questions: each is first a permission ask the run engine attributes to its
//! run's execution, then, once admitted, the approvals' or the questions card's to answer, held at
//! the connection meanwhile; the session's queue never waits for the person. Until that owner is
//! registered the ask stays pending at Codex; nothing answers it in its place.
//!
//! Codex's answer to an approval carries only its decision, so the rest of a person's answer is
//! carried by Codex's own means: a rule as `acceptForSession`, then written into the rule file of
//! each of the project's working folders where it is the project's; a decline's reason as the words
//! steered into the same turn after the decline; and a command or path the person corrected as a
//! decline, a steer asking the agent to use the corrected one, and Codex's next ask for exactly
//! that one in the same turn naming the card it was approved on. The decision always goes first, so
//! a rule that cannot be kept never leaves the call waiting. A command allow Codex would keep as a
//! prefix that also lets a force push through is never handed over: the daemon answers each ask.
//! Codex keeps one pending question per turn, so a second question on a turn takes the first's
//! card back.

pub(crate) mod attribution;
pub(crate) mod questions;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::approval::{ApprovalRequestId, RememberedScopeKind};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::mutex_lock::lock;
use crate::policy::destructive_git::covers_destructive_git;
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::driver::codex::attachments::compose_codex_text_input;
use crate::provider::driver::codex::delivery::ask_action::read_codex_ask_action;
use crate::provider::driver::codex::delivery::asks::questions::read_codex_question_prompts;
use crate::provider::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::provider::driver::codex::rules::CodexRulesError;
use crate::provider::driver::codex::run::steer::steer_codex_run;
use crate::provider::driver::codex::server_requests::{
    CodexAskKind, CodexAskOwner, CodexInboundServerRequest, CodexRoutedMethod,
    CodexServerRequestAnswer, CodexServerRequestDecision,
};
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::session::inbound::CodexSessionInboundSender;
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::diagnostics::{
    CodexDeliveryPort, CodexTransportDiagnostic,
};
use crate::provider::driver::contract::{
    DriverError, ProviderRequestAnswer, RespondToRequestParams,
};
use crate::provider::inbound_json::decode_inbound_json;
use crate::provider::port::permission_ask::{
    PermissionAskPort, ProviderAskAction, ProviderAskRule, ProviderPermissionAnswer,
    ProviderPermissionAsk, ProviderPermissionAskWithdrawal, ProviderRuleNotKeptError,
};
use crate::provider::port::question::{
    ProviderQuestion, ProviderQuestionWithdrawal, QuestionLinePlace, QuestionPort,
    take_question_in_turn,
};
use crate::provider::port::registration::PortRegistration;
use crate::provider::project_rule_folders::write_into_project_folders;
use crate::provider::record_readers::read_non_empty_string;
use crate::session::run::epochs::DeliveryOperation;
use crate::session::run::inbound::{DeliveryBinding, InboundDelivery, InboundOutcome};

/// The two owners an admitted ask goes to, each registered at runtime.
pub(crate) struct CodexAskOwners {
    /// The approval pipeline's intake.
    pub(crate) permission_asks: Arc<PortRegistration<Arc<dyn PermissionAskPort>>>,
    /// The questions card's intake.
    pub(crate) questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
}

/// Writes a project's rule into, or takes it back out of, one of the project's working folders,
/// reading the rule files Codex reads there.
pub(crate) trait CodexProjectRules: Send + Sync {
    /// Writes `rule` into `project_folder`'s own rule file. Fails as the write fails or Codex
    /// would refuse the rule.
    fn write<'call>(
        &'call self,
        project_folder: &'call Path,
        rule: &'call ProviderAskRule,
    ) -> BoxFuture<'call, Result<(), CodexRulesError>>;

    /// Takes `rule` back out of `project_folder`'s own rule file. Fails as the removal fails.
    fn remove<'call>(
        &'call self,
        project_folder: &'call Path,
        rule: &'call ProviderAskRule,
    ) -> BoxFuture<'call, Result<(), CodexRulesError>>;
}

/// What the hand-off delivers through, reads with and writes a project's rules with.
pub(crate) struct CodexAskHandOffDependencies {
    /// The frame delivery, through which each ask reaches the run engine.
    pub(crate) delivery: Arc<CodexFrameDelivery>,
    /// The owners an admitted ask goes to.
    pub(crate) owners: CodexAskOwners,
    /// The daemon-wide bound a command ask's line is read under.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// How a project rule is written into one working folder.
    pub(crate) project_rules: Arc<dyn CodexProjectRules>,
    /// The driver's tasks, which its shutdown waits for; each card is raised and taken back on
    /// one.
    pub(crate) tasks: TaskTracker,
}

/// An approval held for its card: the turn it holds, the run it is on, and what it would do.
struct CodexHeldApproval {
    turn_id: Option<String>,
    run_id: RunId,
    action: ProviderAskAction,
    /// The scopes a rule on it may take, handed to its card.
    rule_scopes: Vec<RememberedScopeKind>,
}

/// What the hand-off remembers per session, never held across an await.
#[derive(Default)]
struct CodexAskState {
    /// The approvals held for their card, by session then Codex's request id.
    held_approvals: HashMap<SessionId, HashMap<String, CodexHeldApproval>>,
    /// The corrected commands and paths approved, by session then turn, each with the card it was
    /// approved on, taken by Codex's next ask for it in the same turn and dropped when the turn
    /// ends.
    corrections: HashMap<SessionId, HashMap<String, HashMap<String, ApprovalRequestId>>>,
    /// The questions held for their card, by session then Codex's request id.
    pending_questions: HashMap<SessionId, HashMap<String, PendingQuestion>>,
}

/// A question held for its card, and Codex's letting go of it, which ends its take.
struct PendingQuestion {
    /// The turn a user-input question is pending on, where Codex keeps one, so a later one there
    /// replaces it.
    pending_on_turn: Option<String>,
    /// Canceled once Codex lets go of it: answered, withdrawn, replaced by a later question of its
    /// turn, its turn ended or its session closed.
    let_go: CancellationToken,
}

/// Hands Codex's approvals and questions to the run engine, then to their owner, and carries the
/// answers back.
pub(crate) struct CodexAskHandOff {
    dependencies: CodexAskHandOffDependencies,
    state: Mutex<CodexAskState>,
}

impl CodexAskHandOff {
    /// The hand-off over `dependencies`.
    pub(crate) fn new(dependencies: CodexAskHandOffDependencies) -> Self {
        Self {
            dependencies,
            state: Mutex::new(CodexAskState::default()),
        }
    }

    /// Delivers one approval or question of `record`'s session as a permission ask on `owner`'s
    /// binding and, once the run engine admits it, holds it for its card, the card raised once the
    /// connection holds the ask. An ask on no run, one the run engine absorbed or refused, and a
    /// command that would start a provider's background work are refused at Codex. Called on the
    /// session's task; it never waits for the person.
    pub(crate) async fn hold(
        &self,
        record: &CodexSessionRecord,
        owner: Option<CodexAskOwner>,
        request: &CodexInboundServerRequest,
    ) -> CodexServerRequestDecision {
        let method = request.method.method();
        let Some(owner) = owner else {
            return refuse(format!(
                "The provider's \"{method}\" request belongs to no run this daemon holds, so no \
                 one can answer it."
            ));
        };
        let params = match read_params(request) {
            Ok(params) => params,
            Err(reason) => return refuse(reason),
        };
        let approval = match request.ask_kind {
            CodexAskKind::Approval => {
                match self
                    .read_approval(record, owner.run_id, request, &params)
                    .await
                {
                    Ok(approval) => Some(approval),
                    Err(refused) => return refused,
                }
            }
            CodexAskKind::Question | CodexAskKind::CallbackTool => None,
        };
        let delivery = InboundDelivery::PermissionAsk {
            binding: DeliveryBinding {
                binding_id: owner.binding_id.clone(),
                operation: Some(DeliveryOperation {
                    correlation_key: &request.request_id,
                    is_opening: true,
                }),
            },
        };
        let outcome = self
            .dependencies
            .delivery
            .send(record, delivery, method)
            .await;
        if outcome != Some(InboundOutcome::AskAdmitted) {
            return refuse(format!(
                "The provider's \"{method}\" request belongs to a run that already ended or was \
                 cut, so it is not asked."
            ));
        }
        match approval {
            Some(approval) => self.hand_approval(record, request, params, approval),
            None => self.hand_question(record, owner.run_id, request, &params),
        }
    }

    /// Answers a held ask of `session_id` on `service`: a question with its answers, an approval
    /// with the approval pipeline's answer carried by Codex's own means, the decision first, then
    /// the steer after a decline or a correction through the session's `inbound` queue, then the
    /// project rule the answer made. Fails as the answer or the steer fails, and with
    /// [`ProviderRuleNotKeptError`] once the call is answered but its project rule could not be
    /// written; a steer whose turn has ended is reported, since its decline already landed.
    pub(crate) async fn answer(
        &self,
        service: &CodexService,
        inbound: &CodexSessionInboundSender,
        session_id: SessionId,
        params: RespondToRequestParams,
    ) -> Result<(), DriverError> {
        let connection = service.connection()?;
        let answer = match params.response {
            ProviderRequestAnswer::Question { answers } => {
                self.forget_question(session_id, &params.request_id);
                connection
                    .answer_held_request(
                        &params.request_id,
                        &CodexServerRequestAnswer::Answered { answers },
                    )
                    .await?;
                return Ok(());
            }
            ProviderRequestAnswer::Permission(answer) => answer,
        };
        let held = self.take_held(session_id, &params.request_id);
        connection
            .answer_held_request(&params.request_id, &compose_codex_answer(&answer))
            .await?;
        if let Some(held) = held
            && let Some(turn_id) = held.turn_id.clone()
            && let Some(steer) = self.compose_steer_after(session_id, &held, &answer)
        {
            steer_after_answer(inbound, session_id, held.run_id, turn_id, steer).await?;
        }
        let made_rule = match &answer {
            ProviderPermissionAnswer::Allow { made_rule, .. }
            | ProviderPermissionAnswer::Refuse { made_rule, .. } => made_rule.as_ref(),
        };
        if let Some(made_rule) = made_rule
            && made_rule.rule.kind == RememberedScopeKind::Project
        {
            let project_rules = &self.dependencies.project_rules;
            write_into_project_folders(
                &made_rule.project_folders,
                &made_rule.rule,
                |project_folder, rule| {
                    let project_rules = Arc::clone(project_rules);
                    async move { project_rules.write(project_folder, rule).await }.boxed()
                },
                |project_folder, rule| {
                    let project_rules = Arc::clone(project_rules);
                    async move { project_rules.remove(project_folder, rule).await }.boxed()
                },
                &[],
            )
            .await
            .map_err(|error| {
                DriverError::Internal(Box::new(ProviderRuleNotKeptError {
                    source: Box::new(error),
                }))
            })?;
        }
        Ok(())
    }

    /// Settles the card of an ask Codex resolved itself, or whose turn ended, before anyone
    /// answered it: an approval's on the approvals, a question's on the questions card. A failed
    /// withdrawal is reported under the session's `provider_account_id`.
    pub(crate) fn withdraw(
        &self,
        session_id: SessionId,
        provider_account_id: Option<ProviderAccountId>,
        request_id: &str,
        ask_kind: CodexAskKind,
    ) {
        match ask_kind {
            CodexAskKind::Approval => {
                self.take_held(session_id, request_id);
                self.withdraw_approval_card(session_id, provider_account_id, request_id.to_owned());
            }
            CodexAskKind::Question => {
                self.forget_question(session_id, request_id);
                self.withdraw_question_card(session_id, provider_account_id, request_id.to_owned());
            }
            CodexAskKind::CallbackTool => {}
        }
    }

    /// Forgets the approvals a closed session held, the corrections it waited on and its pending
    /// questions, each one's take told it was let go.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        let mut state = lock(&self.state);
        state.held_approvals.remove(&session_id);
        state.corrections.remove(&session_id);
        for question in state
            .pending_questions
            .remove(&session_id)
            .into_iter()
            .flat_map(HashMap::into_values)
        {
            question.let_go.cancel();
        }
    }

    /// Drops the corrections an ended turn's asks could have carried out, which no later turn may,
    /// and the questions it had pending, which Codex let go of with it, each one's take told so.
    pub(crate) fn forget_turn_corrections(&self, session_id: SessionId, turn_id: &str) {
        let mut state = lock(&self.state);
        remove_nested(&mut state.corrections, session_id, turn_id);
        let Some(pending) = state.pending_questions.get_mut(&session_id) else {
            return;
        };
        pending.retain(|_, question| {
            let is_of_turn = question.pending_on_turn.as_deref() == Some(turn_id);
            if is_of_turn {
                question.let_go.cancel();
            }
            !is_of_turn
        });
        if pending.is_empty() {
            state.pending_questions.remove(&session_id);
        }
    }

    // Reads what an approval would do and the card a corrected command or path carries out; a
    // command that would start a provider's background work is refused here.
    async fn read_approval(
        &self,
        record: &CodexSessionRecord,
        run_id: RunId,
        request: &CodexInboundServerRequest,
        params: &Map<String, Value>,
    ) -> Result<CodexHeldApproval, CodexServerRequestDecision> {
        let changed_paths = read_non_empty_string(params, "itemId")
            .and_then(|item_id| record.delivery.changed_paths_by_item_id.get(item_id))
            .cloned()
            .unwrap_or_default();
        let line_length = read_non_empty_string(params, "command").map_or(0, str::len);
        let method = request.method.method();
        let read_params = params.clone();
        // The tool server's call in flight is not tracked, so its approval names the server.
        let reading = self
            .dependencies
            .shell_lines
            .read(line_length, move |reader| {
                read_codex_ask_action(method, &read_params, &changed_paths, None, reader)
            })
            .await
            .expect("a shell-line read never panics, and a panic ends the daemon");
        if let Some(refusal) = reading.command_refusal {
            return Err(refuse(refusal.to_owned()));
        }
        Ok(CodexHeldApproval {
            turn_id: read_non_empty_string(params, "turnId").map(str::to_owned),
            run_id,
            action: reading.action,
            rule_scopes: reading.rule_scopes,
        })
    }

    // Holds an approval for the approval pipeline, naming the card an ask for a command or path a
    // person corrected and approved carries out, so the permission check answers it with no card.
    fn hand_approval(
        &self,
        record: &CodexSessionRecord,
        request: &CodexInboundServerRequest,
        params: Map<String, Value>,
        mut approval: CodexHeldApproval,
    ) -> CodexServerRequestDecision {
        let session_id = record.session_id;
        let correction_key = compose_correction_key(&approval.action);
        let correction_of = {
            let mut state = lock(&self.state);
            let corrections = approval
                .turn_id
                .as_deref()
                .and_then(|turn_id| state.corrections.get_mut(&session_id)?.get_mut(turn_id));
            correction_key
                .as_deref()
                .zip(corrections)
                .and_then(|(key, corrections)| corrections.remove(key))
        };
        let Some(port) = self.dependencies.owners.permission_asks.port().cloned() else {
            return CodexServerRequestDecision::Held { on_held: None };
        };
        let action = approval.action.clone();
        let rule_scopes = std::mem::take(&mut approval.rule_scopes);
        let run_id = approval.run_id;
        lock(&self.state)
            .held_approvals
            .entry(session_id)
            .or_default()
            .insert(request.request_id.clone(), approval);
        let tool_name = codex_approval_tool(request.method)
            .map(str::to_owned)
            .or_else(|| read_non_empty_string(&params, "serverName").map(str::to_owned))
            .unwrap_or_else(|| request.method.method().to_owned());
        let prompt = read_non_empty_string(&params, "reason")
            .or_else(|| read_non_empty_string(&params, "message"))
            .map(str::to_owned);
        let tool_call_id = read_non_empty_string(&params, "itemId").map(str::to_owned);
        let ask = ProviderPermissionAsk {
            session_id,
            run_id,
            request_id: request.request_id.clone(),
            tool_name,
            input: Value::Object(params),
            action,
            rule_scopes,
            is_provider_flagged: false,
            is_sent_by_level_rule: false,
            tool_call_id,
            prompt,
            correction_of,
        };
        let provider_account_id = record.provider_account_id.clone();
        let tasks = self.dependencies.tasks.clone();
        // Raised once the connection holds the ask, since an answer the daemon reaches at once
        // must find it held.
        let take_ask = move || {
            tasks.spawn(async move {
                if let Err(error) = port.take_ask(ask).await {
                    report_owner_failure(
                        provider_account_id,
                        CodexDeliveryPort::PermissionAsk,
                        session_id,
                        error,
                    );
                }
            });
        };
        CodexServerRequestDecision::Held {
            on_held: Some(Box::new(take_ask)),
        }
    }

    // Holds a question for the questions card, taken in its run's turn until Codex lets go of it,
    // which its take reads as its asker leaving: its own take withdraws it once its record is
    // written, and its card is withdrawn where it is let go, for a take that already ended. Codex
    // keeps one user-input question pending per turn, so a second there lets the first go.
    fn hand_question(
        &self,
        record: &CodexSessionRecord,
        run_id: RunId,
        request: &CodexInboundServerRequest,
        params: &Map<String, Value>,
    ) -> CodexServerRequestDecision {
        let session_id = record.session_id;
        let provider_account_id = record.provider_account_id.clone();
        let let_go = CancellationToken::new();
        let pending_on_turn = (request.method == CodexRoutedMethod::UserInputRequest)
            .then(|| read_non_empty_string(params, "turnId").map(str::to_owned))
            .flatten();
        let replaced = {
            let mut state = lock(&self.state);
            let pending = state.pending_questions.entry(session_id).or_default();
            let replaced = pending_on_turn.as_deref().and_then(|turn_id| {
                let replaced_id = pending
                    .iter()
                    .find(|(_, question)| question.pending_on_turn.as_deref() == Some(turn_id))
                    .map(|(request_id, _)| request_id.clone())?;
                pending
                    .remove(&replaced_id)
                    .map(|question| (replaced_id, question))
            });
            let question = PendingQuestion {
                pending_on_turn,
                let_go: let_go.clone(),
            };
            pending.insert(request.request_id.clone(), question);
            replaced
        };
        if let Some((replaced_id, replaced)) = replaced {
            replaced.let_go.cancel();
            if let Ok(connection) = record.service.connection() {
                connection.forget_held_request(&replaced_id);
            }
            self.withdraw_question_card(session_id, provider_account_id.clone(), replaced_id);
        }
        let Some(port) = self.dependencies.owners.questions.port().cloned() else {
            return CodexServerRequestDecision::Held { on_held: None };
        };
        let question = ProviderQuestion {
            session_id,
            run_id,
            request_id: request.request_id.clone(),
            questions: read_codex_question_prompts(request.method, &Value::Object(params.clone())),
            is_agent_waiting: true,
        };
        let tasks = self.dependencies.tasks.clone();
        // Asked while the run waits on something else, the question waits on the card for the
        // run; let go meanwhile, it is withdrawn.
        let take_question = move || {
            // Its place in its run's line is taken before its task runs.
            let place = QuestionLinePlace::line_up(question.run_id);
            tasks.spawn(async move {
                let taken = take_question_in_turn(
                    port.as_ref(),
                    question,
                    None,
                    place,
                    let_go.cancelled_owned(),
                )
                .await;
                if let Err(error) = taken {
                    report_owner_failure(
                        provider_account_id,
                        CodexDeliveryPort::Question,
                        session_id,
                        Box::new(error),
                    );
                }
            });
        };
        CodexServerRequestDecision::Held {
            on_held: Some(Box::new(take_question)),
        }
    }

    // The words a decline is followed by: its reason, or the corrected command or path, which
    // Codex's next ask for in the same turn then carries out on the card it was approved on.
    fn compose_steer_after(
        &self,
        session_id: SessionId,
        held: &CodexHeldApproval,
        answer: &ProviderPermissionAnswer,
    ) -> Option<String> {
        let correction = match answer {
            ProviderPermissionAnswer::Refuse { reason, .. } => {
                return reason.clone().filter(|reason| !reason.trim().is_empty());
            }
            ProviderPermissionAnswer::Allow { correction, .. } => correction.as_ref()?,
        };
        let is_command = matches!(held.action, ProviderAskAction::Command { .. });
        let corrected = if is_command {
            ProviderAskAction::Command {
                command: correction.edited_action.clone(),
            }
        } else {
            ProviderAskAction::FileChange {
                paths: vec![correction.edited_action.clone()],
            }
        };
        if let Some(turn_id) = &held.turn_id
            && let Some(key) = compose_correction_key(&corrected)
        {
            lock(&self.state)
                .corrections
                .entry(session_id)
                .or_default()
                .entry(turn_id.clone())
                .or_default()
                .insert(key, correction.approval_request_id);
        }
        Some(if is_command {
            format!(
                "The person changed this command before approving it. Run this instead: {}",
                correction.edited_action
            )
        } else {
            format!(
                "The person changed this path before approving it. Use this path instead: {}",
                correction.edited_action
            )
        })
    }

    fn take_held(&self, session_id: SessionId, request_id: &str) -> Option<CodexHeldApproval> {
        let mut state = lock(&self.state);
        let held = state.held_approvals.get_mut(&session_id)?;
        let approval = held.remove(request_id);
        if held.is_empty() {
            state.held_approvals.remove(&session_id);
        }
        approval
    }

    // Forgets a question Codex let go of, answered or withdrawn, its take told so.
    fn forget_question(&self, session_id: SessionId, request_id: &str) {
        let mut state = lock(&self.state);
        let Some(pending) = state.pending_questions.get_mut(&session_id) else {
            return;
        };
        if let Some(question) = pending.remove(request_id) {
            question.let_go.cancel();
        }
        if pending.is_empty() {
            state.pending_questions.remove(&session_id);
        }
    }

    fn withdraw_approval_card(
        &self,
        session_id: SessionId,
        provider_account_id: Option<ProviderAccountId>,
        request_id: String,
    ) {
        let Some(port) = self.dependencies.owners.permission_asks.port().cloned() else {
            return;
        };
        self.dependencies.tasks.spawn(async move {
            let withdrawal = ProviderPermissionAskWithdrawal {
                session_id,
                request_id,
            };
            if let Err(error) = port.withdraw_ask(withdrawal).await {
                report_owner_failure(
                    provider_account_id,
                    CodexDeliveryPort::PermissionAsk,
                    session_id,
                    error,
                );
            }
        });
    }

    fn withdraw_question_card(
        &self,
        session_id: SessionId,
        provider_account_id: Option<ProviderAccountId>,
        request_id: String,
    ) {
        let Some(port) = self.dependencies.owners.questions.port().cloned() else {
            return;
        };
        self.dependencies.tasks.spawn(async move {
            let withdrawal = ProviderQuestionWithdrawal {
                session_id,
                request_id,
            };
            if let Err(error) = port.withdraw_question(withdrawal).await {
                report_owner_failure(
                    provider_account_id,
                    CodexDeliveryPort::Question,
                    session_id,
                    error,
                );
            }
        });
    }
}

// Steers `text` into the turn `turn_id` of `run_id` after its ask was answered, registered on the
// session's task first. A turn that ended first is reported, since the decline already landed.
async fn steer_after_answer(
    inbound: &CodexSessionInboundSender,
    session_id: SessionId,
    run_id: RunId,
    turn_id: String,
    text: String,
) -> Result<(), DriverError> {
    let message_id =
        QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id");
    let input = async { Ok(vec![compose_codex_text_input(text)]) };
    let sent = steer_codex_run(inbound, run_id, Some(turn_id), message_id, input)
        .await
        .map(drop);
    match sent {
        Err(DriverError::SteerTurnEnded(ended)) => {
            report_owner_failure(
                None,
                CodexDeliveryPort::PermissionAsk,
                session_id,
                Box::new(ended),
            );
            Ok(())
        }
        sent => sent,
    }
}

/// The approval pipeline's answer as Codex's own decision: an allow a rule made or answered is
/// kept for the conversation, unless Codex could keep it only as a prefix that also lets a force
/// push through; a corrected one is a decline that the steer after it carries, and a refusal is a
/// decline.
fn compose_codex_answer(answer: &ProviderPermissionAnswer) -> CodexServerRequestAnswer {
    match answer {
        ProviderPermissionAnswer::Refuse { reason, .. } => CodexServerRequestAnswer::Refuse {
            reason: reason.clone().unwrap_or_default(),
        },
        ProviderPermissionAnswer::Allow {
            correction: Some(_),
            ..
        } => CodexServerRequestAnswer::Refuse {
            reason: String::new(),
        },
        ProviderPermissionAnswer::Allow {
            correction: None,
            made_rule,
            answered_by_rule,
        } => {
            let rule = made_rule
                .as_ref()
                .map(|made| &made.rule)
                .or(answered_by_rule.as_ref());
            CodexServerRequestAnswer::Allow {
                is_for_session: rule.is_some_and(|rule| !covers_destructive_git(rule)),
                payload: None,
            }
        }
    }
}

// What a corrected action is matched by when Codex asks for it again in the turn it was made in.
fn compose_correction_key(action: &ProviderAskAction) -> Option<String> {
    match action {
        ProviderAskAction::Command { command } => Some(format!("command\0{command}")),
        ProviderAskAction::FileChange { paths } => match paths.as_slice() {
            [path] => Some(format!("file_change\0{path}")),
            _ => None,
        },
        ProviderAskAction::CommandInput { .. }
        | ProviderAskAction::FileRead { .. }
        | ProviderAskAction::Network { .. }
        | ProviderAskAction::Tool { .. } => None,
    }
}

// The tool each built-in approval asks about, by its item type.
fn codex_approval_tool(method: CodexRoutedMethod) -> Option<&'static str> {
    match method {
        CodexRoutedMethod::CommandExecutionApproval | CodexRoutedMethod::ExecCommandApproval => {
            Some("commandExecution")
        }
        CodexRoutedMethod::FileChangeApproval | CodexRoutedMethod::ApplyPatchApproval => {
            Some("fileChange")
        }
        CodexRoutedMethod::PermissionsApproval => Some("permissions"),
        CodexRoutedMethod::ToolCall
        | CodexRoutedMethod::UserInputRequest
        | CodexRoutedMethod::ElicitationRequest => None,
    }
}

fn report_owner_failure(
    provider_account_id: Option<ProviderAccountId>,
    port: CodexDeliveryPort,
    session_id: SessionId,
    error: Box<dyn std::error::Error + Send + Sync>,
) {
    CodexTransportDiagnostic::PortDeliveryFailed {
        provider_account_id,
        port,
        session_id: Some(session_id),
        error,
    }
    .report();
}

fn refuse(reason: String) -> CodexServerRequestDecision {
    CodexServerRequestDecision::Answer(CodexServerRequestAnswer::Refuse { reason })
}

// The ask's params as an object; params that do not read as one refuse the ask with why.
fn read_params(request: &CodexInboundServerRequest) -> Result<Map<String, Value>, String> {
    let method = request.method.method();
    let params =
        serde_json::from_str::<Value>(&decode_inbound_json(request.params.get().as_bytes()))
            .map_err(|error| {
                format!("The provider's \"{method}\" request's params could not be read: {error}")
            })?;
    match params {
        Value::Object(members) => Ok(members),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => {
            Err(format!(
                "The provider's \"{method}\" request's params are not an object, so it is not \
                 asked."
            ))
        }
    }
}

fn remove_nested<Value>(
    by_session: &mut HashMap<SessionId, HashMap<String, Value>>,
    session_id: SessionId,
    turn_id: &str,
) {
    let Some(by_turn) = by_session.get_mut(&session_id) else {
        return;
    };
    by_turn.remove(turn_id);
    if by_turn.is_empty() {
        by_session.remove(&session_id);
    }
}
