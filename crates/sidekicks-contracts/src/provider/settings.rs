//! The `provider.*` methods: each provider's section on this machine, apart from its accounts: the
//! fixed facts its driver declares, the rows every provider offers, and the rows and session
//! options its driver declares. Every figure a row is bounded by comes from the provider, the
//! compaction stops from its own models. The standing rules are read from and revoked in the
//! provider's own files, and the daemon keeps no copy.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::refusal::RefusalCode;
use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::machine::settings::ENVIRONMENT_ROW_MAX_LEN;
use crate::mcp::server::config::ProviderMcpDeclaration;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::place::{Place, WslPlace};
use crate::provider::account::record::{PROVIDER_ACCOUNT_PLAN_MAX_LEN, ProviderAccountId};
use crate::provider::declaration::{
    ProviderDeclarationId, ProviderDeclarationText, ProviderRow, ProviderSessionOption,
    ProviderValue,
};
use crate::provider::driver::methods::PROVIDER_WIRE_TOKEN_MAX_LEN;
use crate::provider::id::ProviderId;
use crate::repo::mount::RepoMountId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::voice::VoiceKind;
use crate::wire::True;
use crate::wire::instant::WireInstant;
use crate::wire::integer::{BoundedInt, SafeInt};
use crate::wire::list::{ListKey, UniqueList};
use crate::wire::text::{FreeFormText, branded_text};

ts_constants! {
    /// The longest provider command version, as the command prints it, in code points; the
    /// provider crate stores and checks a printed version within the same bound.
    pub const PROVIDER_VERSION_MAX_LEN: usize = 128;
    /// The longest protected-path pattern or standing rule text.
    pub const PROVIDER_RULE_TEXT_MAX_LEN: usize = 4096;
    /// The longest standing rule decision word.
    pub const PROVIDER_RULE_DECISION_MAX_LEN: usize = 64;
    /// The longest standing rule id.
    pub const PROVIDER_STANDING_RULE_ID_MAX_LEN: usize = 256;
    /// The provider's command is not installed, so a setting that needs it cannot be turned on:
    /// availability for new sessions, a declared row that runs the command, and the terminal
    /// plugin.
    PROVIDER_NOT_INSTALLED_CODE = RefusalCode::ProviderNotInstalled;
    /// Nothing runnable sits at the command path the person typed.
    PROVIDER_COMMAND_PATH_NOT_RUNNABLE_CODE = RefusalCode::ProviderCommandPathNotRunnable;
}

/// The provider version as its command printed it.
pub type ProviderVersion = FreeFormText<PROVIDER_VERSION_MAX_LEN>;
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

impl ListKey for ProviderPlaceReading {
    type Key = Option<Place>;

    fn list_key(&self) -> Option<Place> {
        self.place.clone()
    }

    fn validate_item(&self, parent: &mut dyn FnMut() -> garde::Path, report: &mut garde::Report) {
        garde::Validate::validate_into(self, &(), parent, report);
    }
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

/// One plan id the provider sends and the word a person reads it as. A plan id the provider lists
/// no word for reads as its own words in sentence case.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPlanWord {
    /// The plan id as the provider sends it.
    pub plan: FreeFormText<PROVIDER_ACCOUNT_PLAN_MAX_LEN>,
    /// The word a person reads.
    pub word: ProviderDeclarationText,
}

impl ListKey for ProviderPlanWord {
    type Key = FreeFormText<PROVIDER_ACCOUNT_PLAN_MAX_LEN>;

    fn list_key(&self) -> FreeFormText<PROVIDER_ACCOUNT_PLAN_MAX_LEN> {
        self.plan.clone()
    }

    // It carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// One tool the provider has built in, which the tool allowlist picker offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderBuiltInTool {
    /// The tool's name in the provider's own spelling, as an allowlist names it.
    pub name: FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>,
    /// The words the picker draws it in.
    pub label: ProviderDeclarationText,
}

