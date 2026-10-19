//! The machine's settings file and the three service methods that read, write and stream it.
//!
//! The file is `<home>/.ai-sidekicks/machine-settings.json`. The background service is its only
//! writer: every client hands a change to `machine.settings.update` and reads it through
//! `machine.settings.read` and `machine.settings.subscribe`. The desktop's main process
//! alone may read the file directly, and only before the service first answers. One schema
//! describes the file for every reader, so a missing key reads as its default wherever it is read.
//!
//! The environment-name rule lives here too: the service checks a row's name against it before
//! saving, beside the names each provider's driver declares it sets.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use strum::VariantArray;

use crate::agent::definition::binding::ProviderToken;
use crate::daemon::data::DAEMON_DATA_FOLDER_NAME;
use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::refusal::RefusalCode;
use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::place::PlacedPath;
use crate::project::ProjectId;
use crate::provider::declaration::{
    ProviderDeclarationId, ProviderPlaceSwitches, ProviderValueText,
};
use crate::provider::id::ProviderId;
use crate::repo::mount::ExecutionMode;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::Port;
use crate::wire::record::Record;
use crate::wire::text::{BoundedText, FreeFormText, NonEmptyText, NulFreeText, pattern_text};
use crate::wire::{NullableSchema, nullable};

ts_constants! {
    /// Where the file sits, relative to the person's home folder.
    pub const MACHINE_SETTINGS_FILE_PATH_SEGMENTS: [&str; 2] =
        [DAEMON_DATA_FOLDER_NAME, "machine-settings.json"];
    /// The longest environment name or value. Windows caps one variable at 32,767 characters, the
    /// tightest limit of the three platforms.
    pub const ENVIRONMENT_ROW_MAX_LEN: usize = 32_767;
    /// The longest editor id, call voice name or dictation language.
    pub const MACHINE_SETTINGS_NAME_MAX_LEN: usize = 256;
    /// The longest branch-name pattern.
    pub const BRANCH_NAME_PATTERN_MAX_LEN: usize = 256;
    /// RFC 5321 caps a forward path at 320 octets.
    pub const EMAIL_ADDRESS_MAX_LEN: usize = 320;
    /// RFC 1035 caps a host name at 253 characters.
    pub const MAIL_SERVER_MAX_LEN: usize = 253;
    /// What an environment variable name may look like on every platform: a letter or underscore,
    /// then letters, digits and underscores.
    pub const ENVIRONMENT_NAME_PATTERN: &str = "^[A-Za-z_][A-Za-z0-9_]*$";
    /// The endings that make a name credential-shaped. A credential is set on Providers or in a
    /// workflow step's Credential field, never as a row; a provider's API key is caught by `_KEY`.
    pub const CREDENTIAL_NAME_SUFFIXES: [&str; 4] = ["_TOKEN", "_SECRET", "_KEY", "_PASSWORD"];
    /// Names the file a Terminal pane's shell reads its mark nonce from; the shell's script deletes
    /// the file and unsets the name, so the nonce never sits in an environment another program can
    /// read.
    pub const SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME: &str = "SIDEKICKS_SHELL_MARK_NONCE_FILE";
    /// Carries bash's own `ENV` past the posix-mode start that loads a Terminal pane's shell
    /// script.
    pub const SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME: &str = "SIDEKICKS_ORIGINAL_ENV";
    /// Names a Terminal pane's shell script for a bash that loads it from its first prompt command.
    pub const SHELL_BASH_SCRIPT_ENVIRONMENT_NAME: &str = "SIDEKICKS_BASH_SCRIPT";
    /// Carries bash's own `PROMPT_COMMAND` past the first prompt command that loads its script.
    pub const SHELL_ORIGINAL_PROMPT_COMMAND_ENVIRONMENT_NAME: &str =
        "SIDEKICKS_ORIGINAL_PROMPT_COMMAND";
    /// Carries macOS's own bash's `HISTFILE` past the empty one it starts with, so it reads no
    /// history before a Terminal pane's shell script has run the login files that size it.
    pub const SHELL_ORIGINAL_HISTFILE_ENVIRONMENT_NAME: &str = "SIDEKICKS_ORIGINAL_HISTFILE";
    /// Carries zsh's own `ZDOTDIR` past the folder that loads a Terminal pane's shell script.
    pub const SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME: &str = "SIDEKICKS_ORIGINAL_ZDOTDIR";
    /// Carries fish's own `XDG_DATA_DIRS` past the folder that loads a Terminal pane's shell
    /// script.
    pub const SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME: &str =
        "SIDEKICKS_ORIGINAL_XDG_DATA_DIRS";
    /// The names the app's own shared code sets on the processes it starts. A row with one of
    /// these names would be overwritten without a word, so it is refused at save; the names a
    /// provider's driver sets are its own declaration's, which the service checks beside these.
    pub const APP_SET_ENVIRONMENT_NAMES: [&str; 7] = [
        SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME,
        SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME,
        SHELL_BASH_SCRIPT_ENVIRONMENT_NAME,
        SHELL_ORIGINAL_PROMPT_COMMAND_ENVIRONMENT_NAME,
        SHELL_ORIGINAL_HISTFILE_ENVIRONMENT_NAME,
        SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME,
        SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME,
    ];
    /// The code the service answers with when a row's name is refused.
    PROJECT_ENVIRONMENT_NAME_REFUSED_CODE = RefusalCode::ProjectEnvironmentNameRefused;
    /// The code the service answers with when a branch-name pattern is refused.
    PROJECT_BRANCH_PATTERN_REFUSED_CODE = RefusalCode::ProjectBranchPatternRefused;
    /// The placeholder a branch-name pattern holds exactly once: the tail of the session's title.
    pub const BRANCH_NAME_TITLE_PLACEHOLDER: &str = "{title}";
    /// Every [`EmailDigestPeriod`], shortest first.
    EMAIL_DIGEST_PERIODS = EmailDigestPeriod::VARIANTS;
    /// Every [`VoiceMode`].
    VOICE_MODES = VoiceMode::VARIANTS;
    /// Every [`SettingsFileRepairCause`].
    SETTINGS_FILE_REPAIR_CAUSES = SettingsFileRepairCause::VARIANTS;
    /// What each value is before anybody has chosen.
    MACHINE_SETTINGS_DEFAULTS = MachineSettings::default();
}

