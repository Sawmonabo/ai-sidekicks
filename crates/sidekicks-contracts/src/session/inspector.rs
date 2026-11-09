//! The reads behind a session's inspector sections, and the one switch the inspector carries: what
//! fills the context (the same reading feeds the composer's ring), the memory paths with the
//! `Auto memory` switch, and the hooks the provider listed, in the shape of its own listing. Every
//! figure and list is the provider's own report for this session, read by the daemon and never
//! computed on the screen; a session whose provider has reported none yet says it lists them at
//! its next start.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::method::methods;
use crate::provider::id::ProviderId;
use crate::session::controls::methods::SessionAddressedRequest;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::integer::SafeInt;
use crate::wire::number::{Percent, PositiveNumber};
use crate::wire::text::{ComposedText, NulFreeText};

/// Where the session compacts and the slider's range. The top stop is the provider's own compaction
/// point on this window; the bottom stop is the session's fixed start plus a tenth of the window,
/// rounded up, and is `null` where the provider reports what the session loads only with its first
/// usage report, until that report comes.
/// `sessionOverride` draws the `session` mark: the bound differs from the Settings default.
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

/// How the provider marks a bucket: counted as used, deferred (dimmed and left out of the used
/// figure), the compaction buffer, or free space.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
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

/// One of the provider's named buckets, in its own order, with the parts it names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionContextCategory {
    /// The bucket's name.
    pub name: ComposedText,
    /// Its tokens.
    pub tokens: SafeInt<0>,
    /// How the provider marks it.
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

/// What fills the context, by the shape of the provider's report: named buckets with their parts,
/// or totals only, the four figures of a token-usage report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionContextBreakdown {
    /// Named buckets.
    Buckets {
        /// The buckets, in the provider's order.
        categories: Vec<SessionContextCategory>,
        /// Never present: only totals carry token figures.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        cached_input_tokens: Option<Never>,
        /// Never present: only totals carry token figures.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        input_tokens: Option<Never>,
        /// Never present: only totals carry token figures.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        output_tokens: Option<Never>,
        /// Never present: only totals carry token figures.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        reasoning_tokens: Option<Never>,
    },
    /// Totals only.
    Totals {
        /// Never present: only named buckets carry categories.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        categories: Option<Never>,
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
/// reported one, which on some providers is the first turn's report.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
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
#[serde(rename_all = "camelCase")]
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
    pub path: FilesystemPath,
    /// Whether it is a file or a folder.
    pub kind: SessionMemoryEntryKind,
}

/// The `Auto memory` switch, with the value it takes from the session's next turn while a change
/// waits for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAutoMemory {
    /// Whether it is on now.
    pub enabled: bool,
    /// The value it takes from the session's next turn, while a change waits for it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub enabled_at_next_turn: Option<bool>,
}

/// Whether the store is shared across the provider's accounts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionMemoryHomeScope {
    /// The store belongs to the session's account alone.
    Account,
    /// The store is shared across the provider's accounts.
    SharedAcrossAccounts,
}

/// The inspector's `Memory` section: the home the session's conversation runs in, whether its
/// store is shared across accounts, the `Auto memory` switch and the memory paths.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionMemoryReadResponse {
    /// The session.
    pub session_id: SessionId,
    /// The home the session's conversation runs in, whose store holds the memory.
    pub home: FilesystemPath,
    /// Whether that store is shared across the provider's accounts.
    pub home_scope: SessionMemoryHomeScope,
    /// The `Auto memory` switch.
    pub auto_memory: SessionAutoMemory,
    /// The memory paths.
    pub entries: Vec<SessionMemoryEntry>,
    /// True for a session with no conversation running since the daemon started, whose provider
    /// has reported no rows yet.
    pub listed_at_next_start: bool,
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
#[serde(rename_all = "camelCase")]
pub enum SessionAutoMemoryAppliesAt {
    /// At once, where the provider takes the change live.
    Now,
    /// From the session's next turn, where a running provider takes the change between turns.
    NextTurn,
}

/// The switch, and when it takes effect: at once, or from the session's next turn where a running
/// provider takes it between turns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAutoMemoryUpdateResponse {
    /// The session.
    pub session_id: SessionId,
    /// Whether it is on.
    pub enabled: bool,
    /// When the change takes effect.
    pub applies_at: SessionAutoMemoryAppliesAt,
}

