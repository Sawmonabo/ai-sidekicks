//! The one gate every sensitive action passes before it runs: a provider's permission ask, a call
//! of the app's own tools, and a workflow start an agent asks for. Nothing is cached; each check
//! reads the rules, the level and the posture as they stand.
//!
//! - A provider ask is answered by the daemon where it has an answer, in this order: the answers
//!   the daemon gives itself (a provider's background work refused, an agent's own memory note
//!   allowed), a block in force, an ask the level's own rule sent, a correction carried out once,
//!   an allow in force where an allow may stand; else its card is raised. Its command line is read
//!   once, and that reading serves every step.
//! - A call of the app's own tools is gated by the session's level: refused when its run is not
//!   running, allowed at the levels that never ask, answered by the session rule over the tool the
//!   daemon keeps where one is in force, and else its card is raised, offering that rule. A
//!   provider's ask reads only the rules the providers keep, and a tool call only the daemon's.
//! - A workflow start is decided by the machine's workflow rules, under the asking run's posture.
//! - A workflow step's file write, tool call, command or program is gated by the run's level as its
//!   table has it, and where that asks, answered by the daemon's session rule over the words its
//!   rule names, where it names any, or else the daemon's own card. A command's line is read once
//!   for its category and those words.

use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalScope, ApprovalState, RememberedRuleSense,
};
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_TOOL_NAME_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use sidekicks_policy::authorizer::{Authorizer, PolicyDecision};
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_policy::workflow_start::{WorkflowStart, check_workflow_start};
use sidekicks_provider::background_work::{BackgroundWorkForms, refuse_background_work};
use sidekicks_provider::callback_tools::host::{
    CallbackToolApprovalBasis, CallbackToolApprovalOutcome,
};
use sidekicks_provider::driver::callback_tool::CallbackToolInvocation;
use sidekicks_provider::port::permission_ask::{ProviderAskAction, ProviderPermissionAsk};
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_session::permission_level::read_session_permission_level;
use sidekicks_session::run::agent::{RunAgentReadError, RunAgentReader};
use sidekicks_std::text_cut::cut_to_code_points;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::canonicalizer::digest_canonical_json;
use sidekicks_store::machine::registry::{MachineRegistry, MachineRegistryReadError};
use sidekicks_workflow::runs::step_action::StepActionCheck;
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;

use self::step_action::{StepActionAsk, StepGate};
use crate::ask_description::{
    AskDescriptionError, ProviderAskDescription, bounded_wire_text, derive_rule_subject,
    describe_provider_ask, may_allow_stand, may_allow_stand_over, read_command_line,
};
use crate::callback_tool_approvals::decided_outcome;
use crate::provider_ask_answers::{ProviderAskAnswer, answer_provider_ask};
use crate::request_create::{
    ApprovalRequestCreateRequest, ApprovalRequestOrigin, ApprovalResourceDescriptor, ToolServerTool,
};
use crate::rules::{ApprovalRuleError, ApprovalRules};
use crate::service::{ApprovalService, ApprovalServiceError, RaisedCard};
use crate::store::StoredApprovalRequest;

// A tool's name stands within a card's scope, so a tool call's card always reads it.
const _: () = assert!(PROVIDER_TOOL_NAME_MAX_LEN <= FILE_PATH_MAX_LEN);

/// What the agent reads when a block in force on the session refused its call.
pub(crate) const BLOCKED_BY_RULE_REFUSAL: &str = "A rule in force on this session blocks this.";

/// What the agent reads when its run is not running, so no level gates its call.
pub(crate) const NO_LEVEL_REFUSAL: &str = "This call's run is not running, so it did not run.";

/// What the step reads when its action shows nothing on a card.
pub(crate) const UNNAMED_ACTION_REFUSAL: &str =
    "This action names nothing to approve, so it did not run.";

/// What the agent reads when the machine's workflow rules refuse its start.
pub(crate) const WORKFLOW_START_REFUSAL: &str =
    "The workflow rules on this machine refuse this start.";

/// How the check settled a provider ask.
pub(crate) enum ProviderAskVerdict {
    /// The daemon allows it with no card: a policy's allow, an ask the level's own rule sent, or a
    /// correction carried out.
    Allowed,
    /// An allow in force on its subject answers it.
    AnsweredByRule(ProviderAskRule),
    /// The daemon refuses it with no card.
    Denied {
        /// What the agent reads.
        refusal: &'static str,
    },
    /// Its card was raised and waits for the person.
    CardRaised(RaisedCard),
}

