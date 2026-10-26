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

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::approval::{ApprovalCategory, ApprovalScope, RememberedRuleSense};
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_TOOL_NAME_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;

use crate::approvals::ask_description::{
    AskDescriptionError, ProviderAskDescription, derive_rule_subject, describe_provider_ask,
    may_allow_stand, read_command_line,
};
use crate::approvals::request_create::{
    ApprovalRequestCreateRequest, ApprovalRequestOrigin, ApprovalResourceDescriptor,
};
use crate::approvals::rules::{ApprovalRuleError, ApprovalRules};
use crate::approvals::service::{ApprovalService, ApprovalServiceError, RaisedCard};
use crate::daemon::machine::registry::{MachineRegistry, MachineRegistryReadError};
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::policy::authorizer::{Authorizer, PolicyDecision};
use crate::policy::background_work::{BackgroundWorkForms, refuse_background_work};
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::policy::provider_ask_answers::{ProviderAskAnswer, answer_provider_ask};
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::policy::workflow_start::{WorkflowStart, check_workflow_start};
use crate::provider::callback_tools::host::{
    CallbackToolApprovalBasis, CallbackToolApprovalOutcome,
};
use crate::provider::driver::callback_tool::CallbackToolInvocation;
use crate::provider::port::permission_ask::{
    ProviderAskAction, ProviderAskActionKind, ProviderAskRule, ProviderPermissionAsk,
};
use crate::session::permission_level::read_session_permission_level;
use crate::session::run::agent::{RunAgentReadError, RunAgentReader};
use crate::text_cut::cut_to_code_points;

// A tool's name stands within a card's scope, so a tool call's card always reads it.
const _: () = assert!(PROVIDER_TOOL_NAME_MAX_LEN <= FILE_PATH_MAX_LEN);

/// What the agent reads when a block in force on the session refused its call.
pub(crate) const BLOCKED_BY_RULE_REFUSAL: &str = "A rule in force on this session blocks this.";

/// What the agent reads when its run is not running, so no level gates its call.
pub(crate) const NO_LEVEL_REFUSAL: &str = "This call's run is not running, so it did not run.";

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

/// How the check settled a call of the app's own tools: settled at once, or waiting on its card.
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
pub(crate) enum PermissionCheckError {
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
pub(crate) struct PermissionCheckDeps {
    /// Where the session's level and a run's agent are read.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// Where cards are raised and corrections taken.
    pub(crate) approvals: Arc<ApprovalService>,
    /// The rules in force.
    pub(crate) rules: Arc<ApprovalRules>,
    /// The daemon-wide bound an ask's command line is read under.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// Every provider's background work, which no ask's command line may start.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// Each live run's posture.
    pub(crate) postures: Arc<ExecutionPostureService>,
    /// The machine whose owner a workflow start decides as.
    pub(crate) machine: Arc<MachineRegistry>,
    /// The machine's workflow rules.
    pub(crate) authorizer: Arc<Authorizer>,
    /// The one all-projects agent-memory folder.
    pub(crate) agent_memory_folder: PathBuf,
}

/// The one gate every sensitive action passes; shared by `Arc`.
pub(crate) struct PermissionCheck {
    deps: PermissionCheckDeps,
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
    pub(crate) fn new(deps: PermissionCheckDeps) -> Self {
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
                    subject: derive_rule_subject(reader, line, &read_ask.action),
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
                    // Cut as Codex's tool rows cut their call ids, so the held call's row draws its
                    // mark; Claude Code draws no row for an id past the bound.
                    tool_call_id: ask.tool_call_id.as_deref().and_then(|id| {
                        ToolCallId::new(
                            cut_to_code_points(id, PROVIDER_WIRE_HANDLE_MAX_LEN).to_owned(),
                        )
                        .ok()
                    }),
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
        let rule = self
            .deps
            .rules
            .find_rule(session_id, ProviderAskActionKind::Tool, tool_name, true)
            .await?;
        if let Some(rule) = rule {
            let basis = CallbackToolApprovalBasis::RememberedRule;
            return Ok(ToolCallVerdict::Settled(match rule.sense {
                RememberedRuleSense::Allow => CallbackToolApprovalOutcome::Allow { basis },
                RememberedRuleSense::Block => CallbackToolApprovalOutcome::Deny {
                    basis,
                    reason: BLOCKED_BY_RULE_REFUSAL.to_owned(),
                },
            }));
        }
        let scope = ApprovalScope::new(tool_name.to_owned())
            .expect("a tool's name, under its own cap, stands within a scope's");
        let named_tool = NonEmptyText::new(tool_name.to_owned());
        let card = self
            .deps
            .approvals
            .create(
                ApprovalRequestCreateRequest {
                    session_id,
                    run_id: invocation.run_id,
                    requested_by: self.read_run_agent(session_id, invocation.run_id).await?,
                    category: ApprovalCategory::ToolExecution,
                    scope: scope.clone(),
                    resource_descriptor: ApprovalResourceDescriptor {
                        subject: scope,
                        standing_allow_offered: named_tool.is_some(),
                        project_scope_offered: false,
                        editable: false,
                        action: Some(ProviderAskAction::Tool {
                            tool_name: tool_name.to_owned(),
                        }),
                        tool_name: named_tool,
                        prompt: None,
                    },
                },
                ApprovalRequestOrigin {
                    ask_id: None,
                    tool_call_id: Some(invocation.tool_call_id.clone()),
                },
            )
            .await?;
        Ok(ToolCallVerdict::CardRaised(card))
    }

    /// Decides one workflow start under the machine's workflow rules, as its owner, under the
    /// posture of `asking_run_id`, the run whose agent asked, or none for a trigger's. Refused when
    /// the asking run is not running. Fails when the owner cannot be read.
    pub(crate) async fn check_workflow_start(
        &self,
        workflow_id: &WorkflowDefinitionId,
        asking_run_id: Option<RunId>,
    ) -> Result<WorkflowStartVerdict, PermissionCheckError> {
        let posture =
            asking_run_id.and_then(|run_id| self.deps.postures.resolved_posture_for(&run_id));
        if asking_run_id.is_some() && posture.is_none() {
            return Ok(WorkflowStartVerdict::Denied {
                refusal: NO_LEVEL_REFUSAL,
            });
        }
        let owner = self.deps.machine.read_owner().await?;
        let decision = check_workflow_start(
            &self.deps.authorizer,
            WorkflowStart {
                owner: owner.as_ref(),
                workflow_id,
                posture: posture.as_ref(),
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

fn refuse_withdrawn(withdrawal: &CancellationToken) -> Result<(), PermissionCheckError> {
    if withdrawal.is_cancelled() {
        Err(PermissionCheckError::Withdrawn)
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests;