/// Why a row's name is refused at save.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentNameRefusalReason {
    /// Not a letter or underscore followed by letters, digits and underscores.
    NotAName,
    /// Ends like a credential's name.
    CredentialShaped,
    /// A name the app sets itself, in its shared code or through a provider's driver.
    SetByApp,
}

/// [`ENVIRONMENT_NAME_PATTERN`], compiled once.
static ENVIRONMENT_NAME_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(ENVIRONMENT_NAME_PATTERN).expect("the environment name pattern is a valid regex")
});

/// The reason a row's name is refused by the app's shared rules, or `None` when they let it be
/// saved; the service also refuses a name a registered driver sets. Names compare without case,
/// because Windows reads `path` and `PATH` as one variable.
pub fn environment_name_refusal(name: &str) -> Option<EnvironmentNameRefusalReason> {
    if !ENVIRONMENT_NAME_REGEX.is_match(name) {
        return Some(EnvironmentNameRefusalReason::NotAName);
    }
    let upper_name = name.to_ascii_uppercase();
    if CREDENTIAL_NAME_SUFFIXES
        .iter()
        .any(|suffix| upper_name.ends_with(suffix))
    {
        return Some(EnvironmentNameRefusalReason::CredentialShaped);
    }
    if APP_SET_ENVIRONMENT_NAMES.contains(&upper_name.as_str()) {
        return Some(EnvironmentNameRefusalReason::SetByApp);
    }
    None
}

/// The refused name and why, so the page marks the row it was typed into.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectEnvironmentNameRefusedDetails {
    /// The name as typed.
    pub name: BoundedText<1, ENVIRONMENT_ROW_MAX_LEN>,
    /// Why it was refused.
    pub reason: EnvironmentNameRefusalReason,
}

