//! The control requests the daemon sends a Claude Code process, in their wire shape, and the
//! members they carry: the hooks, helpers and dialogs `initialize` declares, the flag settings a
//! live process takes, the permission modes and the tool servers it is sent. The set is closed,
//! so no unrouted subtype can be written.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;

use crate::lenient_json::{LenientList, lenient_object, read_lenient};

/// One control request, tagged on the wire by its `subtype`.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub(crate) enum ClaudeControlRequest {
    /// Brings the process up with the daemon's hooks, the session's helpers and the dialogs the
    /// console draws, or re-sent on a live process, carrying no hooks, to read what it still holds.
    Initialize {
        /// The hooks answered over this channel; absent on a re-sent `initialize`, since a re-send
        /// carrying hooks resolves every callback still held.
        #[serde(skip_serializing_if = "Option::is_none")]
        hooks: Option<ClaudeHooks>,
        /// The session's helper definitions by name; absent when it declares none.
        #[serde(skip_serializing_if = "Option::is_none")]
        agents: Option<BTreeMap<String, ClaudeAgentDefinition>>,
        /// The dialog kinds the console draws; absent on a re-send, which changes none.
        #[serde(
            rename = "supportedDialogKinds",
            skip_serializing_if = "Option::is_none"
        )]
        supported_dialog_kinds: Option<Vec<&'static str>>,
        /// Whether the console offers a stop on each background task; absent on a re-send.
        #[serde(
            rename = "perTaskStopAffordance",
            skip_serializing_if = "Option::is_none"
        )]
        per_task_stop_affordance: Option<bool>,
        /// The tool servers the daemon hosts in-process, answered through `mcp_message`; absent on
        /// a re-send.
        #[serde(rename = "sdkMcpServers", skip_serializing_if = "Option::is_none")]
        sdk_mcp_servers: Option<Vec<String>>,
    },
    /// Stops the running turn; with `cancel_queued` it also drops what is queued behind it.
    Interrupt {
        /// Whether the messages queued behind the turn are dropped too.
        #[serde(skip_serializing_if = "is_false")]
        cancel_queued: bool,
    },
    /// Changes the flag settings layer of a live process.
    ApplyFlagSettings {
        /// The keys changed, each merged whole.
        settings: ClaudeFlagSettings,
    },
    /// Moves a live process to another permission mode.
    SetPermissionMode {
        /// The mode.
        mode: ClaudePermissionMode,
    },
    /// Asks for summarized thinking blocks.
    SetMaxThinkingTokens {
        /// Always `summarized`.
        thinking_display: ClaudeThinkingDisplay,
    },
    /// Installs the process's tool servers, replacing the set, answered by a
    /// [`ClaudeMcpSetServersReply`].
    McpSetServers {
        /// Each route by its server name.
        servers: BTreeMap<String, ClaudeToolServerEntry>,
    },
    /// Delivers one MCP JSON-RPC message from a tool server the daemon hosts in-process.
    #[expect(
        dead_code,
        reason = "the tool-server front relays each in-process server's own messages in it"
    )]
    McpMessage {
        /// The server, as `initialize` or `mcp_set_servers` named it.
        server_name: String,
        /// The JSON-RPC message, relayed as the server wrote it.
        message: Box<RawValue>,
    },
    /// Moves running foreground work (a command, a helper) to the background, answered by a
    /// [`ClaudeBackgroundTasksReply`].
    BackgroundTasks {
        /// The one tool call whose work moves; absent, all of it.
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
    },
    /// Asks Claude Code for a session title, answered by a [`ClaudeSessionTitleReply`].
    GenerateSessionTitle {
        /// What the session is about.
        description: String,
        /// Whether Claude Code keeps the title as the session's own.
        persist: bool,
    },
    /// Sets the session's title as the person chose it in the app.
    RenameSession {
        /// The title.
        title: String,
        /// Always `host`: the person renamed it here, which Claude Code counts as their rename.
        source: ClaudeTitleSource,
        /// The session the title is for, so a process that moved to another session refuses it.
        session_id: String,
    },
    /// Reads the settings that took effect.
    GetSettings {},
    /// Reads the status of each MCP server the process holds, answered by a
    /// [`ClaudeMcpStatusReply`](super::mcp_status::ClaudeMcpStatusReply).
    McpStatus {},
    /// Cuts the conversation back to before one message.
    RewindConversation {
        /// The message the cut removes, with all after it.
        target_message_uuid: String,
        /// The last message the daemon saw, so a message it never saw is not cut blind.
        #[serde(skip_serializing_if = "Option::is_none")]
        last_seen_user_message_uuid: Option<String>,
        /// Always `true`: a running turn is stopped first.
        interrupt_if_running: bool,
    },
    /// Takes back a message the running turn has not read yet.
    CancelAsyncMessage {
        /// The message's uuid.
        message_uuid: String,
    },
    /// Reads the context usage of the running model.
    GetContextUsage {
        /// How the categories are counted.
        detail: ClaudeContextUsageDetail,
    },
    /// Stops one running background task (a command, a helper), answered once Claude Code has
    /// stopped it.
    StopTask {
        /// The task, as its `task_started` named it.
        task_id: String,
    },
    /// Moves a live process to another model.
    SetModel {
        /// The model, as Claude Code takes `--model`.
        model: String,
    },
    /// Reads the build's version.
    GetBinaryVersion {},
    /// A subtype Claude Code knows nothing of, which the capability probe sends to check that an
    /// unknown subtype is refused.
    #[serde(rename = "zzq_nonexistent_subtype")]
    NegativeControl {},
}

