//! What every Claude Code process of a session is started with, kept on the live session so a
//! rewind or a relaunch starts its next process from the same legs instead of guessing them.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::session::id::SessionId;

use crate::background_work::BackgroundWorkForms;
use crate::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::driver::callback_tool::CallbackToolDispatcher;
use crate::driver::mcp_server_status::McpServerStatusProducer;
use crate::driver::session_control::{SessionToolServer, SubagentPolicy};
use crate::run::posture::CredentialDenyPath;

/// The legs a session's process is started with.
#[derive(Clone)]
pub(crate) struct ClaudeSpawnBoundLegs {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The session's model, passed as `--model`.
    pub(crate) model: String,
    /// How the session may touch the machine; left out, a process would start unsandboxed.
    pub(crate) execution_posture: Option<ExecutionPosture>,
    /// The folder the process runs in; a resume from any other folder starts a new conversation.
    pub(crate) working_directory: PathBuf,
    /// The daemon's callback tools.
    pub(crate) callback_tools: Option<Vec<SessionCallbackTool>>,
    /// The session's helper policy.
    pub(crate) subagent_policy: Option<SubagentPolicy>,
    /// Every tool server the session can reach, each installed by `mcp_set_servers` when on.
    pub(crate) tool_servers: Vec<SessionToolServer>,
    /// The JSON Schema the final output must meet.
    pub(crate) output_schema: Option<Map<String, Value>>,
    /// Answers each callback-tool call.
    #[expect(
        dead_code,
        reason = "the driver answers each callback-tool call from the session's tool server with it"
    )]
    pub(crate) on_callback_tool_call: Option<CallbackToolDispatcher>,
    /// Receives each tool server's status.
    pub(crate) on_mcp_server_status: Option<McpServerStatusProducer>,
    /// The curated credential paths, canonical and absolute, denied to every file tool.
    pub(crate) credential_deny_paths: Vec<CredentialDenyPath>,
    /// Each spelling of the agent-memory folder, which an agent reads and edits at Sandboxed.
    pub(crate) memory_folders: Vec<PathBuf>,
    /// Every provider's background work, denied written plainly at the levels that never ask.
    pub(crate) background_work: Arc<BackgroundWorkForms>,
    /// The process's whole environment.
    pub(crate) spawn_environment: Vec<(String, String)>,
    /// The session's advisor.
    pub(crate) advisor: ClaudeSessionAdvisor,
    /// The session's own output style, `None` where Claude Code's own setting holds.
    pub(crate) output_style: Option<String>,
}