/// Why a branch-name pattern was refused at save, told apart by `reason`, so the page says which
/// rule it broke.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "reason",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProjectBranchPatternRefusedDetails {
    /// The pattern does not hold `{title}` exactly once.
    TitleNotOnce {},
    /// The filled-in name is not a branch name git accepts.
    NotABranchName {},
    /// The filled-in name clashes with an existing branch: one that would hold it, sit inside it,
    /// or share its name.
    ClashesWithBranch {
        /// Git's own line for the clash, without git's `fatal: prepare: ` prefix and, on git's
        /// files backend, the `cannot lock ref '<name>': ` clause after it, which reftable omits.
        git_message: NonEmptyText,
        /// The project whose repository holds the branch the name clashes with.
        project_id: ProjectId,
    },
}

/// One `name = value` row passed to every process the app starts, in `Every project` or in one
/// project's own list. The name rule is [`environment_name_refusal`], checked by the service when
/// a list is saved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentRow {
    /// The variable's name.
    pub name: BoundedText<1, ENVIRONMENT_ROW_MAX_LEN>,
    /// Its value; a NUL would cut the environment entry short.
    pub value: NulFreeText<ENVIRONMENT_ROW_MAX_LEN>,
}

/// The four kinds of moment a notification or a delivery can be about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the wire carries each switch as its own boolean member"
)]
pub struct NotificationKindSwitches {
    /// `Waiting on you`.
    pub waiting_on_you: bool,
    /// `Finished`.
    pub finished: bool,
    /// `Failed`.
    pub failed: bool,
    /// A workflow's Notify step.
    pub notify_step: bool,
}

impl NotificationKindSwitches {
    /// Every kind on.
    const ALL_ON: Self = Self {
        waiting_on_you: true,
        finished: true,
        failed: true,
        notify_step: true,
    };
}

/// How often the email digest may go out at most.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum EmailDigestPeriod {
    /// Once an hour.
    Hour,
    /// Once every four hours.
    FourHours,
    /// Once a day.
    Day,
}

pattern_text! {
    /// An email address in the form mail clients accept: a dotted local part of letters, digits
    /// and `_'+-`, then a host of letter-led labels and a top-level name of two letters or more.
    pub struct EmailAddress(
        "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@\
         (?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
        max = EMAIL_ADDRESS_MAX_LEN
    );
}

/// The email digest's settings other than its password, which the service seals in the keychain.
/// A field left unset is `null`; `userName` unset means the address itself, and `mailServer` and
/// `port` unset mean the mail library's own entry for the address's domain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmailDigestSettings {
    /// Whether the digest goes out.
    pub enabled: bool,
    /// The address it goes to.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<EmailAddress>")]
    pub send_to: Option<EmailAddress>,
    /// The mail server's host.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<FreeFormText<MAIL_SERVER_MAX_LEN>>")]
    pub mail_server: Option<FreeFormText<MAIL_SERVER_MAX_LEN>>,
    /// The mail server's port.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<Port>")]
    pub port: Option<Port>,
    /// The user name the server signs in with.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<FreeFormText<EMAIL_ADDRESS_MAX_LEN>>")]
    pub user_name: Option<FreeFormText<EMAIL_ADDRESS_MAX_LEN>>,
    /// The shortest time between two digests.
    pub after: EmailDigestPeriod,
}

/// The web address's switch and the kinds it is sent; the address and its secret are sealed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebAddressSettings {
    /// Whether the web address is sent anything.
    pub enabled: bool,
    /// The kinds it is sent.
    pub kinds: NotificationKindSwitches,
}

/// Everything the Notifications page keeps in the file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationSettings {
    /// `Show a count on the app icon`.
    pub app_icon_count: bool,
    /// `Notify me outside the app`, the switch above the four kinds.
    pub notify_outside_app: bool,
    /// The kinds a notification is shown for.
    pub kinds: NotificationKindSwitches,
    /// The email digest.
    pub email_digest: EmailDigestSettings,
    /// The web address.
    pub web_address: WebAddressSettings,
}

/// Whether Space is held while talking or tapped to start and stop, on every provider.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum VoiceMode {
    /// Held while talking.
    Hold,
    /// Tapped to start and stop.
    Tap,
}

