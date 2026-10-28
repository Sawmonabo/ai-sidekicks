//! A session's own controls and the reads behind its composer chips: the permission level and the
//! Build or Plan mode, the auto-compact bound, the tool servers and their resources, the live `/`
//! list, the side question, the review, the definitions reload, the step bound, the spend and token
//! limits, and the provider sessions typed in a terminal.
//!
//! Every method here names the session it acts on, and every setting it changes belongs to that
//! session alone: Settings, other sessions and future sessions are untouched.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::mcp::server::{McpServerName, McpServerStatus};
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::driver::commands::ProviderCommandEntry;
use crate::provider::id::ProviderId;
use crate::session::cost::{SessionBudgetState, TokensPerRun, UsdMicros};
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::named_scalar;
use crate::wire::number::number;
use crate::wire::text::{ComposedText, FreeFormText};

/// The one input every session read takes: the session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAddressedRequest {
    /// The session.
    pub session_id: SessionId,
}

/// The acknowledgment an operation with nothing more to say answers with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAcknowledgment {
    /// The session.
    pub session_id: SessionId,
}

/// The five permission levels, most careful first, the same five words on every provider. Only
/// the first three ever ask the person; at `sandboxed` and `yolo` the daemon answers every ask
/// itself. Plan is not a level: it is the session's mode.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum PermissionLevel {
    /// Reads only.
    Readonly,
    /// Asks before every change.
    Ask,
    /// Asks before a change a review flags.
    Reviewed,
    /// Runs inside the sandbox without asking.
    Sandboxed,
    /// Runs anything without asking.
    Yolo,
}

/// Moves the session to a level. Setting the level it already has changes nothing, and a move never
/// answers an open card: the new level decides from the next ask.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionPermissionLevelUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The level to move to.
    pub level: PermissionLevel,
}

/// The level the session now stands at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionPermissionLevelUpdateResponse {
    /// The session.
    pub session_id: SessionId,
    /// The level it stands at.
    pub level: PermissionLevel,
}

/// Whether the session's next turns plan or build: the composer's mode control.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum SessionMode {
    /// The turns change the work.
    Build,
    /// The turns plan without changing the work.
    Plan,
}

/// Sets the session's mode.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionModeUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The mode to run in.
    pub mode: SessionMode,
}

/// The mode the session now runs in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionModeUpdateResponse {
    /// The session.
    pub session_id: SessionId,
    /// The mode it runs in.
    pub mode: SessionMode,
}

number! {
    /// An auto-compact bound: a share of the context window, in percent, above zero and at most
    /// 100.
    AutoCompactPercent, |value| value > 0.0 && value <= 100.0, "the percent is outside (0, 100]",
    { "exclusiveMinimum": 0, "maximum": 100 }
}

/// Sets this session's own auto-compact bound from its next turn, as a percent of the window;
/// `null` returns the session to the Settings default. The accepted range comes from the provider's
/// live figures, so the daemon refuses a percent outside it; the type bounds only a percent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAutoCompactUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The bound, or `null` for the Settings default.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<AutoCompactPercent>")]
    pub percent: Option<AutoCompactPercent>,
}

/// The bound the session compacts at from its next turn, and whether it is its own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAutoCompactUpdateResponse {
    /// The session.
    pub session_id: SessionId,
    /// The bound.
    pub percent: AutoCompactPercent,
    /// Whether the bound is the session's own rather than the Settings default.
    pub session_override: bool,
}

/// One tool server this session was started with. `enabled` is the session's own switch;
/// `pendingUntilNextTurn` says a switch flipped mid-turn waits for the next turn. `reason` is
/// the failure or sign-in reason, carried for a server that is not working.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionMcpServer {
    /// The server's name.
    pub server_name: McpServerName,
    /// The server's connection state.
    pub status: McpServerStatus,
    /// Why the server is not working, where it is not.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub reason: Option<ComposedText>,
    /// The session's own switch.
    pub enabled: bool,
    /// Whether a switch flipped mid-turn waits for the next turn.
    pub pending_until_next_turn: bool,
}

/// The session's whole server list, sent again on every change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionMcpServerList {
    /// The session.
    pub session_id: SessionId,
    /// Its servers.
    pub servers: Vec<SessionMcpServer>,
}