impl ListKey for ProviderBuiltInTool {
    type Key = FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>;

    fn list_key(&self) -> FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN> {
        self.name.clone()
    }

    // It carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// One provider's section as `provider.list` reads it, one per registered driver: the fixed facts
/// its driver declares, the rows every provider offers, and the rows and session options its driver
/// declares with their live values. `helpersAtOnce` is `null` for no limit and `0` for none; the
/// compaction bound is `null` until the provider has been read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderSection {
    /// The provider.
    pub provider: ProviderId,
    /// The provider's name as a person reads it.
    pub name: ProviderDeclarationText,
    /// The words its plan ids read as, unique by plan id; may be empty.
    #[garde(dive)]
    pub plan_words: UniqueList<ProviderPlanWord, 0, { usize::MAX }>,
    /// Its built-in tools in its own order, unique by name; may be empty.
    #[garde(dive)]
    pub built_in_tools: UniqueList<ProviderBuiltInTool, 0, { usize::MAX }>,
    /// The environment names the app sets on this provider's processes and its Terminal pane's
    /// shells, which a person's own environment row may not take; unique, may be empty.
    #[garde(dive)]
    pub app_set_environment_names:
        UniqueList<FreeFormText<ENVIRONMENT_ROW_MAX_LEN>, 0, { usize::MAX }>,
    /// The transports and declaration members its tool servers take.
    #[garde(dive)]
    pub mcp: ProviderMcpDeclaration,
    /// The most characters it takes in a skill's name, or `null` where it sets no limit of its
    /// own below the shared one.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<SafeInt<1>>")]
    pub skill_name_max_length: Option<SafeInt<1>>,
    /// The voice kinds it offers, each at most once: the composer starts `voice.dictation.start`
    /// for dictation and `voice.call.start` for a call; empty where it offers none.
    #[garde(dive)]
    pub voice_kinds: UniqueList<VoiceKind, 0, { usize::MAX }>,
    /// The output-speed levels every one of its models offers, present only where the provider
    /// publishes none per model.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>")]
    pub output_speed_levels: Option<Vec<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>>,
    /// The command's reading in each place.
    #[garde(dive)]
    pub places: UniqueList<ProviderPlaceReading, 1, { usize::MAX }>,
    /// Whether a new session may use the provider.
    pub available_for_new_sessions: bool,
    /// How many helpers run at once: `null` for no limit, `0` for none.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<SafeInt<0>>")]
    pub helpers_at_once: Option<SafeInt<0>>,
    /// The compaction threshold, `null` until the provider has been read.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<ProviderAutoCompactBound>")]
    #[garde(dive)]
    pub auto_compact_percent: Option<ProviderAutoCompactBound>,
    /// The rows its driver declares with their live values, in the driver's order; may be empty.
    #[garde(dive)]
    pub rows: UniqueList<ProviderRow, 0, { usize::MAX }>,
    /// The options its driver declares on its sessions; may be empty.
    #[garde(dive)]
    pub session_options: UniqueList<ProviderSessionOption, 0, { usize::MAX }>,
}

/// The reply every `provider.*` change settles with, and each `provider.subscribe` delivery: one
/// provider's whole section as it now stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSettingsResponse {
    /// The section.
    #[garde(dive)]
    pub settings: ProviderSection,
    /// The WSL 2 distributions that are stopped, whose rows show their last reading; a check
    /// there starts the distribution. Absent while none is stopped.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "UniqueList<WslPlace, 1, { usize::MAX }>")]
    #[garde(dive)]
    pub stopped_distributions: Option<UniqueList<WslPlace, 1, { usize::MAX }>>,
}

/// A request naming one provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderRequest {
    /// The provider.
    pub provider: ProviderId,
}