/// Voice's settings. `callVoice`, the voice a spoken call answers in, and `dictationLanguage`, the
/// language dictation hears, are `null` until picked, while the provider's own value is followed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceSettings {
    /// How Space works.
    pub mode: VoiceMode,
    /// The voice a spoken call answers in.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>")]
    pub call_voice: Option<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>,
    /// The dictation language, a language name the speech service takes.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>")]
    pub dictation_language: Option<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>,
}

/// `Back up automatically` and `Back up to`; a `folder` unset is the service's default folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupSettings {
    /// Whether backups run on their own.
    pub automatic: bool,
    /// Where they go.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<FilesystemPath>")]
    pub folder: Option<FilesystemPath>,
}

/// A branch-name pattern as a change carries it: bounded. Its placeholder rule and git's check are
/// the service's, refused with `project.branchPattern.refused` so the page can say which.
pub type BranchNamePatternChange = FreeFormText<BRANCH_NAME_PATTERN_MAX_LEN>;

/// [`BRANCH_NAME_TITLE_PLACEHOLDER`] held exactly once, in ECMAScript's syntax; Rust checks the
/// same rule by counting.
const TITLE_ONCE_PATTERN: &str = "^(?![^]*\\{title\\}[^]*\\{title\\})[^]*\\{title\\}";

/// A saved branch-name pattern, for `Every project` and for one project's own override: a change's
/// pattern that also holds `{title}` exactly once. A file holding any other is repaired.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct BranchNamePattern(BranchNamePatternChange);

impl BranchNamePattern {
    /// `pattern` when it holds `{title}` exactly once, else the reason it is refused. Whether the
    /// filled-in name is a branch name, and whether it clashes with one, are git's checks, which
    /// the service makes after this one.
    pub fn new(
        pattern: BranchNamePatternChange,
    ) -> Result<Self, ProjectBranchPatternRefusedDetails> {
        if pattern
            .as_str()
            .matches(BRANCH_NAME_TITLE_PLACEHOLDER)
            .count()
            == 1
        {
            Ok(Self(pattern))
        } else {
            Err(ProjectBranchPatternRefusedDetails::TitleNotOnce {})
        }
    }

    /// The pattern.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl<'de> Deserialize<'de> for BranchNamePattern {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(BranchNamePatternChange::deserialize(deserializer)?)
            .map_err(|_refusal| D::Error::custom("a branch-name pattern holds {title} once"))
    }
}

impl JsonSchema for BranchNamePattern {
    fn schema_name() -> Cow<'static, str> {
        "BranchNamePattern".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "A saved branch-name pattern: a change's pattern that also holds \
                            `{title}` exactly once.",
            "allOf": [
                BranchNamePatternChange::json_schema(generator),
                { "type": "string", "pattern": TITLE_ONCE_PATTERN },
            ],
        })
    }
}

/// The lead's model and effort the person last picked, which a new session starts on while
/// `newSessionCarriesLastModel` is on. The service writes it each time a pick moves it; `effort`
/// `null` is the driver's default.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastLeadModel {
    /// The provider.
    pub provider_name: ProviderId,
    /// The model.
    pub model_id: ProviderToken,
    /// The effort, or `null` for the driver's default.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<ProviderToken>")]
    pub effort: Option<ProviderToken>,
}

/// The provider and model Generate writes its commit and pull-request text with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitTextModel {
    /// The provider.
    pub provider: ProviderId,
    /// The model.
    pub model_id: ProviderToken,
}

/// One declared Settings row's value set in the app, split by the row's shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ProviderRowValue {
    /// A switch's entry for each place it was set in, keyed by place; a place left out follows the
    /// provider's own value there.
    Places(ProviderPlaceSwitches),
    /// A choice's option or `null` for its none, or a text setting's text or `null` for none.
    Value(#[schemars(with = "NullableSchema<ProviderValueText>")] Option<ProviderValueText>),
}

/// One provider's values of the Settings rows its driver declares, by row. A row left out follows
/// the provider's own value. A row id never reads `__proto__`, which its pattern excludes, and the
/// schema refuses it too.
pub type ProviderRowValues = Record<ProviderDeclarationId, ProviderRowValue>;