impl ClaudeControlRequest {
    /// The request a capability probe named `probe_name` sends: `initialize` re-sent with nothing,
    /// which answers what the process holds, or the negative control; `None` for any other name.
    pub(crate) fn probe(probe_name: &str) -> Option<Self> {
        if probe_name == ClaudeControlSubtype::Initialize.as_str() {
            Some(Self::Initialize {
                hooks: None,
                agents: None,
                supported_dialog_kinds: None,
                per_task_stop_affordance: None,
                sdk_mcp_servers: None,
            })
        } else if probe_name == ClaudeControlSubtype::NegativeControl.as_str() {
            Some(Self::NegativeControl {})
        } else {
            None
        }
    }

    /// The request's subtype.
    pub(crate) fn subtype(&self) -> ClaudeControlSubtype {
        match self {
            Self::Initialize { .. } => ClaudeControlSubtype::Initialize,
            Self::Interrupt { .. } => ClaudeControlSubtype::Interrupt,
            Self::ApplyFlagSettings { .. } => ClaudeControlSubtype::ApplyFlagSettings,
            Self::SetPermissionMode { .. } => ClaudeControlSubtype::SetPermissionMode,
            Self::SetMaxThinkingTokens { .. } => ClaudeControlSubtype::SetMaxThinkingTokens,
            Self::McpSetServers { .. } => ClaudeControlSubtype::McpSetServers,
            Self::GetSettings {} => ClaudeControlSubtype::GetSettings,
            Self::McpStatus {} => ClaudeControlSubtype::McpStatus,
            Self::RewindConversation { .. } => ClaudeControlSubtype::RewindConversation,
            Self::CancelAsyncMessage { .. } => ClaudeControlSubtype::CancelAsyncMessage,
            Self::GetContextUsage { .. } => ClaudeControlSubtype::GetContextUsage,
            Self::StopTask { .. } => ClaudeControlSubtype::StopTask,
            Self::SetModel { .. } => ClaudeControlSubtype::SetModel,
            Self::GetBinaryVersion {} => ClaudeControlSubtype::GetBinaryVersion,
            Self::McpMessage { .. } => ClaudeControlSubtype::McpMessage,
            Self::BackgroundTasks { .. } => ClaudeControlSubtype::BackgroundTasks,
            Self::GenerateSessionTitle { .. } => ClaudeControlSubtype::GenerateSessionTitle,
            Self::RenameSession { .. } => ClaudeControlSubtype::RenameSession,
            Self::NegativeControl {} => ClaudeControlSubtype::NegativeControl,
        }
    }
}

