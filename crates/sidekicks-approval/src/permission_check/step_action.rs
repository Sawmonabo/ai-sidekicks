//! What a workflow step the daemon runs itself asks of the run's level before it acts.
//!
//! - A file write follows the session levels' own table: inside the step's checkout it asks only at
//!   Read-only; outside it asks at Read-only, Ask and Reviewed, is refused at Sandboxed and is free
//!   at YOLO. Sandboxed also keeps the repository's hooks and config closed.
//! - A tool server's tool follows the decision Codex itself makes for the binding's approval mode,
//!   reading no annotations: `approve` runs at every level, and every other mode asks at each
//!   level but Sandboxed, which never asks and so refuses it.
//! - A command and a program with host access ask at Read-only, Ask and Reviewed, since no
//!   provider's reviewer sees a step the daemon runs, and run free at Sandboxed, inside the
//!   provider's own sandbox, and at YOLO. A command's rule is read from its line as a provider's
//!   command ask's is; a program's launch line names no rule.

use sidekicks_contracts::approval::ApprovalCategory;
use sidekicks_contracts::mcp::server::McpApprovalMode;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::mcp::tool_name::compose_tool_server_tool_name;
use sidekicks_provider::port::permission_ask::ProviderAskAction;
use sidekicks_workflow::runs::step_action::StepAction;
use tokio::task::JoinError;

use crate::ask_description::{category_of, derive_rule_subject, read_command_line};
use crate::request_create::ToolServerTool;

/// What the failed step reads when Sandboxed refuses a write outside the step's checkout.
pub(crate) const OUTSIDE_CHECKOUT_REFUSAL: &str =
    "This write is outside the step's checkout, which Sandboxed keeps closed.";

/// What the failed step reads when Sandboxed refuses a write to the repository's hooks or config.
pub(crate) const GIT_FOLDER_REFUSAL: &str =
    "This write reaches the repository's hooks or config, which Sandboxed keeps closed.";

/// What the failed step reads when Sandboxed refuses a tool whose approval mode asks.
pub(crate) const ASKING_TOOL_REFUSAL: &str =
    "This tool asks before it runs, and Sandboxed never asks, so it did not run.";

/// What the run's level asks of a step action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StepGate {
    /// It runs without asking.
    Free,
    /// It waits on the daemon's own card.
    Card,
    /// It is refused.
    Refused {
        /// What the failed step reads.
        refusal: &'static str,
    },
}

/// What a step action's card is about and the words a session rule over it names.
#[derive(Debug)]
pub(crate) struct StepActionReading {
    /// What the card is about.
    pub(crate) category: ApprovalCategory,
    /// The words a session rule over the action names, `None` where no rule may name it.
    pub(crate) rule_subject: Option<String>,
}

/// How the daemon reads a step action for its gate, its card and the session rule over it.
pub(crate) trait StepActionAsk {
    /// What `level` asks of this action.
    fn gate_at(&self, level: PermissionLevel) -> StepGate;

    /// The words the card names: the written file's path, the tool's server-qualified name, the
    /// command line, or the program's launch line.
    fn subject(&self) -> String;

    /// The server and the tool a tool call names, apart, which a session rule over it keys on so
    /// an allow for one server's tool never covers another server's tool; `None` for a write.
    fn tool_server_tool(&self) -> Option<ToolServerTool>;

    /// The action as the card shows it and a session rule names its kind.
    fn ask_action(&self) -> ProviderAskAction;

    /// What the card is about and the rule's words: a command's line is read once under
    /// `shell_lines` for both, and a program names no rule. Fails when the line's read panics.
    async fn read(
        &self,
        shell_lines: &ShellLineReadingBound,
    ) -> Result<StepActionReading, JoinError>;
}

