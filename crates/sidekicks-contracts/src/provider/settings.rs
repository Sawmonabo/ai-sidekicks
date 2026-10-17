//! The `provider.*` methods: each provider's own settings on this machine, apart from its accounts.
//! Every figure a knob is bounded by comes from the provider: the compaction stops from its own
//! models, the output styles from the installed build's own listing. The standing rules are read
//! from and revoked in the provider's own files, and the daemon keeps no copy.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::refusal::RefusalCode;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::place::{Place, WslPlace};
use crate::provider::account::record::ProviderAccountId;
use crate::provider::name::{ClaudeProviderWord, CodexProviderWord, ProviderName};
use crate::repo::mount::RepoMountId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{BoundedInt, SafeInt};
use crate::wire::list::BoundedVec;
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
    /// The provider's command is not installed, so a setting that needs it cannot be turned on:
    /// availability for new sessions, the shared terminal service and the terminal plugin.
    PROVIDER_NOT_INSTALLED_CODE = RefusalCode::ProviderNotInstalled;
    /// Nothing runnable sits at the command path the person typed.
    PROVIDER_COMMAND_NOT_RUNNABLE_CODE = RefusalCode::ProviderCommandNotRunnable;
}

/// The provider version as its command printed it.
pub(crate) type ProviderVersion = FreeFormText<PROVIDER_VERSION_MAX_LEN>;
/// An output style's name.
type OutputStyleName = FreeFormText<PROVIDER_OUTPUT_STYLE_NAME_MAX_LEN>;
/// A protected-path pattern or a standing rule's text.
type RuleText = FreeFormText<PROVIDER_RULE_TEXT_MAX_LEN>;
/// A whole percent.
type WholePercent = BoundedInt<0, 100>;

/// What the provider check found where the command resolves. `indeterminate` is a check that
/// could not settle and is never folded into another arm; `noBuildForSystem` and
/// `distributionNeedsWsl2` are rows no check runs on and no install offers.
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
        /// The newer build the provider's latest-version marker names, drawn as `Update
        /// available`; absent while the command resolves to the latest build.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderVersion")]
        latest_version: Option<ProviderVersion>,
    },
    /// Nothing runnable.
    NotInstalled {},
    /// A check that could not settle.
    Indeterminate {},
    /// The provider's descriptor declares no build for the place's system family, so nothing can
    /// be installed there.
    NoBuildForSystem {},
    /// The place is a WSL 1 distribution, where no session runs; the row has no command field.
    DistributionNeedsWsl2 {},
}

/// One place's `Command` row: where the provider's command is read, what the last check there
/// found and when, and the path the person typed for that place. A computer without a WSL 2
/// distribution has one row and names no place. With one, the rows run Windows first, then each
/// distribution in WSL's list order with WSL's default first, a WSL 1 distribution among them;
/// distributions other tools keep for themselves (`docker-desktop*`, `rancher-desktop*`) are never
/// listed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderPlaceReading {
    /// The place; absent on a computer without a WSL 2 distribution.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// What the last check there found, `null` until the place has been checked.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<ProviderInstallation>")]
    pub installation: Option<ProviderInstallation>,
    /// The path the person typed for the place, or `null` for auto-detect.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<FilesystemPath>")]
    pub command_path: Option<FilesystemPath>,
    /// When the place was last checked, `null` until it has been.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<WireInstant>")]
    #[garde(dive)]
    pub checked_at: Option<WireInstant>,
}

/// One place's on-or-off for a provider's per-place switch. A computer without a WSL 2
/// distribution has one entry and names no place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPlaceSwitch {
    /// The place; absent on a computer without a WSL 2 distribution.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// Whether the switch is on there.
    pub enabled: bool,
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
    #[garde(custom(|value: &CompactPercent, (): &()| is_between_stops(*value, self)))]
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
    #[garde(custom(|current: &OutputStyleName, (): &()| is_listed_style(current, &self.styles)))]
    pub current: OutputStyleName,
    /// The build's own styles.
    #[schemars(extend("contains" = {
        "type": "object",
        "properties": { "name": { "const": { "$data": "3/current" } } },
    }))]
    pub styles: OutputStyles,
}

/// The output styles one build lists.
type OutputStyles = BoundedVec<ProviderOutputStyle, 1, PROVIDER_OUTPUT_STYLES_MAX>;