/// Which control request a refusal or a lost answer is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeControlSubtype {
    /// `initialize`.
    Initialize,
    /// `interrupt`.
    Interrupt,
    /// `apply_flag_settings`.
    ApplyFlagSettings,
    /// `set_permission_mode`.
    SetPermissionMode,
    /// `set_max_thinking_tokens`.
    SetMaxThinkingTokens,
    /// `mcp_set_servers`.
    McpSetServers,
    /// `get_settings`.
    GetSettings,
    /// `mcp_status`.
    McpStatus,
    /// `rewind_conversation`.
    RewindConversation,
    /// `cancel_async_message`.
    CancelAsyncMessage,
    /// `get_context_usage`.
    GetContextUsage,
    /// `stop_task`.
    StopTask,
    /// `set_model`.
    SetModel,
    /// `get_binary_version`.
    GetBinaryVersion,
    /// `mcp_message`.
    McpMessage,
    /// `background_tasks`.
    BackgroundTasks,
    /// `generate_session_title`.
    GenerateSessionTitle,
    /// `rename_session`.
    RenameSession,
    /// The capability probe's negative control.
    NegativeControl,
}

impl ClaudeControlSubtype {
    /// The subtype as the wire spells it.
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::Interrupt => "interrupt",
            Self::ApplyFlagSettings => "apply_flag_settings",
            Self::SetPermissionMode => "set_permission_mode",
            Self::SetMaxThinkingTokens => "set_max_thinking_tokens",
            Self::McpSetServers => "mcp_set_servers",
            Self::GetSettings => "get_settings",
            Self::McpStatus => "mcp_status",
            Self::RewindConversation => "rewind_conversation",
            Self::CancelAsyncMessage => "cancel_async_message",
            Self::GetContextUsage => "get_context_usage",
            Self::StopTask => "stop_task",
            Self::SetModel => "set_model",
            Self::GetBinaryVersion => "get_binary_version",
            Self::McpMessage => "mcp_message",
            Self::BackgroundTasks => "background_tasks",
            Self::GenerateSessionTitle => "generate_session_title",
            Self::RenameSession => "rename_session",
            Self::NegativeControl => "zzq_nonexistent_subtype",
        }
    }
}

/// How `get_context_usage` counts its categories.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClaudeContextUsageDetail {
    /// From the last response's usage and local estimates, with no token-count call per
    /// category.
    Summary,
}

/// The thinking display `set_max_thinking_tokens` asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClaudeThinkingDisplay {
    /// A summary of each thinking block.
    Summarized,
}

/// The hooks `initialize` registers, by the event each runs on; an event with none is left out.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(crate) struct ClaudeHooks {
    /// Before each tool call.
    #[serde(rename = "PreToolUse", skip_serializing_if = "Vec::is_empty")]
    pub(crate) pre_tool_use: Vec<ClaudeHookMatcher>,
    /// After each tool call.
    #[serde(rename = "PostToolUse", skip_serializing_if = "Vec::is_empty")]
    pub(crate) post_tool_use: Vec<ClaudeHookMatcher>,
    /// After each batch of tool calls.
    #[serde(rename = "PostToolBatch", skip_serializing_if = "Vec::is_empty")]
    pub(crate) post_tool_batch: Vec<ClaudeHookMatcher>,
    /// As a helper finishes.
    #[serde(rename = "SubagentStop", skip_serializing_if = "Vec::is_empty")]
    pub(crate) subagent_stop: Vec<ClaudeHookMatcher>,
    /// When a tool call is denied.
    #[serde(rename = "PermissionDenied", skip_serializing_if = "Vec::is_empty")]
    pub(crate) permission_denied: Vec<ClaudeHookMatcher>,
}