/// Declares [`SessionProviderHook`]'s arms on `handlerType`: each repeats the members every listed
/// hook carries, then adds what its handler runs.
macro_rules! session_provider_hook {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "handlerType",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum $name {$(
            $(#[doc = $arm_doc])+
            $arm {
                /// The provider's key for the hook.
                key: ComposedText,
                /// The event it runs on.
                event: ComposedText,
                /// Its matcher, where it has one.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "NulFreeText<{ usize::MAX }>")]
                matcher: Option<NulFreeText<{ usize::MAX }>>,
                /// Its time limit, in seconds.
                timeout_seconds: SafeInt<0>,
                /// The line the provider shows while it runs, where it has one.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "ComposedText")]
                status_message: Option<ComposedText>,
                /// The file it was read from.
                source_path: FilesystemPath,
                /// Where it came from, in the provider's words.
                source: ComposedText,
                /// The plugin it came with, where a plugin brought it.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "ComposedText")]
                plugin_id: Option<ComposedText>,
                /// Whether it is enabled.
                enabled: bool,
                /// Whether managed settings hold it.
                managed: bool,
                /// The provider's hash of it.
                hash: ComposedText,
                /// Its trust status, in the provider's words.
                trust_status: ComposedText,
                $($extra)*
            },
        )+}
    };
}

session_provider_hook! {
    /// One hook the provider loaded for a folder, tagged on what it runs. `event`, `matcher`,
    /// `source` and `trustStatus` are the provider's own words, carried as sent.
    pub enum SessionProviderHook {
        /// A command.
        Command {
            /// The command it runs.
            command: ComposedText,
            /// Whether it runs without holding up the event.
            #[serde(rename = "async")]
            is_async: bool,
            /// Never present: only a tool server's hook names a server.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            server: Option<Never>,
            /// Never present: only a tool server's hook names a tool.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            tool: Option<Never>,
        },
        /// A tool server's tool.
        McpTool {
            /// Never present: only a command hook runs a command.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            command: Option<Never>,
            /// Never present: only a command hook runs without holding up the event.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                rename = "async",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            is_async: Option<Never>,
            /// The tool server.
            server: ComposedText,
            /// The tool it calls.
            tool: ComposedText,
        },
        /// A prompt.
        Prompt {
            /// Never present: only a command hook runs a command.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            command: Option<Never>,
            /// Never present: only a command hook runs without holding up the event.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                rename = "async",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            is_async: Option<Never>,
            /// Never present: only a tool server's hook names a server.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            server: Option<Never>,
            /// Never present: only a tool server's hook names a tool.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            tool: Option<Never>,
        },
        /// An agent.
        Agent {
            /// Never present: only a command hook runs a command.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            command: Option<Never>,
            /// Never present: only a command hook runs without holding up the event.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                rename = "async",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            is_async: Option<Never>,
            /// Never present: only a tool server's hook names a server.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            server: Option<Never>,
            /// Never present: only a tool server's hook names a tool.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            tool: Option<Never>,
        },
    }
}

/// An error the provider reported for a hook file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderHookError {
    /// The file.
    pub path: FilesystemPath,
    /// The provider's message.
    pub message: ComposedText,
}

/// One folder's hooks, with the errors and warnings the provider reported for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderHookSource {
    /// The folder.
    pub folder: FilesystemPath,
    /// Its hooks.
    pub hooks: Vec<SessionProviderHook>,
    /// The errors reported for it.
    pub errors: Vec<ProviderHookError>,
    /// The warnings reported for it.
    pub warnings: Vec<ComposedText>,
}

/// One hook in a listing grouped by event, as the provider lists it. `event`, `matcher`, `source`,
/// `type` and `commandText` are the provider's own words, carried as sent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionProviderEventHook {
    /// The event it runs on.
    pub event: ComposedText,
    /// Its matcher, empty where it has none.
    pub matcher: NulFreeText<{ usize::MAX }>,
    /// Where it came from, in the provider's words.
    pub source: ComposedText,
    /// The plugin it came with, where a plugin brought it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub plugin_name: Option<ComposedText>,
    /// What it runs, in the provider's words.
    #[serde(rename = "type")]
    pub hook_type: ComposedText,
    /// The command, prompt or address it runs.
    pub command_text: ComposedText,
    /// The line the provider shows while it runs, where it has one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ComposedText")]
    pub status_message: Option<ComposedText>,
    /// Its time limit, in seconds, where it sets one; a fraction is allowed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "PositiveNumber")]
    pub timeout_seconds: Option<PositiveNumber>,
    /// Whether the session's mode or policy keeps it from running.
    pub disabled: bool,
    /// The settings file it was read from, where it was read from one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FilesystemPath")]
    pub source_path: Option<FilesystemPath>,
}

/// A settings file the provider skipped, so none of its hooks are listed or run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderHookSettingsError {
    /// The settings file, where the provider names it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FilesystemPath")]
    pub file: Option<FilesystemPath>,
    /// The field inside the file the error is at, empty for an error over the whole file.
    pub path: NulFreeText<{ usize::MAX }>,
    /// The provider's message.
    pub message: ComposedText,
}