/// A request naming one provider in one place: a check, an install or an update of its command
/// there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderPlaceRequest {
    /// The provider.
    pub provider: ProviderId,
    /// The place: absent on a computer without a WSL 2 distribution and present on one with. On
    /// Windows, `"windows"` names Windows and a distribution is refused by its name, whether or not
    /// a WSL 2 distribution remains; a place on macOS or Linux is refused with
    /// `provider.place.notOffered`, and none where a WSL 2 distribution is with
    /// `provider.place.required`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
}

/// Each provider's section, in the order the daemon's provider table lists them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderListResponse {
    /// The sections.
    #[garde(dive)]
    pub providers: Vec<ProviderSection>,
    /// The WSL 2 distributions that are stopped, whose rows show their last reading; a check
    /// there starts the distribution. Absent while none is stopped.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "UniqueList<WslPlace, 1, { usize::MAX }>")]
    #[garde(dive)]
    pub stopped_distributions: Option<UniqueList<WslPlace, 1, { usize::MAX }>>,
}

/// One setting changed, one member per press: a row every provider offers, one the provider's
/// driver declares, whose value the daemon holds to the row's declaration
/// ([`ProviderRow::check_value`]), or the run or stop of a declared action row. A new command path
/// is checked again where it now points and the provider's model catalog is read again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged, rename_all_fields = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub enum ProviderUpdateRequest {
    /// A new command path for one place, or `null` to return it to auto-detect.
    CommandPath {
        /// The provider.
        provider: ProviderId,
        /// The place: absent on a computer without a WSL 2 distribution and present on one with.
        /// On Windows, `"windows"` names Windows and a distribution is refused by its name,
        /// whether or not a WSL 2 distribution remains; a place on macOS or Linux is refused with
        /// `provider.place.notOffered`, and none where a WSL 2 distribution is with
        /// `provider.place.required`.
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
    AvailableForNewSessions {
        /// The provider.
        provider: ProviderId,
        /// Whether it may.
        available_for_new_sessions: bool,
    },
    /// How many helpers run at once: `null` lifts the limit, `0` withholds the helper tool.
    HelpersAtOnce {
        /// The provider.
        provider: ProviderId,
        /// The limit, or `null` for none.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<SafeInt<0>>")]
        helpers_at_once: Option<SafeInt<0>>,
    },
    /// The compaction threshold.
    AutoCompactPercent {
        /// The provider.
        provider: ProviderId,
        /// The threshold.
        auto_compact_percent: CompactPercent,
    },
    /// A new value for one setting row the provider's driver declares.
    DeclaredRow {
        /// The provider.
        provider: ProviderId,
        /// The row.
        row_id: ProviderDeclarationId,
        /// The place of a per-place switch row: absent on a computer without a WSL 2 distribution
        /// and present on one with. On Windows, `"windows"` names Windows and a distribution is
        /// refused by its name, whether or not a WSL 2 distribution remains; a place on macOS or
        /// Linux is refused with `provider.place.notOffered`, and none where a WSL 2 distribution
        /// is with `provider.place.required`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Place")]
        place: Option<Place>,
        /// The value, or `null` for none where the row takes none.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<ProviderValue>")]
        value: Option<ProviderValue>,
    },
    /// Runs one action row the provider's driver declares in one place: `enabled` does the action
    /// there, and off undoes it. Its progress is read on the row.
    ActionRun {
        /// The provider.
        provider: ProviderId,
        /// The action row.
        row_id: ProviderDeclarationId,
        /// The place, as on a per-place switch row.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Place")]
        place: Option<Place>,
        /// Whether the action is to be done there, not undone.
        enabled: bool,
    },
    /// Stops the run of one action row in one place, refused where the row is not running there
    /// or its progress says it cannot stop.
    ActionStop {
        /// The provider.
        provider: ProviderId,
        /// The action row.
        row_id: ProviderDeclarationId,
        /// The place, as on a per-place switch row.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Place")]
        place: Option<Place>,
        /// Always `true`: the member that marks a stop.
        stop: True,
    },
}