/// Whether `current` names one of `styles`.
fn is_listed_style(current: &OutputStyleName, styles: &OutputStyles) -> garde::Result {
    if styles.as_slice().iter().any(|style| style.name == *current) {
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
        /// One provider's section as `provider.list` reads it: one `Command` row per place, Windows
        /// first and then each distribution in WSL's list order on a Windows computer with a WSL 2
        /// distribution, else a single row; `helpersAtOnce` is `null` for no limit and `0` for none; the compaction bound and
        /// the output style are `null` until the provider has been read. Each provider's section
        /// carries only its own settings.
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
                /// The command's reading in each place.
                #[garde(dive)]
                places: BoundedVec<ProviderPlaceReading, 1, { usize::MAX }>,
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
        /// Whether the app's plugin is in the person's own Claude Code, in each place.
        terminal_plugin_enabled: BoundedVec<ProviderPlaceSwitch, 1, { usize::MAX }>,
    }
    /// Codex's section.
    Codex {
        /// Whether terminal-started Codex sessions are reachable, in each place; each place's
        /// shared service runs while on.
        terminal_sessions_reachable: BoundedVec<ProviderPlaceSwitch, 1, { usize::MAX }>,
    }
}

/// The reply every `provider.*` change settles with: the section as the provider accepted it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSettingsResponse {
    /// The section.
    #[garde(dive)]
    pub settings: ProviderSettings,
    /// The WSL 2 distributions that are stopped, whose rows show their last reading; a check
    /// there starts the distribution. Absent while none is stopped.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BoundedVec<WslPlace, 1, { usize::MAX }>")]
    #[garde(skip)]
    pub stopped_distributions: Option<BoundedVec<WslPlace, 1, { usize::MAX }>>,
}

/// A request naming one provider.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderRequest {
    /// The provider.
    pub provider: ProviderName,
}

/// A request naming one provider in one place: a check, an install or an update of its command
/// there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderPlaceRequest {
    /// The provider.
    pub provider: ProviderName,
    /// The place; absent on a computer without a WSL 2 distribution.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
}

/// Each provider's section, one row per provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderListResponse {
    /// The sections.
    #[garde(dive)]
    pub providers: Vec<ProviderSettings>,
    /// The WSL 2 distributions that are stopped, whose rows show their last reading; a check
    /// there starts the distribution. Absent while none is stopped.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BoundedVec<WslPlace, 1, { usize::MAX }>")]
    #[garde(skip)]
    pub stopped_distributions: Option<BoundedVec<WslPlace, 1, { usize::MAX }>>,
}

/// Declares [`ProviderUpdateRequest`]: per provider, one closed arm for each knob every provider
/// has and then its own arms, each arm the provider's word and the knob's one member.
macro_rules! provider_update_request {
    ($(
        $provider:ty => [$command_path:ident, $available:ident, $helpers:ident, $compact:ident]
        { $($own:tt)* }
    )+) => {
        /// One knob changed, one member per press, and only a knob the named provider has. A new
        /// path is checked again where it now points and the provider's model catalog is read
        /// again.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(untagged, rename_all_fields = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub enum ProviderUpdateRequest {$(
            /// A new command path for one place, or `null` to return it to auto-detect.
            $command_path {
                /// The provider.
                provider: $provider,
                /// The place; absent on a computer without a WSL 2 distribution.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Place")]
                place: Option<Place>,
                /// The path, or `null` for auto-detect.
                #[serde(deserialize_with = "crate::wire::nullable")]
                #[schemars(with = "crate::wire::NullableSchema<FilesystemPath>")]
                command_path: Option<FilesystemPath>,
            },
            /// Whether a new session may use the provider.
            $available {
                /// The provider.
                provider: $provider,
                /// Whether it may.
                available_for_new_sessions: bool,
            },
            /// How many helpers run at once: `null` lifts the limit, `0` withholds the helper tool.
            $helpers {
                /// The provider.
                provider: $provider,
                /// The limit, or `null` for none.
                #[serde(deserialize_with = "crate::wire::nullable")]
                #[schemars(with = "crate::wire::NullableSchema<SafeInt<0>>")]
                helpers_at_once: Option<SafeInt<0>>,
            },
            /// The compaction threshold.
            $compact {
                /// The provider.
                provider: $provider,
                /// The threshold.
                auto_compact_percent: CompactPercent,
            },
            $($own)*
        )+}
    };
}

provider_update_request! {
    ClaudeProviderWord => [
        ClaudeCommandPath,
        ClaudeAvailableForNewSessions,
        ClaudeHelpersAtOnce,
        ClaudeAutoCompactPercent
    ] {
        /// Claude Code's output style.
        ClaudeOutputStyle {
            /// The provider.
            provider: ClaudeProviderWord,
            /// The style, one the installed build lists.
            output_style: OutputStyleName,
        },
    }
    CodexProviderWord => [
        CodexCommandPath,
        CodexAvailableForNewSessions,
        CodexHelpersAtOnce,
        CodexAutoCompactPercent
    ] {
        /// Whether terminal-started Codex sessions are reachable in one place.
        CodexTerminalSessionsReachable {
            /// The provider.
            provider: CodexProviderWord,
            /// The place; absent on a computer without a WSL 2 distribution.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Place")]
            place: Option<Place>,
            /// Whether they are.
            terminal_sessions_reachable: bool,
        },
    }
}