/// Each provider's values of its declared Settings rows, by provider; a provider left out follows
/// its own values on every row. A provider id never reads `__proto__`, which its pattern excludes,
/// and the schema refuses it too.
pub type ProviderSettingValues = Record<ProviderId, ProviderRowValues>;

/// Every value the machine's settings file holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the wire carries each switch as its own boolean member"
)]
pub struct MachineSettings {
    /// `Check for updates automatically`.
    pub updates_automatic: bool,
    /// `Keep crash reports`.
    pub keep_crash_reports: bool,
    /// `Editor that opens files`; `null` is `System default`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>")]
    pub editor_id: Option<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>,
    /// The values set in the app on the Settings rows each provider's driver declares, written by
    /// `provider.update` and passed to the app's own sessions; empty until one is set, while each
    /// provider's own values are followed.
    pub provider_settings: ProviderSettingValues,
    /// `Commit and pull request text`; `null` is `Automatic`, the session's provider and its
    /// lowest-priced model.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<CommitTextModel>")]
    pub commit_text_model: Option<CommitTextModel>,
    /// `Default checkout for a new project session`.
    pub default_checkout: ExecutionMode,
    /// `Start a new session on the last model and effort used`.
    pub new_session_carries_last_model: bool,
    /// The last model and effort picked, `null` before the first pick.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<LastLeadModel>")]
    pub last_lead_model: Option<LastLeadModel>,
    /// `Keep this Mac awake while a sidekick is working`.
    pub keep_awake_while_agent_works: bool,
    /// `Keep this Mac awake for other devices`, held only while on power.
    pub keep_awake_for_other_devices: bool,
    /// The Notifications page's settings.
    pub notifications: NotificationSettings,
    /// `Remember site data`.
    pub remember_site_data: bool,
    /// `Browser tools for sidekicks`.
    pub browser_tools_for_agents: bool,
    /// `Sandbox the background browser`: whether the headless browser every session and workflow
    /// shares starts with Chromium's sandbox, read at its next launch.
    pub sandbox_background_browser: bool,
    /// `Simplify for a screen reader`, carried into the Terminal pane's shells.
    pub screen_reader_mode: bool,
    /// `Every project`'s environment rows.
    pub environment_rows: Vec<EnvironmentRow>,
    /// The backup settings.
    pub backup: BackupSettings,
    /// `Every project`'s `Branch names`.
    pub branch_name_pattern: BranchNamePattern,
    /// `Clone new repositories into`, with the distribution it is in; `null` until the person
    /// sets one.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<PlacedPath>")]
    pub clone_folder: Option<PlacedPath>,
    /// The voice settings.
    pub voice: VoiceSettings,
}

impl Default for MachineSettings {
    fn default() -> Self {
        let branch_name_pattern =
            BranchNamePatternChange::new("sidekicks/{session}/{title}".into())
                .ok()
                .and_then(|pattern| BranchNamePattern::new(pattern).ok())
                .expect("the default pattern is bounded and holds {title} once");
        Self {
            updates_automatic: true,
            keep_crash_reports: true,
            editor_id: None,
            provider_settings: Record::default(),
            commit_text_model: None,
            default_checkout: ExecutionMode::ProvisionedWorktree,
            new_session_carries_last_model: true,
            last_lead_model: None,
            keep_awake_while_agent_works: false,
            keep_awake_for_other_devices: false,
            notifications: NotificationSettings {
                app_icon_count: true,
                notify_outside_app: true,
                kinds: NotificationKindSwitches::ALL_ON,
                email_digest: EmailDigestSettings {
                    enabled: false,
                    send_to: None,
                    mail_server: None,
                    port: None,
                    user_name: None,
                    after: EmailDigestPeriod::Day,
                },
                web_address: WebAddressSettings {
                    enabled: false,
                    kinds: NotificationKindSwitches::ALL_ON,
                },
            },
            remember_site_data: true,
            browser_tools_for_agents: true,
            sandbox_background_browser: false,
            screen_reader_mode: false,
            environment_rows: Vec::new(),
            backup: BackupSettings {
                automatic: false,
                folder: None,
            },
            branch_name_pattern,
            clone_folder: None,
            voice: VoiceSettings {
                mode: VoiceMode::Hold,
                call_voice: None,
                dictation_language: None,
            },
        }
    }
}