/// Put the app's terminal plugin into the person's own provider install in one place, or take it
/// out, through the provider's own commands; off removes exactly what on added and nothing the
/// person added. A provider whose driver offers no terminal plugin is refused with
/// `provider.capability.unsupported`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderTerminalPluginUpdateRequest {
    /// The provider.
    pub provider: ProviderId,
    /// The place: absent on a computer without a WSL 2 distribution and present on one with. On
    /// Windows, `"windows"` names Windows and a distribution is refused by its name, whether or not
    /// a WSL 2 distribution remains; a place on macOS or Linux is refused with
    /// `provider.place.notOffered`, and none where a WSL 2 distribution is with
    /// `provider.place.required`.
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
        /// Where the rule's file is, the file's path in that place's form; absent on a computer
        /// without a WSL 2 distribution.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Place")]
        place: Option<Place>,
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
    pub provider: ProviderId,
    /// Its protected paths.
    pub entries: Vec<ProviderProtectedPath>,
}

branded_text! {
    /// The daemon-minted id of one standing rule, derived from the rule's place, its file and its
    /// text, so one file path in two places names two rules.
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
    pub provider: ProviderId,
    /// Its rules.
    pub rules: Vec<ProviderStandingRule>,
}

/// Remove one standing rule where the provider keeps it; it applies from the next tool call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderStandingRuleRevokeRequest {
    /// The provider.
    pub provider: ProviderId,
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
        /// Streams each provider's section: first every section in the provider table's order,
        /// then one provider's whole section after any change to it.
        ProviderSubscribe = subscription "provider.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAcknowledgmentResponse,
            emission: ProviderSettingsResponse,
            refusals: [],
        },
        /// Changes one setting.
        ProviderUpdate = mutation "provider.update" {
            mutating: true,
            params: ProviderUpdateRequest,
            result: ProviderSettingsResponse,
            refusals: [
                ProviderNotFound,
                ProviderPlaceRequired,
                ProviderPlaceNotOffered,
                ProviderUnavailable,
                ProviderNotInstalled,
                ProviderCommandPathNotRunnable,
                ProviderDistributionNotFound,
                ProviderDistributionNeedsWsl2,
                ProviderRowNotFound,
                ProviderRowValueInvalid,
                ProviderRowNotRunning,
                ProviderRowNotStoppable,
            ],
        },
        /// Checks the provider's command again.
        ProviderProbe = mutation "provider.probe" {
            mutating: true,
            params: ProviderPlaceRequest,
            result: ProviderSettingsResponse,
            refusals: [
                ProviderNotFound,
                ProviderPlaceRequired,
                ProviderPlaceNotOffered,
                ProviderDistributionNotFound,
                ProviderDistributionNeedsWsl2,
            ],
        },
        /// Puts the terminal plugin in or takes it out.
        ProviderTerminalPluginUpdate = mutation "provider.terminalPlugin.update" {
            mutating: true,
            params: ProviderTerminalPluginUpdateRequest,
            result: ProviderSettingsResponse,
            refusals: [
                ProviderNotFound,
                ProviderPlaceRequired,
                ProviderPlaceNotOffered,
                ProviderNotInstalled,
                ProviderDistributionNotFound,
                ProviderDistributionNeedsWsl2,
                ProviderCapabilityUnsupported,
            ],
        },
        /// Lists the paths a provider refuses.
        ProviderProtectedPathList = query "provider.protectedPath.list" {
            mutating: false,
            params: ProviderRequest,
            result: ProviderProtectedPathListResponse,
            refusals: [ProviderNotFound],
        },
        /// Lists a provider's standing rules.
        ProviderStandingRuleList = query "provider.standingRule.list" {
            mutating: false,
            params: ProviderRequest,
            result: ProviderStandingRuleListResponse,
            refusals: [ProviderNotFound],
        },
        /// Revokes one standing rule.
        ProviderStandingRuleRevoke = mutation "provider.standingRule.revoke" {
            mutating: true,
            params: ProviderStandingRuleRevokeRequest,
            result: ProviderStandingRuleRevokeResponse,
            refusals: [ProviderNotFound],
        },
    ];
}