/// What managed settings do to the session's hooks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the wire carries each policy flag as its own boolean member"
)]
pub struct ProviderHookPolicy {
    /// Whether managed settings turn every hook off.
    pub disabled_by_policy: bool,
    /// Whether managed settings let only their own hooks run, which the listing then leaves out.
    pub managed_only: bool,
    /// Whether managed settings let only plugins change hooks.
    pub plugin_only: bool,
    /// Whether every hook is off, whichever settings turned them off.
    pub all_disabled: bool,
    /// How many hooks managed settings hold.
    pub policy_hook_count: SafeInt<0>,
    /// Whether managed settings exist but could not be read.
    pub policy_unreadable: bool,
}

/// Declares [`SessionHookListResponse`]'s arms on `kind`: each repeats the session and its
/// provider, then adds its own listing.
macro_rules! session_hook_list_response {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "kind",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum $name {$(
            $(#[doc = $arm_doc])+
            $arm {
                /// The session.
                session_id: SessionId,
                /// The provider.
                provider: ProviderId,
                $($extra)*
            },
        )+}
    };
}

session_hook_list_response! {
    /// The inspector's `Hooks` section, by the shape of the provider's own listing: `byFolder` for
    /// hooks listed per folder, `byEvent` for hooks listed by event with the provider's policy, and
    /// `listedAtNextStart` for a session whose provider has listed none yet, which it lists at its
    /// next start. The daemon's own hooks are never listed.
    pub enum SessionHookListResponse {
        /// The hooks the provider loaded, by folder.
        ByFolder {
            /// The folders.
            folders: Vec<ProviderHookSource>,
            /// Never present: a listing by folder keeps its hooks in each folder.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            hooks: Option<Never>,
            /// Never present: a listing by folder keeps its errors in each folder.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            errors: Option<Never>,
            /// Never present: only a listing by event carries the provider's policy.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            policy: Option<Never>,
        },
        /// The hooks the provider listed, by event, with the settings files it skipped and what
        /// managed settings do to them.
        ByEvent {
            /// Never present: a listing by event names no folder.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            folders: Option<Never>,
            /// The hooks, in the provider's order.
            hooks: Vec<SessionProviderEventHook>,
            /// The settings files the provider skipped.
            errors: Vec<ProviderHookSettingsError>,
            /// What managed settings do to the hooks.
            policy: ProviderHookPolicy,
        },
        /// No listing yet: the provider lists the session's hooks at its next start.
        ListedAtNextStart {
            /// Never present: nothing is listed yet.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            folders: Option<Never>,
            /// Never present: nothing is listed yet.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            hooks: Option<Never>,
            /// Never present: nothing is listed yet.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            errors: Option<Never>,
            /// Never present: nothing is listed yet.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            policy: Option<Never>,
        },
    }
}

methods! {
    /// The inspector methods' wire contract: name, procedure type and types.
    pub const SESSION_INSPECTOR_METHOD_DESCRIPTORS = [
        /// Streams the session's context readings.
        SessionContextSubscribe = subscription "session.context.subscribe" {
            mutating: false,
            params: SessionAddressedRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: SessionContextReading,
            refusals: [SessionNotFound],
        },
        /// Reads the inspector's `Memory` section.
        SessionMemoryRead = query "session.memory.read" {
            mutating: false,
            params: SessionAddressedRequest,
            result: SessionMemoryReadResponse,
            refusals: [SessionNotFound],
        },
        /// Turns the `Auto memory` switch on or off.
        SessionAutoMemoryUpdate = mutation "session.autoMemory.update" {
            mutating: true,
            params: SessionAutoMemoryUpdateRequest,
            result: SessionAutoMemoryUpdateResponse,
            refusals: [SessionNotFound],
        },
        /// Reads the inspector's `Hooks` section.
        SessionHookList = query "session.hook.list" {
            mutating: false,
            params: SessionAddressedRequest,
            result: SessionHookListResponse,
            refusals: [SessionNotFound],
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
        Definition::read::<SessionMemoryHomeScope>(),
        Definition::read::<SessionMemoryReadResponse>().checked(),
        Definition::read::<SessionAutoMemoryUpdateRequest>().checked(),
        Definition::read::<SessionAutoMemoryAppliesAt>(),
        Definition::read::<SessionAutoMemoryUpdateResponse>().checked(),
        Definition::read::<SessionProviderHook>(),
        Definition::read::<ProviderHookError>(),
        Definition::read::<ProviderHookSource>(),
        Definition::read::<SessionProviderEventHook>(),
        Definition::read::<ProviderHookSettingsError>(),
        Definition::read::<ProviderHookPolicy>(),
        Definition::read::<SessionHookListResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[&SESSION_INSPECTOR_METHOD_DESCRIPTORS],
};