/// Lays what the file holds over the defaults, member by member and group by group, so a key the
/// file lacks reads as its default. A key the defaults do not know is carried over, so the strict
/// read refuses it.
fn over_defaults(defaults: &mut Map<String, Value>, stored: Map<String, Value>) {
    for (key, stored_value) in stored {
        match (defaults.get_mut(&key), stored_value) {
            (Some(Value::Object(default_group)), Value::Object(stored_group)) => {
                over_defaults(default_group, stored_group);
            }
            (_, stored_value) => {
                defaults.insert(key, stored_value);
            }
        }
    }
}

/// Reads the file's parsed JSON as settings: a missing key takes its default, and an unknown key
/// or a value out of shape refuses the whole file, which the service then reads as the defaults
/// and repairs.
pub fn parse_machine_settings_file(file: Value) -> Result<MachineSettings, serde_json::Error> {
    let Value::Object(stored) = file else {
        return serde_json::from_value(file);
    };
    let mut merged = serde_json::to_value(MachineSettings::default())?;
    if let Value::Object(defaults) = &mut merged {
        over_defaults(defaults, stored);
    }
    serde_json::from_value(merged)
}

/// One change to the file: exactly one top-level member, with its whole value. A group such as
/// `notifications` is written whole, so a change to one of its switches carries the group as the
/// page last read it with that switch moved. A pattern's `{title}` rule is the service's coded
/// refusal, not a parse failure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MachineSettingsChange {
    /// `Check for updates automatically`.
    UpdatesAutomatic(bool),
    /// `Keep crash reports`.
    KeepCrashReports(bool),
    /// `Editor that opens files`.
    EditorId(
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>")]
        Option<FreeFormText<MACHINE_SETTINGS_NAME_MAX_LEN>>,
    ),
    /// `Commit and pull request text`.
    CommitTextModel(
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<CommitTextModel>")]
        Option<CommitTextModel>,
    ),
    /// `Default checkout for a new project session`.
    DefaultCheckout(ExecutionMode),
    /// `Start a new session on the last model and effort used`.
    NewSessionCarriesLastModel(bool),
    /// The last model and effort picked.
    LastLeadModel(
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<LastLeadModel>")]
        Option<LastLeadModel>,
    ),
    /// `Keep this Mac awake while a sidekick is working`.
    KeepAwakeWhileAgentWorks(bool),
    /// `Keep this Mac awake for other devices`.
    KeepAwakeForOtherDevices(bool),
    /// The Notifications page's settings, whole.
    Notifications(NotificationSettings),
    /// `Remember site data`.
    RememberSiteData(bool),
    /// `Browser tools for sidekicks`.
    BrowserToolsForAgents(bool),
    /// `Sandbox the background browser`.
    SandboxBackgroundBrowser(bool),
    /// `Simplify for a screen reader`.
    ScreenReaderMode(bool),
    /// `Every project`'s environment rows, whole.
    EnvironmentRows(Vec<EnvironmentRow>),
    /// The backup settings, whole.
    Backup(BackupSettings),
    /// `Every project`'s `Branch names`.
    BranchNamePattern(BranchNamePatternChange),
    /// `Clone new repositories into`.
    CloneFolder(
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<PlacedPath>")]
        Option<PlacedPath>,
    ),
    /// The voice settings, whole.
    Voice(VoiceSettings),
}

/// Why a settings file was found broken.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum SettingsFileRepairCause {
    /// The file was not JSON.
    Unparsable,
    /// The file's JSON did not match its schema.
    SchemaRefused,
}

/// A settings file's repair: its owner found the file broken, read the defaults in its place and
/// wrote them back. Carried until the next change is written, so the page can say both happened.
/// The machine settings file and the keyboard map both carry one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SettingsFileRepair {
    /// When the file was repaired.
    #[garde(dive)]
    pub repaired_at: WireInstant,
    /// Why it was broken.
    pub cause: SettingsFileRepairCause,
}

