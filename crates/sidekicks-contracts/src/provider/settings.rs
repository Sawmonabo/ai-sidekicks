//! The `provider.*` methods: each provider's own settings on this machine, apart from its accounts.
//! Every figure a knob is bounded by comes from the provider: the compaction stops from its own
//! models, the output styles from the installed build's own listing. The standing rules are read
//! from and revoked in the provider's own files, and the daemon keeps no copy.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::account::record::ProviderAccountId;
use crate::provider::name::ProviderName;
use crate::repo::mount::RepoMountId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::{BoundedInt, SafeInt};
use crate::wire::text::{FreeFormText, branded_text};

ts_constants! {
    /// The longest provider command version, as the command reports it.
    pub const PROVIDER_VERSION_MAX_LEN: usize = 64;
    /// The longest output style name.
    pub const PROVIDER_OUTPUT_STYLE_NAME_MAX_LEN: usize = 128;
    /// The longest output style description.
    pub const PROVIDER_OUTPUT_STYLE_DESCRIPTION_MAX_LEN: usize = 512;
    /// The most output styles one build may list.
    pub const PROVIDER_OUTPUT_STYLES_MAX: usize = 256;
    /// The longest protected-path pattern or standing rule text.
    pub const PROVIDER_RULE_TEXT_MAX_LEN: usize = 4096;
    /// The longest standing rule decision word.
    pub const PROVIDER_RULE_DECISION_MAX_LEN: usize = 64;
    /// The longest standing rule id.
    pub const PROVIDER_STANDING_RULE_ID_MAX_LEN: usize = 256;
    /// The longest install failure reason: the installer's last lines, credentials removed.
    pub const PROVIDER_INSTALL_FAILURE_REASON_MAX_LEN: usize = 4096;
    /// The longest installer command a failed install shows.
    pub const PROVIDER_INSTALL_COMMAND_MAX_LEN: usize = 1024;
    /// The provider's command is not installed, so a setting that needs it cannot be turned on:
    /// availability for new sessions, the shared terminal service and the terminal plugin.
    PROVIDER_NOT_INSTALLED_CODE = "provider.not_installed";
    /// Nothing runnable sits at the command path the person typed.
    PROVIDER_COMMAND_NOT_RUNNABLE_CODE = "provider.command_not_runnable";
}

/// The provider version as its command printed it.
type ProviderVersion = FreeFormText<PROVIDER_VERSION_MAX_LEN>;
/// The path the person typed for a provider's command.
type CommandPath = FreeFormText<FILE_PATH_MAX_LEN>;
/// An output style's name.
type OutputStyleName = FreeFormText<PROVIDER_OUTPUT_STYLE_NAME_MAX_LEN>;
/// A protected-path pattern or a standing rule's text.
type RuleText = FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN>;
/// The file a protected path or a standing rule came from.
type RuleSourcePath = FreeFormText<FILE_PATH_MAX_LEN>;
/// A whole percent.
type WholePercent = BoundedInt<0, 100>;

/// What the provider check found where the command resolves. `indeterminate` is a check that
/// could not settle and is never folded into another arm.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderInstallation {
    /// A runnable command.
    Installed {
        /// The version as the command printed it.
        raw_version: ProviderVersion,
        /// The version, where it parses; every version runs.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderVersion")]
        parsed_version: Option<ProviderVersion>,
    },
    /// Nothing runnable.
    NotInstalled {},
    /// A check that could not settle.
    Indeterminate {},
}

/// The compaction threshold in percent full: a whole percent on a step of five.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct CompactPercent(u8);

impl CompactPercent {
    /// The percent.
    pub const fn get(self) -> u8 {
        self.0
    }
}

impl<'de> Deserialize<'de> for CompactPercent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let percent = WholePercent::deserialize(deserializer)?.get();
        u8::try_from(percent)
            .ok()
            .filter(|percent| percent % 5 == 0)
            .map(Self)
            .ok_or_else(|| D::Error::custom("the percent is not on a step of five"))
    }
}

impl JsonSchema for CompactPercent {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "CompactPercent".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "integer", "minimum": 0, "maximum": 100, "multipleOf": 5 })
    }
}

/// The compaction threshold, in percent full, between the lowest bottom stop and the highest top
/// stop that provider's models report.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderAutoCompactBound {
    /// The threshold; it sits between `lowest` and `highest`.
    #[garde(custom(|value: &CompactPercent, _: &()| is_between_stops(*value, self)))]
    #[schemars(extend("allOf" = [{
        "type": "integer",
        "minimum": { "$data": "1/lowest" },
        "maximum": { "$data": "1/highest" },
    }]))]
    pub value: CompactPercent,
    /// The lowest bottom stop.
    pub lowest: WholePercent,
    /// The highest top stop.
    pub highest: WholePercent,
}