/// How the check settled an action the daemon raises its own card for, a call of the app's own
/// tools or a workflow step's action: settled at once, or waiting on its card.
pub(crate) enum ToolCallVerdict {
    /// Allowed or refused with no card.
    Settled(CallbackToolApprovalOutcome),
    /// Its card was raised and waits for the person.
    CardRaised(RaisedCard),
}

/// How the check settled a workflow start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkflowStartVerdict {
    /// The start may begin.
    Allowed,
    /// The start is refused.
    Denied {
        /// What the agent reads.
        refusal: &'static str,
    },
}

/// Why a check could not decide; the action does not proceed.
#[derive(Debug, thiserror::Error)]
pub enum PermissionCheckError {
    /// The provider took the ask back before its card was raised.
    #[error("the provider took the ask back before its card was raised")]
    Withdrawn,
    /// The ask's command line was not read.
    #[error("the ask's command line was not read")]
    LineReading(#[from] JoinError),
    /// A path an answer of the daemon's own reads could not be resolved.
    #[error("a path the ask names could not be resolved")]
    Path(#[from] io::Error),
    /// The rules in force could not be read.
    #[error(transparent)]
    Rule(#[from] ApprovalRuleError),
    /// The card, or a correction's one use, could not be recorded.
    #[error(transparent)]
    Approval(#[from] ApprovalServiceError),
    /// The ask could not be described for its card.
    #[error(transparent)]
    Description(#[from] AskDescriptionError),
    /// SQLite refused a read.
    #[error("a read of the session failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The agent the run is for could not be read.
    #[error(transparent)]
    Agent(#[from] RunAgentReadError),
    /// The machine's owner could not be read.
    #[error(transparent)]
    Owner(#[from] MachineRegistryReadError),
}

/// What the check reads and raises cards through.
pub struct PermissionCheckDeps {
    /// Where the session's level and a run's agent are read.
    pub reads: Arc<DatabaseReadPool>,
    /// Where cards are raised and corrections taken.
    pub approvals: Arc<ApprovalService>,
    /// The rules in force.
    pub rules: Arc<ApprovalRules>,
    /// The daemon-wide bound an ask's command line is read under.
    pub shell_lines: Arc<ShellLineReadingBound>,
    /// Every provider's background work, which no ask's command line may start.
    pub background_work: Arc<BackgroundWorkForms>,
    /// Each live run's posture.
    pub postures: Arc<ExecutionPostureService>,
    /// The machine whose owner a workflow start decides as.
    pub machine: Arc<MachineRegistry>,
    /// The machine's workflow rules.
    pub authorizer: Arc<Authorizer>,
    /// The one all-projects agent-memory folder.
    pub agent_memory_folder: PathBuf,
}

/// The one gate every sensitive action passes; shared by `Arc`.
pub struct PermissionCheck {
    deps: PermissionCheckDeps,
}

// One ask the daemon raises its own card for, on the session and run the card names.
struct DaemonCardAsk {
    session_id: SessionId,
    run_id: RunId,
    category: ApprovalCategory,
    action: ProviderAskAction,
    // The words the card shows.
    card_words: String,
    // The words a rule over the action names, which the card offers where the wire carries them
    // whole and an allow may stand; `None` where no rule may name the action.
    rule_subject: Option<String>,
    // The tool server's tool a step's call names, on which a rule over it keys beside its words.
    tool_server_tool: Option<ToolServerTool>,
    // Who asks on the card; `None` reads the run's own agent.
    requested_by: Option<NonEmptyText>,
    tool_call_id: Option<ToolCallId>,
    // The digest of the call's tool name and input; `None` for an action that holds no call.
    input_digest: Option<Sha256Hex>,
}

// What one read of an ask's command line answers, for every step that reads it.
struct AskReading {
    command_refusal: Option<&'static str>,
    subject: Option<String>,
    may_allow_stand: bool,
    description: Result<ProviderAskDescription, AskDescriptionError>,
}

impl PermissionCheck {
    /// The check over `deps`.
    pub fn new(deps: PermissionCheckDeps) -> Self {
        Self { deps }
    }

    /// Decides one provider ask, raising its card under `ask_id` where no answer settles it.
    /// Fails with [`PermissionCheckError::Withdrawn`] once `withdrawal` is canceled before a
    /// correction is spent or a card raised; with `approval.requestCanceled` when its run or
    /// session has ended; with `approval.persistenceUnavailable` when the card or a correction's
    /// use could not be recorded; and as a read or a path fails.
    pub(crate) async fn check_provider_ask(
        &self,
        ask: &ProviderPermissionAsk,
        ask_id: &NonEmptyText,
        withdrawal: &CancellationToken,
    ) -> Result<ProviderAskVerdict, PermissionCheckError> {
        let read_ask = ask.clone();
        let background_work = Arc::clone(&self.deps.background_work);
        let reading =
            read_command_line(&self.deps.shell_lines, &ask.action, move |reader, line| {
                AskReading {
                    command_refusal: line
                        .and_then(|line| refuse_background_work(&background_work, reader, line)),
                    subject: derive_rule_subject(line, &read_ask.action),
                    may_allow_stand: may_allow_stand(reader, line, &read_ask),
                    description: describe_provider_ask(reader, line, &read_ask),
                }
            })
            .await?;
        let designed = answer_provider_ask(
            &ask.action,
            reading.command_refusal,
            &self.deps.agent_memory_folder,
        )
        .await?;
        match designed {
            Some(ProviderAskAnswer::Allow) => return Ok(ProviderAskVerdict::Allowed),
            Some(ProviderAskAnswer::Deny { reason }) => {
                return Ok(ProviderAskVerdict::Denied { refusal: reason });
            }
            None => {}
        }
        let rule = match &reading.subject {
            Some(subject) => {
                self.deps
                    .rules
                    .find_rule(
                        ask.session_id,
                        ProviderAskActionKind::from(&ask.action),
                        subject,
                        None,
                        false,
                    )
                    .await?
            }
            None => None,
        };
        if rule
            .as_ref()
            .is_some_and(|rule| rule.sense == RememberedRuleSense::Block)
        {
            return Ok(ProviderAskVerdict::Denied {
                refusal: BLOCKED_BY_RULE_REFUSAL,
            });
        }
        if ask.is_sent_by_level_rule {
            return Ok(ProviderAskVerdict::Allowed);
        }
        if let (Some(approval_request_id), Some(corrected_subject)) =
            (ask.correction_of, ask.action.corrected_subject())
        {
            // A taken-back ask never spends the one use.
            refuse_withdrawn(withdrawal)?;
            if self
                .deps
                .approvals
                .take_correction(approval_request_id, ask.run_id, corrected_subject)
                .await?
            {
                return Ok(ProviderAskVerdict::Allowed);
            }
        }
        if let Some(rule) = rule
            && reading.may_allow_stand
        {
            return Ok(ProviderAskVerdict::AnsweredByRule(rule));
        }
        refuse_withdrawn(withdrawal)?;
        let description = reading.description?;
        let card = self
            .deps
            .approvals
            .create(
                ApprovalRequestCreateRequest {
                    session_id: ask.session_id,
                    run_id: ask.run_id,
                    requested_by: self.read_run_agent(ask.session_id, ask.run_id).await?,
                    category: description.category,
                    scope: description.scope,
                    resource_descriptor: description.resource_descriptor,
                },
                ApprovalRequestOrigin {
                    ask_id: Some(ask_id.clone()),
                    tool_call_id: card_tool_call_id(ask),
                    input_digest: card_input_digest(ask),
                },
            )
            .await?;
        Ok(ProviderAskVerdict::CardRaised(card))
    }

    /// Decides one call of the app's own tools by the session's level: refused when its run is
    /// not running, allowed at a level that never asks, answered by the session rule over the tool
    /// the daemon keeps where one is in force, and else its card is raised, offering that rule.
    /// Fails as a read fails and as the card's create does.
    pub(crate) async fn check_tool_call(
        &self,
        invocation: &CallbackToolInvocation,
    ) -> Result<ToolCallVerdict, PermissionCheckError> {
        let session_id = invocation.session_id;
        if self
            .deps
            .postures
            .resolved_posture_for(&invocation.run_id)
            .is_none()
        {
            return Ok(ToolCallVerdict::Settled(
                CallbackToolApprovalOutcome::Deny {
                    basis: CallbackToolApprovalBasis::Policy,
                    reason: NO_LEVEL_REFUSAL.to_owned(),
                },
            ));
        }
        let level = self
            .deps
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, PermissionCheckError>(read_session_permission_level(
                    connection,
                    &session_id,
                )?)
            })
            .await?;
        match level {
            PermissionLevel::Sandboxed | PermissionLevel::Yolo => {
                return Ok(ToolCallVerdict::Settled(
                    CallbackToolApprovalOutcome::Allow {
                        basis: CallbackToolApprovalBasis::Policy,
                    },
                ));
            }
            PermissionLevel::Readonly | PermissionLevel::Ask | PermissionLevel::Reviewed => {}
        }
        let tool_name = invocation.tool_name.as_str();
        self.ask_by_daemon_card(DaemonCardAsk {
            session_id,
            run_id: invocation.run_id,
            category: ApprovalCategory::ToolExecution,
            action: ProviderAskAction::Tool {
                tool_name: tool_name.to_owned(),
            },
            card_words: tool_name.to_owned(),
            rule_subject: Some(tool_name.to_owned()),
            tool_server_tool: None,
            requested_by: None,
            tool_call_id: Some(invocation.tool_call_id.clone()),
            input_digest: digest_call_input(tool_name, Value::Object(invocation.arguments.clone())),
        })
        .await
    }

    /// Decides one action of a workflow step the daemon runs itself, as `check` names it: a command
    /// that starts a provider's background work refused at every level, else free or refused as the
    /// run's level's table has it, else answered by the session rule over its subject the daemon
    /// keeps where one is in force, and else its card is raised on the check's session and run,
    /// asked by its `requested_by`, offering that rule where one may stand. A command's line is
    /// read once for the refusal, its category and its rule's words. Fails as a read fails, the
    /// line's read among them, and as the card's create does.
    pub(crate) async fn check_step_action(
        &self,
        check: StepActionCheck,
    ) -> Result<ToolCallVerdict, PermissionCheckError> {
        let action = &check.action;
        let reading = action
            .read(&self.deps.shell_lines, &self.deps.background_work)
            .await?;
        if let Some(refusal) = reading.background_work_refusal {
            return Ok(ToolCallVerdict::Settled(
                CallbackToolApprovalOutcome::Deny {
                    basis: CallbackToolApprovalBasis::Policy,
                    reason: refusal.to_owned(),
                },
            ));
        }
        match action.gate_at(check.level) {
            StepGate::Free => Ok(ToolCallVerdict::Settled(
                CallbackToolApprovalOutcome::Allow {
                    basis: CallbackToolApprovalBasis::Policy,
                },
            )),
            StepGate::Refused { refusal } => Ok(ToolCallVerdict::Settled(
                CallbackToolApprovalOutcome::Deny {
                    basis: CallbackToolApprovalBasis::Policy,
                    reason: refusal.to_owned(),
                },
            )),
            StepGate::Card => {
                self.ask_by_daemon_card(DaemonCardAsk {
                    session_id: check.session_id,
                    run_id: check.run_id,
                    category: reading.category,
                    action: action.ask_action(),
                    card_words: action.subject(),
                    rule_subject: reading.rule_subject,
                    tool_server_tool: action.tool_server_tool(),
                    requested_by: Some(check.requested_by.clone()),
                    tool_call_id: None,
                    input_digest: None,
                })
                .await
            }
        }
    }

    // The daemon's own card over `ask`, answered first by the session rule the daemon keeps over
    // its rule's words, where it names any: a block always, an allow only where one may stand; then
    // by the card a call made again returns to. A rule's words the wire bound had to cut offer no
    // rule, since they no longer name exactly what the rule would cover, and blank card words are
    // refused, since they show nothing.
    async fn ask_by_daemon_card(
        &self,
        ask: DaemonCardAsk,
    ) -> Result<ToolCallVerdict, PermissionCheckError> {
        let rule = match &ask.rule_subject {
            Some(rule_subject) => {
                self.deps
                    .rules
                    .find_rule(
                        ask.session_id,
                        ProviderAskActionKind::from(&ask.action),
                        rule_subject,
                        ask.tool_server_tool.as_ref(),
                        true,
                    )
                    .await?
            }
            None => None,
        };
        let may_allow_stand = may_allow_stand_over(ask.category, ask.rule_subject.as_deref());
        let basis = CallbackToolApprovalBasis::RememberedRule;
        match rule.map(|rule| rule.sense) {
            Some(RememberedRuleSense::Block) => {
                return Ok(ToolCallVerdict::Settled(
                    CallbackToolApprovalOutcome::Deny {
                        basis,
                        reason: BLOCKED_BY_RULE_REFUSAL.to_owned(),
                    },
                ));
            }
            Some(RememberedRuleSense::Allow) if may_allow_stand => {
                return Ok(ToolCallVerdict::Settled(
                    CallbackToolApprovalOutcome::Allow { basis },
                ));
            }
            Some(RememberedRuleSense::Allow) | None => {}
        }
        if let Some(verdict) = self.return_to_daemon_card(&ask).await? {
            return Ok(verdict);
        }
        let Some(scope) = bounded_wire_text(&ask.card_words) else {
            return Ok(ToolCallVerdict::Settled(
                CallbackToolApprovalOutcome::Deny {
                    basis: CallbackToolApprovalBasis::Policy,
                    reason: UNNAMED_ACTION_REFUSAL.to_owned(),
                },
            ));
        };
        let rule_words = ask.rule_subject.as_deref().and_then(bounded_wire_text);
        let standing_allow_offered = may_allow_stand
            && rule_words.as_ref().map(ApprovalScope::as_str) == ask.rule_subject.as_deref();
        let tool_name = match &ask.action {
            ProviderAskAction::Tool { tool_name } => NonEmptyText::new(tool_name.clone()),
            ProviderAskAction::Command { .. }
            | ProviderAskAction::CommandInput { .. }
            | ProviderAskAction::FileChange { .. }
            | ProviderAskAction::FileRead { .. }
            | ProviderAskAction::Network { .. } => None,
        };
        let requested_by = match ask.requested_by {
            Some(requested_by) => requested_by,
            None => self.read_run_agent(ask.session_id, ask.run_id).await?,
        };
        let card = self
            .deps
            .approvals
            .create(
                ApprovalRequestCreateRequest {
                    session_id: ask.session_id,
                    run_id: ask.run_id,
                    requested_by,
                    category: ask.category,
                    scope: scope.clone(),
                    resource_descriptor: ApprovalResourceDescriptor {
                        subject: rule_words.unwrap_or(scope),
                        standing_allow_offered,
                        project_scope_offered: false,
                        editable: false,
                        action: Some(ask.action),
                        tool_name,
                        tool_server_tool: ask.tool_server_tool,
                        prompt: None,
                    },
                },
                ApprovalRequestOrigin {
                    ask_id: None,
                    tool_call_id: ask.tool_call_id,
                    input_digest: ask.input_digest,
                },
            )
            .await?;
        Ok(ToolCallVerdict::CardRaised(card))
    }

    // The daemon's card of the same run, action and call a call made again after its wait was let
    // go returns to, found by its tool call or else its input: a pending one no one waits on, whose
    // settlement the call then waits for, or an answered one whose orphaned answer it claims and
    // settles by. A card answered or canceled between the arm and the read, its answer not kept for
    // this call, leaves the call to the wait the answer settled, or, canceled, to a card of its
    // own; `None` where no card is left to return to.
    async fn return_to_daemon_card(
        &self,
        ask: &DaemonCardAsk,
    ) -> Result<Option<ToolCallVerdict>, PermissionCheckError> {
        if ask.tool_call_id.is_none() && ask.input_digest.is_none() {
            return Ok(None);
        }
        let approvals = &self.deps.approvals;
        let is_same_call = |card: &StoredApprovalRequest| {
            card.ask_id.is_none() && card.resource_descriptor.action.as_ref() == Some(&ask.action)
        };
        let pending = approvals
            .read_pending_call_requests(
                ask.run_id,
                ask.tool_call_id.clone(),
                ask.input_digest.clone(),
            )
            .await?;
        let unawaited = pending.into_iter().filter(is_same_call).find_map(|card| {
            approvals
                .arm_unawaited_card(ask.run_id, card.approval_request_id)
                .map(|settled| (card.approval_request_id, settled))
        });
        if let Some((approval_request_id, settled)) = unawaited {
            let read_back = approvals.read_request(approval_request_id).await?;
            let is_canceled = read_back
                .as_ref()
                .is_none_or(|card| card.state == ApprovalState::Canceled);
            if !is_canceled {
                if let Some(resolution) = read_back.and_then(|card| card.resolution)
                    && approvals
                        .orphaned_answers()
                        .claim_call(approval_request_id)
                        .await?
                {
                    return Ok(Some(ToolCallVerdict::Settled(decided_outcome(
                        resolution.decision,
                        resolution.decline_reason,
                    ))));
                }
                return Ok(Some(ToolCallVerdict::CardRaised(RaisedCard {
                    approval_request_id,
                    settled,
                })));
            }
        }
        let Some(input_digest) = ask.input_digest.clone() else {
            return Ok(None);
        };
        let orphaned_answers = approvals.orphaned_answers();
        for card in orphaned_answers
            .read_call_requests(ask.run_id, input_digest)
            .await?
        {
            if is_same_call(&card)
                && orphaned_answers
                    .claim_call(card.approval_request_id)
                    .await?
            {
                let resolution = card
                    .resolution
                    .expect("a card whose answer was kept holds its answer");
                return Ok(Some(ToolCallVerdict::Settled(decided_outcome(
                    resolution.decision,
                    resolution.decline_reason,
                ))));
            }
        }
        Ok(None)
    }

    /// Decides one workflow start an agent's tool asks for under the machine's workflow rules, as
    /// its owner, under the posture of `asking_run_id`, the run whose agent asked. Refused when the
    /// asking run is not running. Fails when the owner cannot be read.
    pub(crate) async fn check_workflow_start(
        &self,
        workflow_id: &WorkflowDefinitionId,
        asking_run_id: RunId,
    ) -> Result<WorkflowStartVerdict, PermissionCheckError> {
        let Some(posture) = self.deps.postures.resolved_posture_for(&asking_run_id) else {
            return Ok(WorkflowStartVerdict::Denied {
                refusal: NO_LEVEL_REFUSAL,
            });
        };
        let owner = self.deps.machine.read_owner().await?;
        let decision = check_workflow_start(
            &self.deps.authorizer,
            WorkflowStart {
                owner: owner.as_ref(),
                workflow_id,
                posture: Some(&posture),
            },
        );
        Ok(match decision {
            PolicyDecision::Allow => WorkflowStartVerdict::Allowed,
            PolicyDecision::Deny { errors } => {
                if !errors.is_empty() {
                    tracing::warn!(?errors, "workflow_start_refused_with_errors");
                }
                WorkflowStartVerdict::Denied {
                    refusal: WORKFLOW_START_REFUSAL,
                }
            }
        })
    }

    // The agent the run is for, which asks on its card.
    async fn read_run_agent(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<NonEmptyText, PermissionCheckError> {
        let agent_id = self
            .deps
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, PermissionCheckError>(
                    RunAgentReader::new(connection).read_agent(&session_id, &run_id)?,
                )
            })
            .await?;
        Ok(NonEmptyText::new(agent_id.text().as_str().to_owned())
            .expect("an agent's id is a UUID, never empty"))
    }
}

/// The id of the tool call `ask` holds as its card keeps it, where its provider named one: cut as
/// Codex's tool rows cut their call ids, so the held call's row draws its mark; Claude Code draws
/// no row for an id past the bound.
pub(crate) fn card_tool_call_id(ask: &ProviderPermissionAsk) -> Option<ToolCallId> {
    ask.tool_call_id.as_deref().and_then(|id| {
        ToolCallId::new(cut_to_code_points(id, PROVIDER_WIRE_HANDLE_MAX_LEN).to_owned()).ok()
    })
}

/// The digest of the tool name and input of the call `ask` holds, by which a call made again
/// after a restart finds its card; `None` where the input has no canonical form.
pub(crate) fn card_input_digest(ask: &ProviderPermissionAsk) -> Option<Sha256Hex> {
    digest_call_input(&ask.tool_name, ask.input.clone())
}

// The SHA-256 of `{"input": …, "toolName": …}` as canonical JSON. The tool name is folded in
// since a card keeps it only for a tool action. An input with no canonical form, one nested too
// deep, gives no digest, so its card is found by its tool call id alone.
fn digest_call_input(tool_name: &str, input: Value) -> Option<Sha256Hex> {
    let call = Map::from_iter([
        ("input".to_owned(), input),
        ("toolName".to_owned(), Value::String(tool_name.to_owned())),
    ]);
    digest_canonical_json(&Value::Object(call))
        .inspect_err(|refusal| {
            tracing::warn!(
                error = refusal as &(dyn Error + 'static),
                "approval_call_input_not_digested"
            );
        })
        .ok()
}

fn refuse_withdrawn(withdrawal: &CancellationToken) -> Result<(), PermissionCheckError> {
    if withdrawal.is_cancelled() {
        Err(PermissionCheckError::Withdrawn)
    } else {
        Ok(())
    }
}

pub(crate) mod step_action;
#[cfg(any(test, feature = "test-support"))]
pub mod test_fixture;
#[cfg(test)]
pub(crate) mod tests;