/// Turns one server on or off for this session only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionMcpServerEnabledUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The server.
    pub server_name: McpServerName,
    /// Whether it is on.
    pub enabled: bool,
}

/// The switch as the session now holds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionMcpServerEnabledUpdateResponse {
    /// The session.
    pub session_id: SessionId,
    /// The server.
    pub server_name: McpServerName,
    /// Whether it is on.
    pub enabled: bool,
}

/// Lists what one working server offers, for `Attach a resource…`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpResourceListRequest {
    /// The session.
    pub session_id: SessionId,
    /// The server.
    pub server_name: McpServerName,
}

/// One resource as the server describes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionMcpResource {
    /// The resource's address on its server.
    pub uri: ComposedText,
    /// The resource's name.
    pub name: ComposedText,
    /// Its title, where the server gives one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub title: Option<ComposedText>,
    /// Its description, where the server gives one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub description: Option<ComposedText>,
    /// Its media type, where the server gives one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub mime_type: Option<ComposedText>,
    /// Its size in bytes, where the server gives one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub size: Option<SafeInt<0>>,
}

/// The server's resources.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpResourceListResponse {
    /// The session.
    pub session_id: SessionId,
    /// The server.
    pub server_name: McpServerName,
    /// Its resources.
    pub resources: Vec<SessionMcpResource>,
}

/// One prompt a working tool server publishes, listed under the server's name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionServerPrompt {
    /// The server.
    pub server_name: McpServerName,
    /// The prompt's name.
    pub name: ComposedText,
    /// Its title, where the server gives one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub title: Option<ComposedText>,
    /// Its description, where the server gives one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub description: Option<ComposedText>,
}

/// The live `/` list's provider half: the running process's slash commands, as its provider
/// publishes them, and each working server's prompts. It is sent whole on every change: a new
/// process, the provider's own list-changed push, a server coming up or going down.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionProviderCommandList {
    /// The session.
    pub session_id: SessionId,
    /// The provider's commands.
    pub commands: Vec<ProviderCommandEntry>,
    /// The working servers' prompts.
    pub server_prompts: Vec<SessionServerPrompt>,
}

branded_uuid_id! {
    /// The daemon-minted id of one side question, echoed on its answer.
    SideQuestionId
}

named_scalar! {
    /// A side question's text: a message sent into a provider turn, uncapped like any other
    /// message; not blank and free of NUL.
    SideQuestionText(FreeFormText<{ usize::MAX }>)
}

/// Asks a side question in a throwaway copy of the conversation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionSideQuestionAskRequest {
    /// The session.
    pub session_id: SessionId,
    /// The question.
    pub question: SideQuestionText,
}

/// The id the answer will carry; the answer arrives later as an event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionSideQuestionAskResponse {
    /// The session.
    pub session_id: SessionId,
    /// The side question's id.
    pub side_question_id: SideQuestionId,
}

/// What a review covers: the working tree, the staged set, or the branch against its base.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionReviewTarget {
    /// The working tree.
    WorkingTree,
    /// The staged set.
    Staged,
    /// The branch against its base.
    Branch,
}

/// Starts the provider's own review: at once while the session's process runs, else as the
/// session's next queued item, which wakes it as a message does. Its report lands as the agent's
/// reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionCodeReviewStartRequest {
    /// The session.
    pub session_id: SessionId,
    /// What the review covers.
    pub target: SessionReviewTarget,
}

/// Sets or clears this session's own bound on how many steps one turn may take, from its next
/// turn. `null` returns the session to the machine's own value; a bound below one is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionMaxStepsUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The bound, or `null` for the machine's own value.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<SafeInt<1>>")]
    pub max_steps_per_turn: Option<SafeInt<1>>,
}

/// The stored override; absent after a clear.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionMaxStepsUpdateResponse {
    /// The session.
    pub session_id: SessionId,
    /// The stored bound, absent after a clear.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub max_steps_per_turn: Option<SafeInt<1>>,
}

/// Sets or clears this session's own `Spend limit`, in micro-dollars; `null` is `Unlimited`.
/// Saving a higher limit carries on the turns the limit stopped.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionSpendLimitUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The limit, or `null` for `Unlimited`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<UsdMicros>")]
    pub spend_limit_usd_micros: Option<UsdMicros>,
}