/// Whether `value` sits between the bound's stops.
fn is_between_stops(value: CompactPercent, bound: &ProviderAutoCompactBound) -> garde::Result {
    let value = i64::from(value.get());
    if value < bound.lowest.get() || value > bound.highest.get() {
        return Err(garde::Error::new(
            "the compaction bound sits between the lowest and the highest stop",
        ));
    }
    Ok(())
}

/// One output style the installed build lists, with its description (none on `default`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOutputStyle {
    /// The style's name.
    pub name: OutputStyleName,
    /// What the style does.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_OUTPUT_STYLE_DESCRIPTION_MAX_LEN>")]
    pub description: Option<FreeFormText<PROVIDER_OUTPUT_STYLE_DESCRIPTION_MAX_LEN>>,
}

/// Claude Code's output style: the one the build is on, among the build's own styles.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderOutputStyleSetting {
    /// The style the build is on; one of `styles`.
    #[garde(custom(|current: &OutputStyleName, _: &()| is_listed_style(current, &self.styles)))]
    pub current: OutputStyleName,
    /// The build's own styles.
    #[garde(length(min = 1, max = PROVIDER_OUTPUT_STYLES_MAX))]
    #[schemars(length(min = 1, max = PROVIDER_OUTPUT_STYLES_MAX))]
    #[schemars(extend("contains" = {
        "type": "object",
        "properties": { "name": { "const": { "$data": "3/current" } } },
    }))]
    pub styles: Vec<ProviderOutputStyle>,
}

/// Whether `current` names one of `styles`.
fn is_listed_style(current: &OutputStyleName, styles: &[ProviderOutputStyle]) -> garde::Result {
    if styles.iter().any(|style| style.name == *current) {
        return Ok(());
    }
    Err(garde::Error::new(
        "the current output style is one the installed build lists",
    ))
}

/// Declares [`ProviderSettings`] with the members every provider's section carries, then each
/// provider's own.
macro_rules! provider_settings {
    ($(
        $(#[doc = $doc:literal])+
        $provider:ident { $($own:tt)* }
    )+) => {
        /// One provider's section as `provider.list` reads it. `commandPath` is `null` while the
        /// person has typed none (auto-detect); `helpersAtOnce` is `null` for no limit and `0` for
        /// none; the compaction bound and the output style are `null` until the provider has been
        /// read. Each provider's section carries only its own settings.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "provider",
            rename_all = "lowercase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum ProviderSettings {$(
            $(#[doc = $doc])+
            $provider {
                /// What the provider check found.
                installation: ProviderInstallation,
                /// The path the person typed, or `null` for auto-detect.
                #[serde(deserialize_with = "crate::wire::nullable")]
                #[schemars(with = "crate::wire::NullableSchema<CommandPath>")]
                command_path: Option<CommandPath>,
                /// Whether a new session may use the provider.
                available_for_new_sessions: bool,
                /// How many helpers run at once: `null` for no limit, `0` for none.
                #[serde(deserialize_with = "crate::wire::nullable")]
                #[schemars(with = "crate::wire::NullableSchema<SafeInt<0>>")]
                helpers_at_once: Option<SafeInt<0>>,
                /// The compaction threshold, `null` until the provider has been read.
                #[serde(deserialize_with = "crate::wire::nullable")]
                #[schemars(with = "crate::wire::NullableSchema<ProviderAutoCompactBound>")]
                #[garde(dive)]
                auto_compact_percent: Option<ProviderAutoCompactBound>,
                $($own)*
            },
        )+}
    };
}

provider_settings! {
    /// Claude Code's section.
    Claude {
        /// The output style, `null` until the provider has been read.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<ProviderOutputStyleSetting>")]
        #[garde(dive)]
        output_style: Option<ProviderOutputStyleSetting>,
        /// Whether the app's plugin is in the person's own Claude Code.
        terminal_plugin_enabled: bool,
    }
    /// Codex's section.
    Codex {
        /// Whether terminal-started Codex sessions are reachable; the shared service runs while
        /// on.
        terminal_sessions_reachable: bool,
    }
}

/// The reply every `provider.*` change settles with: the section as the provider accepted it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSettingsResponse {
    /// The section.
    #[garde(dive)]
    pub settings: ProviderSettings,
}

/// A request naming one provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRequest {
    /// The provider.
    pub provider: ProviderName,
}

/// `provider.list` takes nothing: it reads every provider on this machine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProviderListRequest {}

/// Each provider's section, one row per provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderListResponse {
    /// The sections.
    #[garde(dive)]
    pub providers: Vec<ProviderSettings>,
}