/// One hook matcher: which tool names it runs on, the callbacks it calls and how long Claude Code
/// waits on an unanswered one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeHookMatcher {
    /// A regular expression on the tool name; absent, every tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) matcher: Option<String>,
    /// The callback ids the hook calls, each answered over this channel.
    pub(crate) hook_callback_ids: Vec<&'static str>,
    /// How long Claude Code waits on an unanswered callback, in seconds; absent, its own default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) timeout: Option<u64>,
}

/// One helper as `initialize` declares it under `agents`. Claude Code requires the description and
/// prompt; no permission mode is sent, so a helper runs at its session's level.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeAgentDefinition {
    /// When the lead should use the helper.
    pub(crate) description: String,
    /// The helper's instructions.
    pub(crate) prompt: String,
    /// The helper's model; absent, the lead's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    /// The tools the helper may use; absent, every tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tools: Option<Vec<String>>,
    /// The helper's effort; absent, the lead's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) effort: Option<String>,
    /// The most turns the helper takes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) max_turns: Option<u64>,
}

/// A tool server `mcp_set_servers` installs: a server the person declared, sent with its values,
/// a route on the daemon's tool server, or a server the daemon hosts in-process. Its `Debug` names
/// the transport alone, since a declaration's environment and headers carry credentials.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ClaudeToolServerEntry {
    /// A program Claude Code starts and talks to over its standard input and output.
    Stdio {
        /// The program.
        command: String,
        /// Its arguments.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        /// The environment it starts with, values included.
        #[serde(skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
    },
    /// Reached over HTTP at `url`.
    Http {
        /// The server's address.
        url: String,
        /// The headers each request carries, values included.
        #[serde(skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
    /// Reached over server-sent events at `url`.
    Sse {
        /// The server's address.
        url: String,
        /// The headers each request carries, values included.
        #[serde(skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
    /// Hosted in-process, its messages carried by `mcp_message`.
    #[expect(
        dead_code,
        reason = "setting the session's tool servers names an in-process server with it"
    )]
    Sdk {
        /// The server's name.
        name: String,
    },
}

impl fmt::Debug for ClaudeToolServerEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let transport = match self {
            Self::Stdio { .. } => "stdio",
            Self::Http { .. } => "http",
            Self::Sse { .. } => "sse",
            Self::Sdk { .. } => "sdk",
        };
        formatter
            .debug_struct("ClaudeToolServerEntry")
            .field("type", &transport)
            .finish_non_exhaustive()
    }
}

/// An `mcp_set_servers` answer: the error text of each server that failed to start, by the name
/// it was sent under; every other member is left unread. The text can echo a header, so it
/// derives no `Debug`.
#[derive(Default, Deserialize)]
pub(crate) struct ClaudeMcpSetServersReply {
    /// Each failed server's error text, as sent, untrusted; absent from an answer with none.
    #[serde(default)]
    pub(crate) errors: Option<serde_json::Map<String, Value>>,
}

impl ClaudeMcpSetServersReply {
    /// Reads an `mcp_set_servers` answer; an absent one, or one that is no object, carries no
    /// errors.
    pub(crate) fn read(reply: Option<&RawValue>) -> Self {
        reply
            .and_then(|reply| serde_json::from_str(reply.get()).ok())
            .unwrap_or_default()
    }
}

/// Who chose a session's title.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClaudeTitleSource {
    /// The person, in the app.
    Host,
}

/// An `interrupt`'s receipt: the messages the interrupt dropped, where it dropped them; read
/// leniently, a member of another shape as none.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ClaudeInterruptReceipt {
    /// The messages the interrupt dropped, by uuid; sent only for `cancel_queued`.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) cancelled: Option<LenientList<String>>,
}

