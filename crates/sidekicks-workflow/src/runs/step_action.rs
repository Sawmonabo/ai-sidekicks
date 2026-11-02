//! The check a workflow step the daemon runs itself passes before it writes a file, calls a tool
//! server's tool, runs a command or runs a program: the run's level gates the action, and where the
//! level asks, the person answers on the daemon's own card. The approval service answers it through
//! [`StepActionApproval`].

use std::error::Error;
use std::path::PathBuf;

use futures::future::BoxFuture;
use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerName, McpToolName};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;

/// One action a workflow step takes that the daemon gates by the run's level.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StepAction {
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
    /// Runs one command line in the step's shell.
    Command {
        /// The line as the shell runs it, each filled value a `SIDEKICKS_VALUE_<n>` reference and
        /// never the value; the card shows it and the rule over it is read from it.
        line: String,
    },
    /// Runs a program with host access: the interpreter and its code file. A program with no host
    /// access asks nothing.
    Code {
        /// The program's launch line, as the card shows it.
        command: String,
    },
}

/// One step action to check: the session and run the card is raised on, the agent or step that
/// asks on it, and the run's own level.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepActionCheck {
    /// The session the workflow runs in.
    pub session_id: SessionId,
    /// The run the step belongs to.
    pub run_id: RunId,
    /// Who asks on the card.
    pub requested_by: NonEmptyText,
    /// The run's level.
    pub level: PermissionLevel,
    /// The action.
    pub action: StepAction,
}

/// How a step action's check settled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StepActionVerdict {
    /// The action runs.
    Allowed,
    /// The person declined the step's own card: the step fails and is never retried.
    Declined {
        /// The `why not` words, where the person typed any.
        words: Option<NonEmptyText>,
        /// When the decline was recorded.
        at: WireInstant,
    },
    /// The action is refused by the level, a blocking rule or a card that ended unanswered, and
    /// the step fails with `reason`.
    Refused {
        /// What the failed step reads.
        reason: String,
    },
}

/// Decides a workflow step's action before it runs, waiting on the person's answer where the
/// run's level asks.
pub trait StepActionApproval: Send + Sync {
    /// Decides `check`. Fails as a read or the card's create fails, and when the daemon stops
    /// before the card settles.
    fn check_step_action(
        &self,
        check: StepActionCheck,
    ) -> BoxFuture<'_, Result<StepActionVerdict, Box<dyn Error + Send + Sync>>>;
}