/// Put the app's terminal plugin into the person's own Claude Code in one place, or take it out;
/// off removes exactly what on added and nothing the person added.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderTerminalPluginUpdateRequest {
    /// Always `claude`: the plugin is Claude Code's alone.
    pub provider: ClaudeProviderWord,
    /// The place; absent on a computer without a WSL 2 distribution.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
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
        source_path: FilesystemPath,
    },
    /// A deny rule in a project's configuration.
    Project {
        /// The path pattern.
        pattern: RuleText,
        /// The file the rule sits in.
        source_path: FilesystemPath,
        /// The project.
        repo_mount_id: RepoMountId,
    },
}

/// The paths one provider refuses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
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
    /// Where the rule's file is, the file's path in that place's form; absent on a computer
    /// without a WSL 2 distribution.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// The file the rule sits in.
    pub source_path: FilesystemPath,
    /// The provider's word for what the rule does.
    pub decision: FreeFormText<PROVIDER_RULE_DECISION_MAX_LEN>,
    /// The rule as its file holds it.
    pub text: RuleText,
}

/// One provider's standing rules on this machine, from every account home in every place and
/// every attached project; an empty list means it holds none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderStandingRuleListResponse {
    /// The provider.
    pub provider: ProviderName,
    /// Its rules.
    pub rules: Vec<ProviderStandingRule>,
}

/// Remove one standing rule where the provider keeps it; it applies from the next tool call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderStandingRuleRevokeResponse {
    /// The rule.
    pub rule_id: ProviderStandingRuleId,
    /// How the revoke settled.
    pub outcome: ProviderStandingRuleRevokeOutcome,
}

methods! {
    /// Every provider settings method: its name, how it answers, and its shapes.
    pub const PROVIDER_METHOD_DESCRIPTORS = [
        /// Reads every provider's section.
        ProviderList = query "provider.list" {
            mutating: false,
            params: EmptyPayload,
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
            params: ProviderPlaceRequest,
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
    ];
}

/// The TypeScript module of the provider settings.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/settings",
    doc: "The provider settings methods: each provider's own settings on this machine, apart from \
          its accounts, installs and imports.",
    definitions: &[
        Definition::read::<ProviderInstallation>().checked(),
        Definition::read::<ProviderPlaceReading>().checked(),
        Definition::read::<ProviderPlaceSwitch>(),
        Definition::read::<ProviderAutoCompactBound>().checked(),
        Definition::read::<ProviderOutputStyle>(),
        Definition::read::<ProviderOutputStyleSetting>().checked(),
        Definition::read::<ProviderSettings>().checked(),
        Definition::read::<ProviderSettingsResponse>(),
        Definition::read::<ProviderRequest>(),
        Definition::read::<ProviderPlaceRequest>(),
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
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PROVIDER_METHOD_DESCRIPTORS],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::ProviderUpdateRequest;
    use crate::wire::attachment::parse_received;

    #[rstest]
    #[case::claude_path_to_auto_detect(r#"{"provider":"claude","commandPath":null}"#, true)]
    #[case::codex_helpers_lifted(r#"{"provider":"codex","helpersAtOnce":null}"#, true)]
    #[case::claude_style(r#"{"provider":"claude","outputStyle":"Explanatory"}"#, true)]
    #[case::codex_reachable(r#"{"provider":"codex","terminalSessionsReachable":true}"#, true)]
    #[case::no_knob(r#"{"provider":"claude"}"#, false)]
    #[case::two_knobs(
        r#"{"provider":"claude","commandPath":null,"availableForNewSessions":true}"#,
        false
    )]
    #[case::codex_style(r#"{"provider":"codex","outputStyle":"Explanatory"}"#, false)]
    #[case::claude_reachable(r#"{"provider":"claude","terminalSessionsReachable":true}"#, false)]
    #[case::null_on_a_plain_knob(r#"{"provider":"claude","availableForNewSessions":null}"#, false)]
    #[case::off_step_percent(r#"{"provider":"codex","autoCompactPercent":42}"#, false)]
    #[case::no_provider(r#"{"commandPath":null}"#, false)]
    #[case::codex_reachable_in_a_distribution(
        r#"{"provider":"codex","place":{"distro":"Ubuntu"},"terminalSessionsReachable":true}"#,
        true
    )]
    #[case::place_on_a_machine_wide_knob(
        r#"{"provider":"claude","place":"windows","availableForNewSessions":true}"#,
        false
    )]
    fn takes_exactly_one_knob_the_named_provider_has(
        #[case] request: &str,
        #[case] is_taken: bool,
    ) {
        let parsed = parse_received::<ProviderUpdateRequest>(request.as_bytes(), Vec::new());
        assert_eq!(parsed.is_ok(), is_taken, "{request}: {parsed:?}");
        if let Ok(parsed) = parsed {
            let written = serde_json::to_value(&parsed).expect("an update request serializes");
            let sent: serde_json::Value = serde_json::from_str(request).expect("the case is JSON");
            assert_eq!(written, sent, "an accepted update writes back as sent");
        }
    }
}