/// The file as the service last read or wrote it, and the repair it made, if any.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct MachineSettingsReading {
    /// The settings.
    pub settings: MachineSettings,
    /// The repair the service made, until the next change is written.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SettingsFileRepair")]
    #[garde(dive)]
    pub repair: Option<SettingsFileRepair>,
}

/// `machine.settings.update`: the one change to write.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct MachineSettingsUpdateRequest {
    /// The change.
    pub change: MachineSettingsChange,
}

/// The file as written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct MachineSettingsUpdateResponse {
    /// The settings.
    pub settings: MachineSettings,
}

methods! {
    /// The descriptor table of the three machine-settings methods.
    pub const MACHINE_SETTINGS_METHOD_DESCRIPTORS = [
        /// The file as it stands.
        MachineSettingsRead = query "machine.settings.read" {
            mutating: false,
            params: EmptyPayload,
            result: MachineSettingsReading,
            refusals: [],
        },
        /// Writes one change.
        MachineSettingsUpdate = mutation "machine.settings.update" {
            mutating: true,
            params: MachineSettingsUpdateRequest,
            result: MachineSettingsUpdateResponse,
            refusals: [ProjectEnvironmentNameRefused, ProjectBranchPatternRefused],
        },
        /// The first emission is the file as it stands; each written change follows.
        MachineSettingsSubscribe = subscription "machine.settings.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAcknowledgmentResponse,
            emission: MachineSettingsReading,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the machine's settings.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "machine/settings",
    doc: "The machine's settings file and the three service methods that read, write and stream \
          it, with the environment-name rule the service checks a row's name against.",
    definitions: &[
        Definition::read::<EnvironmentNameRefusalReason>(),
        Definition::read::<ProjectEnvironmentNameRefusedDetails>(),
        Definition::read::<ProjectBranchPatternRefusedDetails>(),
        Definition::read::<EnvironmentRow>().checked(),
        Definition::read::<NotificationKindSwitches>().checked(),
        Definition::read::<EmailDigestPeriod>(),
        Definition::read::<EmailAddress>(),
        Definition::read::<EmailDigestSettings>(),
        Definition::read::<WebAddressSettings>(),
        Definition::read::<NotificationSettings>(),
        Definition::read::<VoiceMode>(),
        Definition::read::<VoiceSettings>(),
        Definition::read::<BackupSettings>(),
        Definition::read::<BranchNamePattern>().checked(),
        Definition::read::<LastLeadModel>(),
        Definition::read::<CommitTextModel>(),
        Definition::read::<ProviderRowValue>(),
        Definition::read::<MachineSettings>().checked(),
        Definition::read::<MachineSettingsChange>().checked(),
        Definition::read::<SettingsFileRepairCause>(),
        Definition::read::<SettingsFileRepair>(),
        Definition::read::<MachineSettingsReading>().checked(),
        Definition::read::<MachineSettingsUpdateRequest>().checked(),
        Definition::read::<MachineSettingsUpdateResponse>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&MACHINE_SETTINGS_METHOD_DESCRIPTORS],
};

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::Value;

    use super::{
        EnvironmentNameRefusalReason, environment_name_refusal, parse_machine_settings_file,
    };

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct EnvironmentNameCase {
        name: String,
        refusal: Option<EnvironmentNameRefusalReason>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct SettingsFileCase {
        file: Value,
        settings: Option<Value>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct MachineSettingsCases {
        environment_names: Vec<EnvironmentNameCase>,
        settings_files: Vec<SettingsFileCase>,
    }

    fn cases() -> MachineSettingsCases {
        serde_json::from_str(include_str!("../../tests/fixtures/machine-settings.json"))
            .expect("the case table parses")
    }

    #[test]
    fn a_row_name_is_refused_for_the_reason_the_table_gives() {
        for case in cases().environment_names {
            assert_eq!(
                environment_name_refusal(&case.name),
                case.refusal,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn a_settings_file_reads_over_the_defaults_or_is_refused_whole() {
        for case in cases().settings_files {
            let read = parse_machine_settings_file(case.file.clone())
                .ok()
                .map(|settings| serde_json::to_value(settings).expect("settings serialize"));
            assert_eq!(read, case.settings, "{}", case.file);
        }
    }
}