/// A `background_tasks` answer: whether any work moved.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ClaudeBackgroundTasksReply {
    /// Whether work moved; absent from a build that does not say.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) backgrounded: Option<bool>,
}

/// A `generate_session_title` answer.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ClaudeSessionTitleReply {
    /// The title Claude Code wrote.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) title: Option<String>,
}

/// A `get_settings` answer: the settings merged from every source and what took effect for the
/// session, each read by the member its reader needs; every other member is left unread.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ClaudeSettingsReply {
    /// The settings merged from every source.
    #[serde(default)]
    pub(crate) effective: Option<Value>,
    /// What took effect for the session.
    #[serde(default)]
    pub(crate) applied: Option<Value>,
}

impl ClaudeSettingsReply {
    /// Reads a `get_settings` answer; an absent one, or one that is no object, carries neither
    /// member.
    pub(crate) fn read(reply: Option<&RawValue>) -> Self {
        reply
            .and_then(|reply| serde_json::from_str(reply.get()).ok())
            .unwrap_or_default()
    }
}

lenient_object!(
    ClaudeInterruptReceipt,
    ClaudeBackgroundTasksReply,
    ClaudeSessionTitleReply,
);

/// Claude Code's permission modes, as `--permission-mode` and `set_permission_mode` take them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ClaudePermissionMode {
    /// Asks before each change.
    Default,
    /// Takes file changes unasked.
    AcceptEdits,
    /// Claude Code's own reviewer decides.
    Auto,
    /// Refuses whatever would ask.
    DontAsk,
    /// Asks nothing.
    BypassPermissions,
    /// Plans without changing anything.
    Plan,
}

/// The `permissions` document of a session's settings: the whole list of each kind.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub(crate) struct ClaudePermissionsDocument {
    /// The rules that allow unasked.
    pub(crate) allow: Vec<String>,
    /// The rules that always ask.
    pub(crate) ask: Vec<String>,
    /// The rules that refuse.
    pub(crate) deny: Vec<String>,
}

/// The command sandbox at Sandboxed: on, failing closed where it cannot run, writable in the
/// listed folders alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeSandboxSettings {
    /// Always `true`.
    pub(crate) enabled: bool,
    /// Always `true`: a command the sandbox cannot run is refused, never run outside it.
    pub(crate) fail_if_unavailable: bool,
    /// No command runs outside the sandbox.
    pub(crate) excluded_commands: Vec<String>,
    /// The folders commands may write in.
    pub(crate) filesystem: ClaudeSandboxFilesystem,
}

/// The sandbox's file-system grant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeSandboxFilesystem {
    /// The folders commands may write in, absolute.
    pub(crate) allow_write: Vec<String>,
    /// The folders inside those that commands may not write in, absolute.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) deny_write: Vec<String>,
}

/// The flag settings changed on a live process. Each top-level key is merged whole, so
/// `permissions` always carries the session's whole document; an absent key is unchanged.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeFlagSettings {
    /// Whether fast output is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) fast_mode: Option<bool>,
    /// The session's whole permissions document.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) permissions: Option<ClaudePermissionsDocument>,
    /// One of the output styles the `initialize` reply offered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) output_style: Option<String>,
    /// The command sandbox: set at Sandboxed, sent as `null` to remove it at every other level.
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    #[expect(
        clippy::option_option,
        reason = "absent keeps the sandbox, null removes it and a value sets it"
    )]
    pub(crate) sandbox: Option<Option<ClaudeSandboxSettings>>,
    /// The session's advisor model, `""` for none, which outranks the person's own advisor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) advisor_model: Option<String>,
    /// Environment keys the process reads from its next request on; one sent as `""` is removed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) env: Option<BTreeMap<String, String>>,
    /// Whether Ultracode is on for the session alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ultracode: Option<bool>,
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde's skip_serializing_if passes the member by reference"
)]
fn is_false(value: &bool) -> bool {
    !*value
}
