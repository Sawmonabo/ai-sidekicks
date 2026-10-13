//! The reads behind a session's inspector sections, and the one switch the inspector carries: what
//! fills the context (the same reading feeds the composer's ring), the memory paths with the
//! `Auto memory` switch, and the hooks the provider loaded. Every figure and list is the provider's
//! own report for this session, read by the daemon and never computed on the screen.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::provider::name::ProviderName;
use crate::session::controls::methods::SessionAddressedRequest;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::number::Percent;
use crate::wire::text::{BoundedText, ComposedText};

/// A path the daemon composed, held to the longest path the wire carries.
type ComposedPath = BoundedText<1, FILE_PATH_MAX_LEN>;

/// Where the session compacts and the slider's range. The top stop is the provider's own compaction
/// point on this window; the bottom stop is the session's fixed start plus a tenth of the window,
/// rounded up, and is `null` on Codex until the first usage report says what the session loads.
/// `session_override` draws the `session` mark: the bound differs from the Settings default.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCompactionBound {
    /// The bound, in percent of the window.
    pub bound_percent: Percent,
    /// The slider's top stop.
    pub top_stop_percent: Percent,
    /// The slider's bottom stop, `null` until it is known.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<Percent>")]
    pub bottom_stop_percent: Option<Percent>,
    /// Whether the bound differs from the Settings default.
    pub session_override: bool,
}

/// How Claude Code marks a bucket: counted as used, deferred (dimmed and left out of the used
/// figure), the compaction buffer, or free space.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SessionContextCategoryKind {
    /// Counted as used.
    Used,
    /// Dimmed and left out of the used figure.
    Deferred,
    /// The compaction buffer.
    Buffer,
    /// Free space.
    Free,
}

/// One named part inside a bucket: a tool, a memory file, an agent or a skill.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionContextPart {
    /// The part's name.
    pub name: ComposedText,
    /// Its tokens.
    pub tokens: SafeInt<0>,
}

/// One of Claude Code's buckets, in its own order, with the parts it names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionContextCategory {
    /// The bucket's name.
    pub name: ComposedText,
    /// Its tokens.
    pub tokens: SafeInt<0>,
    /// How Claude Code marks it.
    pub kind: SessionContextCategoryKind,
    /// The parts it names, where it names any.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<SessionContextPart>")]
    pub parts: Option<Vec<SessionContextPart>>,
}

/// What fills the context, per provider. Claude Code reports named buckets; Codex reports totals
/// only, the four figures of its token-usage update.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "provider",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionContextBreakdown {
    /// Claude Code's named buckets.
    Claude {
        /// The buckets, in Claude Code's order.
        categories: Vec<SessionContextCategory>,
    },
    /// Codex's totals.
    Codex {
        /// Cached input tokens.
        cached_input_tokens: SafeInt<0>,
        /// Input tokens.
        input_tokens: SafeInt<0>,
        /// Output tokens.
        output_tokens: SafeInt<0>,
        /// Reasoning tokens.
        reasoning_tokens: SafeInt<0>,
    },
}

/// The used tokens against the window, and what they are made of.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionContextUsage {
    /// The used tokens.
    pub used_tokens: SafeInt<0>,
    /// The used share of the window, in percent.
    pub used_percent: Percent,
    /// What the used tokens are made of.
    pub breakdown: SessionContextBreakdown,
}

/// One reading of the session's context, which feeds the ring and the inspector's `Context`
/// section alike so the two never disagree. Every figure is the provider's own, read at creation,
/// on every model change and on each usage report. `usage` is `null` until the provider has
/// reported one, which on Codex is the first turn's report.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionContextReading {
    /// The session.
    pub session_id: SessionId,
    /// The window, in tokens.
    pub window_tokens: SafeInt<1>,
    /// Where the session compacts.
    pub compaction: SessionCompactionBound,
    /// The usage, `null` until the provider has reported one.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<SessionContextUsage>")]
    pub usage: Option<SessionContextUsage>,
}

/// Whether a memory path is a file or a folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SessionMemoryEntryKind {
    /// A file.
    File,
    /// A folder.
    Folder,
}

/// One memory file or folder the provider reported for this session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionMemoryEntry {
    /// The path.
    pub path: ComposedPath,
    /// Whether it is a file or a folder.
    pub kind: SessionMemoryEntryKind,
}

/// The `Auto memory` switch, with the value waiting for the provider's next start where a change
/// waits for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAutoMemory {
    /// Whether it is on now.
    pub enabled: bool,
    /// The value it takes at the next start, while a change waits for it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub enabled_at_next_start: Option<bool>,
}

/// The inspector's `Memory` section: the account home the memory lives under, the `Auto memory`
/// switch and the memory paths.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionMemoryReadResponse {
    /// The session.
    pub session_id: SessionId,
    /// The account home the memory lives under.
    pub home: ComposedPath,
    /// The `Auto memory` switch.
    pub auto_memory: SessionAutoMemory,
    /// The memory paths.
    pub entries: Vec<SessionMemoryEntry>,
}

/// Turns the session's `Auto memory` switch on or off.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAutoMemoryUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// Whether it is on.
    pub enabled: bool,
}

/// When an `Auto memory` change takes effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionAutoMemoryAppliesAt {
    /// At once, as on Codex.
    Now,
    /// At the provider's next start, as on Claude Code.
    NextStart,
}