/// The one setting a `provider.update` on Claude Code changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub enum ClaudeSettingUpdate {
    /// A new command path, or `null` to return to auto-detect.
    CommandPath(Option<CommandPath>),
    /// Whether a new session may use the provider.
    AvailableForNewSessions(bool),
    /// How many helpers run at once: `null` lifts the limit, `0` withholds the helper tool.
    HelpersAtOnce(Option<SafeInt<0>>),
    /// The compaction threshold.
    AutoCompactPercent(CompactPercent),
    /// The output style.
    OutputStyle(OutputStyleName),
}

/// The one setting a `provider.update` on Codex changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub enum CodexSettingUpdate {
    /// A new command path, or `null` to return to auto-detect.
    CommandPath(Option<CommandPath>),
    /// Whether a new session may use the provider.
    AvailableForNewSessions(bool),
    /// How many helpers run at once: `null` lifts the limit, `0` withholds the helper tool.
    HelpersAtOnce(Option<SafeInt<0>>),
    /// The compaction threshold.
    AutoCompactPercent(CompactPercent),
    /// Whether terminal-started sessions are reachable.
    TerminalSessionsReachable(bool),
}

/// One knob changed, one member per press, and only a knob the named provider has. A new path is
/// checked again where it now points and the provider's model catalog is read again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "provider", rename_all = "lowercase")]
pub enum ProviderUpdateRequest {
    /// A Claude Code setting.
    Claude(ClaudeSettingUpdate),
    /// A Codex setting.
    Codex(CodexSettingUpdate),
}

/// The provider whose terminal plugin is set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(inline)]
pub enum TerminalPluginProvider {
    /// The plugin is Claude Code's alone.
    Claude,
}

/// Put the app's terminal plugin into the person's own Claude Code, or take it out; off removes
/// exactly what on added and nothing the person added.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderTerminalPluginUpdateRequest {
    /// Always `claude`.
    pub provider: TerminalPluginProvider,
    /// Whether the plugin is in.
    pub enabled: bool,
}

/// One path an agent is refused on this provider, and where it came from: the credential files
/// the app always protects, or a deny rule the person set in the provider's own configuration.
/// Read-only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "source",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderProtectedPath {
    /// A credential file the app always protects.
    BuiltIn {
        /// The path pattern.
        pattern: RuleText,
    },
    /// A deny rule in the provider's global configuration.
    Global {
        /// The path pattern.
        pattern: RuleText,
        /// The file the rule sits in.
        source_path: RuleSourcePath,
    },
    /// A deny rule in a project's configuration.
    Project {
        /// The path pattern.
        pattern: RuleText,
        /// The file the rule sits in.
        source_path: RuleSourcePath,
        /// The project.
        repo_mount_id: RepoMountId,
    },
}

/// The paths one provider refuses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProtectedPathListResponse {
    /// The provider.
    pub provider: ProviderName,
    /// Its protected paths.
    pub entries: Vec<ProviderProtectedPath>,
}

branded_text! {
    /// The daemon-minted id of one standing rule, derived from where the rule sits and what it
    /// says.
    pub struct ProviderStandingRuleId(1..=PROVIDER_STANDING_RULE_ID_MAX_LEN);
}

/// Where a standing rule holds: one account's home, or one attached project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderStandingRuleScope {
    /// One account's home.
    AccountHome {
        /// The account.
        account_id: ProviderAccountId,
    },
    /// One attached project.
    Project {
        /// The project.
        repo_mount_id: RepoMountId,
    },
}

/// One standing rule in the provider's own words: `decision` is the provider's word for what the
/// rule does, and `text` the rule as its file holds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderStandingRule {
    /// The rule's id.
    pub rule_id: ProviderStandingRuleId,
    /// Where the rule holds.
    pub scope: ProviderStandingRuleScope,
    /// The file the rule sits in.
    pub source_path: RuleSourcePath,
    /// The provider's word for what the rule does.
    pub decision: FreeFormText<PROVIDER_RULE_DECISION_MAX_LEN>,
    /// The rule as its file holds it.
    pub text: RuleText,
}

/// One provider's standing rules on this machine; an empty list means it holds none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderStandingRuleListResponse {
    /// The provider.
    pub provider: ProviderName,
    /// Its rules.
    pub rules: Vec<ProviderStandingRule>,
}

/// Remove one standing rule where the provider keeps it; it applies from the next tool call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderStandingRuleRevokeRequest {
    /// The provider.
    pub provider: ProviderName,
    /// The rule.
    pub rule_id: ProviderStandingRuleId,
}

/// How a revoke settled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum ProviderStandingRuleRevokeOutcome {
    /// The rule was removed from its file.
    Revoked,
    /// The file no longer held it, so revoking twice settles the same way.
    AlreadyAbsent,
}