/// Sets or clears this session's own `Tokens per run`; `null` is `Unlimited`. Saving a higher limit
/// carries on the run the limit stopped.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionTokensPerRunUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The limit, or `null` for `Unlimited`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<TokensPerRun>")]
    pub tokens_per_run: Option<TokensPerRun>,
}

/// Where a provider session typed in a terminal stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TerminalProviderSessionState {
    /// A turn is running.
    Working,
    /// No turn is running.
    Idle,
    /// The provider's shared service does not answer for it.
    Unreachable,
}

/// One provider session a person typed in a terminal, inside that provider's shared service.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalProviderSession {
    /// The provider.
    pub provider: ProviderId,
    /// The session's name.
    pub name: ComposedText,
    /// The provider's thread id.
    pub thread_id: ComposedText,
    /// Where it stands.
    pub state: TerminalProviderSessionState,
}

/// The provider sessions typed in a terminal, read off the same directory entries the agents'
/// `session_list` names. Empty while the provider's switch that reaches sessions started in a
/// terminal is off.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderTerminalSessionListResponse {
    /// The sessions.
    pub sessions: Vec<TerminalProviderSession>,
}

methods! {
    /// The session-control methods' wire contract: name, procedure type and types.
    pub const SESSION_CONTROL_METHOD_DESCRIPTORS = [
        /// Moves the session to a permission level.
        SessionPermissionLevelUpdate = mutation "session.permissionLevel.update" {
            mutating: true,
            params: SessionPermissionLevelUpdateRequest,
            result: SessionPermissionLevelUpdateResponse,
            refusals: [
                SessionNotFound,
                SessionAlreadyClosed,
                SessionChangeRefused,
                ProviderNotFound,
                ProviderUnavailable,
                ProviderTimeout,
                SessionPermissionLevelNotOffered,
            ],
        },
        /// Sets the session's mode.
        SessionModeUpdate = mutation "session.mode.update" {
            mutating: true,
            params: SessionModeUpdateRequest,
            result: SessionModeUpdateResponse,
            refusals: [
                SessionNotFound,
                SessionAlreadyClosed,
                SessionChangeRefused,
                ProviderNotFound,
                ProviderUnavailable,
                ProviderTimeout,
                SessionModeNotOffered,
            ],
        },
        /// Sets or clears the session's auto-compact bound.
        SessionAutoCompactUpdate = mutation "session.autoCompact.update" {
            mutating: true,
            params: SessionAutoCompactUpdateRequest,
            result: SessionAutoCompactUpdateResponse,
            refusals: [SessionNotFound],
        },
        /// Streams the session's tool server list.
        SessionMcpServerSubscribe = subscription "session.mcpServer.subscribe" {
            mutating: false,
            params: SessionAddressedRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: SessionMcpServerList,
            refusals: [SessionNotFound],
        },
        /// Turns one tool server on or off for the session.
        SessionMcpServerEnabledUpdate = mutation "session.mcpServer.enabled.update" {
            mutating: true,
            params: SessionMcpServerEnabledUpdateRequest,
            result: SessionMcpServerEnabledUpdateResponse,
            refusals: [SessionNotFound],
        },
        /// Lists one working server's resources.
        McpResourceList = query "mcp.resource.list" {
            mutating: false,
            params: McpResourceListRequest,
            result: McpResourceListResponse,
            refusals: [SessionNotFound, McpServerNotRunning],
        },
        /// Streams the live `/` list's provider half.
        SessionProviderCommandSubscribe = subscription "session.providerCommand.subscribe" {
            mutating: false,
            params: SessionAddressedRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: SessionProviderCommandList,
            refusals: [
                SessionNotFound,
                ProviderNotFound,
                ProviderUnavailable,
                ProviderCapabilityUnsupported,
            ],
        },
        /// Asks a side question.
        SessionSideQuestionAsk = mutation "session.sideQuestion.ask" {
            mutating: true,
            params: SessionSideQuestionAskRequest,
            result: SessionSideQuestionAskResponse,
            refusals: [SessionNotFound, ProviderNotFound, ProviderUnavailable, ProviderTimeout],
        },
        /// Starts the provider's own review.
        SessionCodeReviewStart = mutation "session.codeReview.start" {
            mutating: true,
            params: SessionCodeReviewStartRequest,
            result: SessionAcknowledgment,
            refusals: [
                SessionNotFound,
                SessionAlreadyClosed,
                SessionChangeRefused,
                ProviderNotFound,
                ProviderUnavailable,
                AgentQueueItemPersistenceUnavailable,
                AgentQueueItemRunChanged,
            ],
        },
        /// Reopens the conversation to take new definitions.
        SessionDefinitionReload = mutation "session.definition.reload" {
            mutating: true,
            params: SessionAddressedRequest,
            result: SessionAcknowledgment,
            refusals: [SessionNotFound],
        },
        /// Sets or clears the session's step bound.
        SessionMaxStepsUpdate = mutation "session.maxSteps.update" {
            mutating: true,
            params: SessionMaxStepsUpdateRequest,
            result: SessionMaxStepsUpdateResponse,
            refusals: [SessionNotFound],
        },
        /// Sets or clears the session's `Spend limit`.
        SessionSpendLimitUpdate = mutation "session.spendLimit.update" {
            mutating: true,
            params: SessionSpendLimitUpdateRequest,
            result: SessionBudgetState,
            refusals: [SessionNotFound],
        },
        /// Sets or clears the session's `Tokens per run`.
        SessionTokensPerRunUpdate = mutation "session.tokensPerRun.update" {
            mutating: true,
            params: SessionTokensPerRunUpdateRequest,
            result: SessionBudgetState,
            refusals: [SessionNotFound],
        },
        /// Lists the provider sessions typed in a terminal.
        ProviderTerminalSessionList = query "provider.terminalSession.list" {
            mutating: false,
            params: EmptyPayload,
            result: ProviderTerminalSessionListResponse,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/controls/methods",
    doc: "A session's own controls and the reads behind its composer chips. Every method names the \
          session it acts on, and every setting it changes belongs to that session alone.",
    definitions: &[
        Definition::read::<SessionAddressedRequest>().checked(),
        Definition::read::<SessionAcknowledgment>().checked(),
        Definition::read::<PermissionLevel>().checked(),
        Definition::read::<SessionPermissionLevelUpdateRequest>().checked(),
        Definition::read::<SessionPermissionLevelUpdateResponse>().checked(),
        Definition::read::<SessionMode>(),
        Definition::read::<SessionModeUpdateRequest>().checked(),
        Definition::read::<SessionModeUpdateResponse>().checked(),
        Definition::read::<SessionAutoCompactUpdateRequest>().checked(),
        Definition::read::<SessionAutoCompactUpdateResponse>().checked(),
        Definition::read::<SessionMcpServer>(),
        Definition::read::<SessionMcpServerList>().checked(),
        Definition::read::<SessionMcpServerEnabledUpdateRequest>().checked(),
        Definition::read::<SessionMcpServerEnabledUpdateResponse>().checked(),
        Definition::read::<McpResourceListRequest>().checked(),
        Definition::read::<SessionMcpResource>(),
        Definition::read::<McpResourceListResponse>().checked(),
        Definition::read::<SessionServerPrompt>(),
        Definition::read::<SessionProviderCommandList>().checked(),
        Definition::read::<SideQuestionId>().checked(),
        Definition::read::<SideQuestionText>().checked(),
        Definition::read::<SessionSideQuestionAskRequest>().checked(),
        Definition::read::<SessionSideQuestionAskResponse>().checked(),
        Definition::read::<SessionReviewTarget>(),
        Definition::read::<SessionCodeReviewStartRequest>().checked(),
        Definition::read::<SessionMaxStepsUpdateRequest>().checked(),
        Definition::read::<SessionMaxStepsUpdateResponse>().checked(),
        Definition::read::<SessionSpendLimitUpdateRequest>().checked(),
        Definition::read::<SessionTokensPerRunUpdateRequest>().checked(),
        Definition::read::<TerminalProviderSessionState>(),
        Definition::read::<TerminalProviderSession>(),
        Definition::read::<ProviderTerminalSessionListResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[&SESSION_CONTROL_METHOD_DESCRIPTORS],
};
