//! What a workflow step the daemon runs itself asks of the run's level before it acts.
//!
//! - A file write follows the session levels' own table: inside the step's checkout it asks only at
//!   Read-only; outside it asks at Read-only, Ask and Reviewed, is refused at Sandboxed and is free
//!   at YOLO. Sandboxed also keeps the repository's hooks and config closed.
//! - A tool server's tool follows the decision Codex itself makes for the binding's approval mode,
//!   reading no annotations: `approve` runs at every level, and every other mode asks at each
//!   level but Sandboxed, which never asks and so refuses it.

use std::path::PathBuf;

use sidekicks_contracts::approval::ApprovalCategory;
use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerName, McpToolName};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_provider::mcp::tool_name::compose_tool_server_tool_name;
use sidekicks_provider::port::permission_ask::ProviderAskAction;

/// What the failed step reads when Sandboxed refuses a write outside the step's checkout.
pub(crate) const OUTSIDE_CHECKOUT_REFUSAL: &str =
    "This write is outside the step's checkout, which Sandboxed keeps closed.";

/// What the failed step reads when Sandboxed refuses a write to the repository's hooks or config.
pub(crate) const GIT_FOLDER_REFUSAL: &str =
    "This write reaches the repository's hooks or config, which Sandboxed keeps closed.";

/// What the failed step reads when Sandboxed refuses a tool whose approval mode asks.
pub(crate) const ASKING_TOOL_REFUSAL: &str =
    "This tool asks before it runs, and Sandboxed never asks, so it did not run.";

/// One action a workflow step takes that the daemon gates by the run's level.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow engine's file-write and tool-server steps"
    )
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum StepAction {
    /// Writes one file. The paths are canonical: the step refused any `..` before resolving them.
    FileWrite {
        /// The file written.
        target: PathBuf,
        /// The step's checkout.
        checkout_root: PathBuf,
        /// The checkout's git folder.
        git_folder: PathBuf,
    },
    /// Calls one tool of a tool server.
    McpCall {
        /// The server's name.
        server: McpServerName,
        /// The tool's name on that server.
        tool: McpToolName,
        /// The binding's approval mode for the tool.
        approval_mode: McpApprovalMode,
    },
}

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

impl StepAction {
    /// What `level` asks of this action.
    pub(crate) fn gate_at(&self, level: PermissionLevel) -> StepGate {
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

    /// The words a session rule over this action names: the written file's path, or the tool's
    /// server-qualified name, so an allow for one server's tool never covers another server's tool
    /// of the same name.
    pub(crate) fn subject(&self) -> String {
        match self {
            Self::FileWrite { target, .. } => target.to_string_lossy().into_owned(),
            Self::McpCall { server, tool, .. } => {
                compose_tool_server_tool_name(server.as_str(), tool.as_str())
            }
        }
    }

    /// The action as the card shows it and a session rule names its kind.
    pub(crate) fn ask_action(&self) -> ProviderAskAction {
        match self {
            Self::FileWrite { .. } => ProviderAskAction::FileChange {
                paths: vec![self.subject()],
            },
            Self::McpCall { .. } => ProviderAskAction::Tool {
                tool_name: self.subject(),
            },
        }
    }

    /// What the card is about.
    pub(crate) fn category(&self) -> ApprovalCategory {
        match self {
            Self::FileWrite { .. } => ApprovalCategory::FileWrite,
            Self::McpCall { .. } => ApprovalCategory::ToolExecution,
        }
    }
}