/// The TypeScript module of the provider settings.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/settings",
    doc: "The provider settings methods: each provider's section on this machine, its driver's \
          fixed facts, shared rows and declared rows, apart from its accounts, installs and \
          imports.",
    definitions: &[
        Definition::read::<ProviderInstallation>().checked(),
        Definition::read::<ProviderPlaceReading>().checked(),
        Definition::read::<ProviderAutoCompactBound>().checked(),
        Definition::read::<ProviderPlanWord>(),
        Definition::read::<ProviderBuiltInTool>(),
        Definition::read::<ProviderSection>().checked(),
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
    #[case::path_to_auto_detect(r#"{"provider":"claude","commandPath":null}"#, true)]
    #[case::helpers_lifted(r#"{"provider":"codex","helpersAtOnce":null}"#, true)]
    #[case::declared_choice(
        r#"{"provider":"claude","rowId":"outputStyle","value":"Explanatory"}"#,
        true
    )]
    #[case::declared_switch_in_a_distribution(
        r#"{"provider":"codex","rowId":"reachable","place":{"distro":"Ubuntu"},"value":true}"#,
        true
    )]
    #[case::declared_row_to_none(r#"{"provider":"claude","rowId":"advisor","value":null}"#, true)]
    #[case::declared_row_without_value(r#"{"provider":"claude","rowId":"advisor"}"#, false)]
    #[case::declared_row_with_a_bad_id(
        r#"{"provider":"claude","rowId":"Advisor","value":true}"#,
        false
    )]
    #[case::declared_row_with_an_object(
        r#"{"provider":"claude","rowId":"advisor","value":{}}"#,
        false
    )]
    #[case::no_knob(r#"{"provider":"claude"}"#, false)]
    #[case::two_knobs(
        r#"{"provider":"claude","commandPath":null,"availableForNewSessions":true}"#,
        false
    )]
    #[case::a_knob_beside_a_row(
        r#"{"provider":"codex","rowId":"voice","value":"alloy","helpersAtOnce":2}"#,
        false
    )]
    #[case::null_on_a_plain_knob(r#"{"provider":"claude","availableForNewSessions":null}"#, false)]
    #[case::off_step_percent(r#"{"provider":"codex","autoCompactPercent":42}"#, false)]
    #[case::no_provider(r#"{"commandPath":null}"#, false)]
    #[case::action_run(
        r#"{"provider":"codex","rowId":"terminalPlugin","place":"windows","enabled":true}"#,
        true
    )]
    #[case::action_stop(r#"{"provider":"codex","rowId":"terminalPlugin","stop":true}"#, true)]
    #[case::action_stop_marked_false(
        r#"{"provider":"codex","rowId":"terminalPlugin","stop":false}"#,
        false
    )]
    #[case::action_run_beside_a_value(
        r#"{"provider":"codex","rowId":"terminalPlugin","enabled":true,"value":true}"#,
        false
    )]
    #[case::place_on_a_machine_wide_knob(
        r#"{"provider":"claude","place":"windows","availableForNewSessions":true}"#,
        false
    )]
    fn takes_exactly_one_setting_per_press(#[case] request: &str, #[case] is_taken: bool) {
        let parsed = parse_received::<ProviderUpdateRequest>(request.as_bytes(), Vec::new());
        assert_eq!(parsed.is_ok(), is_taken, "{request}: {parsed:?}");
        if let Ok(parsed) = parsed {
            let written = serde_json::to_value(&parsed).expect("an update request serializes");
            let sent: serde_json::Value = serde_json::from_str(request).expect("the case is JSON");
            assert_eq!(written, sent, "an accepted update writes back as sent");
        }
    }
}