impl StepActionAsk for StepAction {
    fn gate_at(&self, level: PermissionLevel) -> StepGate {
        match self {
            Self::FileWrite {
                target,
                checkout_root,
                git_folder,
            } => {
                let is_inside = target.starts_with(checkout_root);
                match level {
                    PermissionLevel::Ask | PermissionLevel::Reviewed if is_inside => StepGate::Free,
                    PermissionLevel::Readonly
                    | PermissionLevel::Ask
                    | PermissionLevel::Reviewed => StepGate::Card,
                    PermissionLevel::Sandboxed if !is_inside => StepGate::Refused {
                        refusal: OUTSIDE_CHECKOUT_REFUSAL,
                    },
                    PermissionLevel::Sandboxed
                        if target.starts_with(git_folder.join("hooks"))
                            || target.starts_with(git_folder.join("config")) =>
                    {
                        StepGate::Refused {
                            refusal: GIT_FOLDER_REFUSAL,
                        }
                    }
                    PermissionLevel::Sandboxed | PermissionLevel::Yolo => StepGate::Free,
                }
            }
            Self::Command { .. } | Self::Code { .. } => match level {
                PermissionLevel::Readonly | PermissionLevel::Ask | PermissionLevel::Reviewed => {
                    StepGate::Card
                }
                PermissionLevel::Sandboxed | PermissionLevel::Yolo => StepGate::Free,
            },
            Self::McpCall { approval_mode, .. } => match (approval_mode, level) {
                (McpApprovalMode::Approve, _) => StepGate::Free,
                (
                    McpApprovalMode::Auto | McpApprovalMode::Prompt | McpApprovalMode::Writes,
                    PermissionLevel::Sandboxed,
                ) => StepGate::Refused {
                    refusal: ASKING_TOOL_REFUSAL,
                },
                (
                    McpApprovalMode::Auto | McpApprovalMode::Prompt | McpApprovalMode::Writes,
                    PermissionLevel::Readonly
                    | PermissionLevel::Ask
                    | PermissionLevel::Reviewed
                    | PermissionLevel::Yolo,
                ) => StepGate::Card,
            },
        }
    }

    fn subject(&self) -> String {
        match self {
            Self::FileWrite { target, .. } => target.to_string_lossy().into_owned(),
            Self::McpCall { server, tool, .. } => {
                compose_tool_server_tool_name(server.as_str(), tool.as_str())
            }
            Self::Command { line } => line.clone(),
            Self::Code { command } => command.clone(),
        }
    }

    fn tool_server_tool(&self) -> Option<ToolServerTool> {
        match self {
            Self::FileWrite { .. } | Self::Command { .. } | Self::Code { .. } => None,
            Self::McpCall { server, tool, .. } => Some(ToolServerTool {
                server: server.clone(),
                tool: tool.clone(),
            }),
        }
    }

    fn ask_action(&self) -> ProviderAskAction {
        match self {
            Self::FileWrite { .. } => ProviderAskAction::FileChange {
                paths: vec![self.subject()],
            },
            Self::McpCall { .. } => ProviderAskAction::Tool {
                tool_name: self.subject(),
            },
            Self::Command { .. } | Self::Code { .. } => ProviderAskAction::Command {
                command: self.subject(),
            },
        }
    }

    async fn read(
        &self,
        shell_lines: &ShellLineReadingBound,
    ) -> Result<StepActionReading, JoinError> {
        Ok(match self {
            Self::FileWrite { .. } => StepActionReading {
                category: ApprovalCategory::FileWrite,
                rule_subject: Some(self.subject()),
            },
            Self::McpCall { .. } => StepActionReading {
                category: ApprovalCategory::ToolExecution,
                rule_subject: Some(self.subject()),
            },
            Self::Command { .. } => {
                let action = self.ask_action();
                let read_action = action.clone();
                read_command_line(shell_lines, &action, move |reader, reading| {
                    StepActionReading {
                        category: category_of(reader, reading, &read_action),
                        rule_subject: derive_rule_subject(reading, &read_action),
                    }
                })
                .await?
            }
            Self::Code { .. } => StepActionReading {
                category: ApprovalCategory::ToolExecution,
                rule_subject: None,
            },
        })
    }
}