/// The reply of a revoke.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderStandingRuleRevokeResponse {
    /// The rule.
    pub rule_id: ProviderStandingRuleId,
    /// How the revoke settled.
    pub outcome: ProviderStandingRuleRevokeOutcome,
}

/// Where one provider's install has got to. The install runs the provider's own installer as the
/// person, keyed by provider, and the stream's first message is that provider's last outcome.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderInstallProgress {
    /// The installer runs.
    Running {
        /// The provider.
        provider: ProviderName,
    },
    /// The installer finished.
    Installed {
        /// The provider.
        provider: ProviderName,
    },
    /// The installer failed.
    Failed {
        /// The provider.
        provider: ProviderName,
        /// The installer's last lines, credentials removed.
        reason: FreeFormText<PROVIDER_INSTALL_FAILURE_REASON_MAX_LEN>,
        /// The installer command, for the person to run.
        command: FreeFormText<PROVIDER_INSTALL_COMMAND_MAX_LEN>,
    },
}

methods! {
    /// Every `provider.*` method: its name, how it answers, and its shapes.
    pub const PROVIDER_METHOD_DESCRIPTORS = [
        /// Reads every provider's section.
        ProviderList = query "provider.list" {
            mutating: false,
            params: ProviderListRequest,
            result: ProviderListResponse,
            refusals: [],
        },
        /// Changes one setting.
        ProviderUpdate = mutation "provider.update" {
            mutating: true,
            params: ProviderUpdateRequest,
            result: ProviderSettingsResponse,
            refusals: [ProviderNotInstalled, ProviderCommandNotRunnable],
        },
        /// Checks the provider's command again.
        ProviderProbe = mutation "provider.probe" {
            mutating: true,
            params: ProviderRequest,
            result: ProviderSettingsResponse,
            refusals: [],
        },
        /// Puts the terminal plugin in or takes it out.
        ProviderTerminalPluginUpdate = mutation "provider.terminalPluginUpdate" {
            mutating: true,
            params: ProviderTerminalPluginUpdateRequest,
            result: ProviderSettingsResponse,
            refusals: [ProviderNotInstalled],
        },
        /// Lists the paths a provider refuses.
        ProviderProtectedPathList = query "provider.protectedPathList" {
            mutating: false,
            params: ProviderRequest,
            result: ProviderProtectedPathListResponse,
            refusals: [],
        },
        /// Lists a provider's standing rules.
        ProviderStandingRuleList = query "provider.standingRuleList" {
            mutating: false,
            params: ProviderRequest,
            result: ProviderStandingRuleListResponse,
            refusals: [],
        },
        /// Revokes one standing rule.
        ProviderStandingRuleRevoke = mutation "provider.standingRuleRevoke" {
            mutating: true,
            params: ProviderStandingRuleRevokeRequest,
            result: ProviderStandingRuleRevokeResponse,
            refusals: [],
        },
        /// Starts a provider's installer.
        ProviderInstall = mutation "provider.install" {
            mutating: true,
            params: ProviderRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Streams a provider's install, its last outcome first.
        ProviderInstallSubscribe = subscription "provider.installSubscribe" {
            mutating: false,
            params: ProviderRequest,
            result: SubscribeAckResponse,
            emission: ProviderInstallProgress,
            refusals: [],
        },
        /// Stops a provider's installer and everything it started.
        ProviderInstallStop = mutation "provider.installStop" {
            mutating: true,
            params: ProviderRequest,
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the provider settings.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/settings",
    doc: "The `provider.*` methods: each provider's own settings on this machine, apart from its \
          accounts.",
    definitions: &[
        Definition::read::<ProviderInstallation>().checked(),
        Definition::read::<ProviderAutoCompactBound>().checked(),
        Definition::read::<ProviderOutputStyle>(),
        Definition::read::<ProviderOutputStyleSetting>().checked(),
        Definition::read::<ProviderSettings>().checked(),
        Definition::read::<ProviderSettingsResponse>(),
        Definition::read::<ProviderRequest>(),
        Definition::read::<ProviderListRequest>(),
        Definition::read::<ProviderListResponse>(),
        Definition::read::<ProviderUpdateRequest>(),
        Definition::read::<ProviderTerminalPluginUpdateRequest>(),
        Definition::read::<ProviderProtectedPath>(),
        Definition::read::<ProviderProtectedPathListResponse>(),
        Definition::read::<ProviderStandingRuleId>(),
        Definition::read::<ProviderStandingRuleScope>(),
        Definition::read::<ProviderStandingRule>(),
        Definition::read::<ProviderStandingRuleListResponse>(),
        Definition::read::<ProviderStandingRuleRevokeRequest>(),
        Definition::read::<ProviderStandingRuleRevokeResponse>(),
        Definition::read::<ProviderInstallProgress>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PROVIDER_METHOD_DESCRIPTORS],
};