/// The switch, and when it takes effect: at once on Codex, at the next start on Claude Code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAutoMemoryUpdateResponse {
    /// The session.
    pub session_id: SessionId,
    /// Whether it is on.
    pub enabled: bool,
    /// When the change takes effect.
    pub applies_at: SessionAutoMemoryAppliesAt,
}

/// What a hook runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionProviderHookHandlerType {
    /// A command.
    Command,
    /// A tool server's tool.
    McpTool,
    /// A prompt.
    Prompt,
    /// An agent.
    Agent,
}

/// One hook the provider loaded for the session's folder. `event`, `source` and `trust_status` are
/// the provider's own words, carried as sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionProviderHook {
    /// The provider's key for the hook.
    pub key: ComposedText,
    /// The event it runs on.
    pub event: ComposedText,
    /// What it runs.
    pub handler_type: SessionProviderHookHandlerType,
    /// The command it runs, where it runs one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub command: Option<ComposedText>,
    /// Its matcher, where it has one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub matcher: Option<ComposedText>,
    /// Its time limit, in seconds.
    pub timeout_seconds: SafeInt<0>,
    /// The file it was read from.
    pub source_path: ComposedPath,
    /// Where it came from, in the provider's words.
    pub source: ComposedText,
    /// Whether it is enabled.
    pub enabled: bool,
    /// Whether managed settings hold it.
    pub managed: bool,
    /// The provider's hash of it.
    pub hash: ComposedText,
    /// Its trust status, in the provider's words.
    pub trust_status: ComposedText,
}

/// An error the provider reported for a hook file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderHookError {
    /// The file.
    pub path: ComposedPath,
    /// The provider's message.
    pub message: ComposedText,
}

/// One folder's hooks, with the errors and warnings the provider reported for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderHookSource {
    /// The folder.
    pub folder: ComposedPath,
    /// Its hooks.
    pub hooks: Vec<SessionProviderHook>,
    /// The errors reported for it.
    pub errors: Vec<ProviderHookError>,
    /// The warnings reported for it.
    pub warnings: Vec<ComposedText>,
}

/// A file the provider reads hooks from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderHookFile {
    /// The file.
    pub path: ComposedPath,
}

/// The inspector's `Hooks` section, by what it lists: `loadedHooks` where the provider reports the
/// hooks it loaded (Codex), `hookFiles` where it reports none and the section lists the files it
/// reads hooks from (Claude Code). The daemon's own hooks are never listed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionHookListResponse {
    /// The hooks the provider loaded, by folder.
    LoadedHooks {
        /// The session.
        session_id: SessionId,
        /// The provider.
        provider: ProviderName,
        /// The folders.
        folders: Vec<ProviderHookSource>,
    },
    /// The files the provider reads hooks from.
    HookFiles {
        /// The session.
        session_id: SessionId,
        /// The provider.
        provider: ProviderName,
        /// The files.
        files: Vec<ProviderHookFile>,
    },
}

methods! {
    /// The inspector methods' wire contract: name, procedure type and types.
    pub const SESSION_INSPECTOR_METHOD_DESCRIPTORS = [
        /// Streams the session's context readings.
        SessionContextSubscribe = subscription "session.contextSubscribe" {
            mutating: false,
            params: SessionAddressedRequest,
            result: SubscribeAckResponse,
            emission: SessionContextReading,
            refusals: [],
        },
        /// Reads the inspector's `Memory` section.
        SessionMemoryRead = query "session.memoryRead" {
            mutating: false,
            params: SessionAddressedRequest,
            result: SessionMemoryReadResponse,
            refusals: [],
        },
        /// Turns the `Auto memory` switch on or off.
        SessionAutoMemoryUpdate = mutation "session.autoMemoryUpdate" {
            mutating: true,
            params: SessionAutoMemoryUpdateRequest,
            result: SessionAutoMemoryUpdateResponse,
            refusals: [],
        },
        /// Reads the inspector's `Hooks` section.
        SessionHookList = query "session.hookList" {
            mutating: false,
            params: SessionAddressedRequest,
            result: SessionHookListResponse,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/inspector",
    doc: "The reads behind a session's inspector sections, and the `Auto memory` switch. Every \
          figure and list is the provider's own report for this session.",
    definitions: &[
        Definition::read::<SessionCompactionBound>(),
        Definition::read::<SessionContextCategoryKind>(),
        Definition::read::<SessionContextPart>(),
        Definition::read::<SessionContextCategory>(),
        Definition::read::<SessionContextBreakdown>(),
        Definition::read::<SessionContextUsage>(),
        Definition::read::<SessionContextReading>().checked(),
        Definition::read::<SessionMemoryEntryKind>(),
        Definition::read::<SessionMemoryEntry>(),
        Definition::read::<SessionAutoMemory>(),
        Definition::read::<SessionMemoryReadResponse>().checked(),
        Definition::read::<SessionAutoMemoryUpdateRequest>().checked(),
        Definition::read::<SessionAutoMemoryAppliesAt>(),
        Definition::read::<SessionAutoMemoryUpdateResponse>().checked(),
        Definition::read::<SessionProviderHookHandlerType>(),
        Definition::read::<SessionProviderHook>(),
        Definition::read::<ProviderHookError>(),
        Definition::read::<ProviderHookSource>(),
        Definition::read::<ProviderHookFile>(),
        Definition::read::<SessionHookListResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[&SESSION_INSPECTOR_METHOD_DESCRIPTORS],
};
