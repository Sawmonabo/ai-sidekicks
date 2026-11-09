//! The `--settings` document every Claude Code process starts with: how long Claude Code keeps a
//! conversation, its agent view held off, a session's whole permission rules, its advisor and
//! output style, the command sandbox at Sandboxed, and in its `env` the variables the app sets on
//! every process and the telemetry switches.

pub(crate) mod private_file;
pub(crate) mod telemetry_switches;

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_platforms::PathRules;
use sidekicks_policy::ask_rule::ProviderAskRule;

use crate::background_work::{BackgroundWorkForms, plain_background_work_forms};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::commands::ClaudeCommandChannel;
use crate::driver::claude::session::rules::{
    ClaudeRulesError, compose_claude_session_rule_lists, compose_path_content,
};
use crate::driver::claude::session::transport::control::{
    ClaudePermissionsDocument, ClaudeSandboxFilesystem, ClaudeSandboxSettings,
};
use crate::driver::claude::spawn::settings::telemetry_switches::{
    NoOtelHeadersHelper, compose_claude_telemetry_switches,
};
use crate::pricing::receiver::TelemetryTarget;
use crate::pricing::receiver::bearers::TelemetryBearer;
use crate::run::posture::{CredentialDenyPath, CredentialDenyPathKind};

/// How many days Claude Code keeps a conversation file before cleaning it up: long enough that a
/// session's own history never disappears under it. Written at every start and in each account
/// home.
pub(crate) const CLAUDE_CLEANUP_PERIOD_DAYS: u32 = 36_500;

/// The shell tool, which the background deny rules and the Reviewed ask rule name.
const CLAUDE_SHELL_TOOL_NAME: &str = "Bash";

/// The command the Reviewed ask rule names.
const CLAUDE_REMOVAL_COMMAND: &str = "rm";

/// Claude Code's agent view, always off: background sessions it starts run outside the session's
/// agents, its Stop and Interrupt, and its receipt. It writes as `true`, the only value it takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AgentViewOff;

impl Serialize for AgentViewOff {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

/// The `--settings` document. `advisor_model` is `""` when the session's advisor is off, which
/// outranks the person's own advisor, and absent where no advisor was picked, so Claude Code's own
/// settings resolve it; `output_style` is absent where the session chose none. A short process's
/// document carries no rules, advisor, style or sandbox.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeSpawnSettings {
    /// [`CLAUDE_CLEANUP_PERIOD_DAYS`].
    pub(crate) cleanup_period_days: u32,
    /// The agent view, off.
    pub(crate) disable_agent_view: AgentViewOff,
    /// The session's whole permission rules, absent on a short process.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) permissions: Option<ClaudePermissionsDocument>,
    /// The session's advisor model, `""` for none, absent where none was picked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) advisor_model: Option<String>,
    /// The session's output style.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) output_style: Option<String>,
    /// The command sandbox, at Sandboxed alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sandbox: Option<ClaudeSandboxSettings>,
    /// Every hook of the person's off, written only where `true`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) disable_all_hooks: bool,
    /// The variables Claude Code sets inside the process, over its starting environment and the
    /// person's own settings files: the app's own on every process, and the telemetry switches.
    pub(crate) env: BTreeMap<&'static str, String>,
    /// No exporter headers helper, written with the telemetry switches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) otel_headers_helper: Option<NoOtelHeadersHelper>,
}

// `env` carries the telemetry token's header, so only its names are written.
impl fmt::Debug for ClaudeSpawnSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeSpawnSettings")
            .field("cleanup_period_days", &self.cleanup_period_days)
            .field("disable_agent_view", &self.disable_agent_view)
            .field("permissions", &self.permissions)
            .field("advisor_model", &self.advisor_model)
            .field("output_style", &self.output_style)
            .field("sandbox", &self.sandbox)
            .field("disable_all_hooks", &self.disable_all_hooks)
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("otel_headers_helper", &self.otel_headers_helper)
            .finish()
    }
}

impl ClaudeSpawnSettings {
    /// A short process's document: the cleanup period, the agent view off and the app's
    /// variables, with every hook of the person's off where `are_hooks_off`, and no rules,
    /// advisor, style or sandbox.
    pub(crate) fn short_process(are_hooks_off: bool) -> Self {
        Self {
            cleanup_period_days: CLAUDE_CLEANUP_PERIOD_DAYS,
            disable_agent_view: AgentViewOff,
            permissions: None,
            advisor_model: None,
            output_style: None,
            sandbox: None,
            disable_all_hooks: are_hooks_off,
            env: compose_app_variables(),
            otel_headers_helper: None,
        }
    }

    /// Puts the telemetry switches into the document: the export to the target's receiver under
    /// the process's own bearer where both are given, every exporter off where they are not, and
    /// no exporter headers helper.
    pub(crate) fn set_telemetry_switches(
        &mut self,
        export: Option<(&TelemetryTarget, &TelemetryBearer)>,
    ) {
        self.env.extend(compose_claude_telemetry_switches(export));
        self.otel_headers_helper = Some(NoOtelHeadersHelper);
    }
}

/// The document a Claude Code subcommand run outside the launcher carries inline, every exporter
/// off: it holds no token, so it needs no file of its own.
pub(crate) fn compose_claude_export_off_settings() -> String {
    let mut settings = ClaudeSpawnSettings::short_process(false);
    settings.set_telemetry_switches(None);
    serde_json::to_string(&settings).expect("the settings document always serializes")
}

/// What a session's permission rules are composed from.
pub(crate) struct ClaudePermissionsRequest<'a> {
    /// The curated credential paths, denied to every file-reading tool.
    pub(crate) credential_deny_paths: &'a [CredentialDenyPath],
    /// Each spelling of the agent-memory folder (the config home's and the daemon's own), whose
    /// notes an agent reads and edits unasked at Sandboxed.
    pub(crate) memory_folders: &'a [PathBuf],
    /// The session's own rules.
    pub(crate) session_rules: &'a [ProviderAskRule],
    /// How the place the process runs in spells paths.
    pub(crate) path_rules: PathRules,
    /// Every provider's background work, denied written plainly at the levels that never ask.
    pub(crate) background_work: &'a BackgroundWorkForms,
}

/// The advisor a session's processes start with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeSessionAdvisor {
    /// Neither the session nor the app picked one, so Claude Code's own settings resolve it.
    Unpicked,
    /// No advisor.
    Off,
    /// This advisor model.
    Model(String),
}

impl ClaudeSessionAdvisor {
    /// The advisor a picked or resolved `advisorModel` names; `None` and `""` are off.
    pub(crate) fn of(advisor_model: Option<&str>) -> Self {
        match advisor_model {
            Some(model) if !model.is_empty() => Self::Model(model.to_owned()),
            Some(_) | None => Self::Off,
        }
    }

    /// The advisor model, `None` when off or unpicked.
    pub(crate) fn model(&self) -> Option<&str> {
        match self {
            Self::Model(model) => Some(model),
            Self::Unpicked | Self::Off => None,
        }
    }

    /// The `advisorModel` setting: `""` when off, which Claude Code reads as no advisor and which
    /// outranks the person's own advisor in their Claude Code settings; `None` when unpicked.
    pub(crate) fn setting(&self) -> Option<String> {
        match self {
            Self::Unpicked => None,
            Self::Off => Some(String::new()),
            Self::Model(model) => Some(model.clone()),
        }
    }
}

/// Whether a tool ask is a removal the Reviewed ask rule matches: the shell tool running a command
/// that starts with `rm` and its arguments. `input` is the provider's own.
pub(crate) fn matches_claude_reviewed_removal_rule(
    tool_name: &str,
    input: &Map<String, Value>,
) -> bool {
    tool_name == CLAUDE_SHELL_TOOL_NAME
        && input
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| {
                command
                    .trim_start_matches(sidekicks_contracts::wire::text::is_ecmascript_whitespace)
                    .strip_prefix(CLAUDE_REMOVAL_COMMAND)
                    .is_some_and(|rest| rest.starts_with(' '))
            })
}

/// The session's whole permission rules at `level` with `writable_roots`: the credential paths
/// denied to every file-reading tool, a writable git folder's `hooks/` and `config` denied to
/// every editing tool, the removal ask rule at Reviewed, the agent-memory folder allowed at
/// Sandboxed, every provider's background work written plainly denied at Sandboxed and YOLO, and
/// the session's own rules. Claude Code replaces the document whole, so a level move and a rule's
/// grant or revoke each resend all of it. Fails as the session's own rules fail to compose.
pub(crate) fn compose_claude_permissions(
    request: &ClaudePermissionsRequest<'_>,
    writable_roots: &[FilesystemPath],
    level: Option<PermissionLevel>,
) -> Result<ClaudePermissionsDocument, ClaudeRulesError> {
    let path_rules = request.path_rules;
    let own = compose_claude_session_rule_lists(request.session_rules, path_rules)?;
    let mut deny: Vec<String> = request
        .credential_deny_paths
        .iter()
        .map(|denied| {
            let path = denied.path.to_string_lossy();
            match denied.kind {
                // A folder's rule covers everything under it; a file's names the file itself.
                CredentialDenyPathKind::Folder => path_rule("Read", &path, Some("**"), path_rules),
                CredentialDenyPathKind::File => path_rule("Read", &path, None, path_rules),
            }
        })
        .collect();
    deny.extend(own.deny);
    // The levels that never ask never reach the daemon's answer to an ask, so background work
    // written plainly is denied here; the pre-tool hook reads every other spelling.
    if matches!(
        level,
        Some(PermissionLevel::Sandboxed | PermissionLevel::Yolo)
    ) {
        for form in plain_background_work_forms(request.background_work) {
            deny.push(format!("{CLAUDE_SHELL_TOOL_NAME}({form})"));
            deny.push(format!("{CLAUDE_SHELL_TOOL_NAME}({form} *)"));
        }
    }
    // A writable root is the repository's git folder, which the sandbox lets a command write but
    // for its hooks and config; the editing tools get the same exclusions.
    for root in writable_roots {
        deny.push(path_rule(
            "Edit",
            root.as_str(),
            Some("hooks/**"),
            path_rules,
        ));
        deny.push(path_rule("Edit", root.as_str(), Some("config"), path_rules));
    }
    let mut allow = Vec::new();
    if level == Some(PermissionLevel::Sandboxed) {
        // `Edit` covers every editing tool; Claude Code never reads a `Write` path rule.
        for folder in request.memory_folders {
            let folder = folder.to_string_lossy();
            allow.push(path_rule("Read", &folder, Some("**"), path_rules));
            allow.push(path_rule("Edit", &folder, Some("**"), path_rules));
        }
    }
    allow.extend(own.allow);
    let ask = if level == Some(PermissionLevel::Reviewed) {
        vec![format!(
            "{CLAUDE_SHELL_TOOL_NAME}({CLAUDE_REMOVAL_COMMAND} *)"
        )]
    } else {
        Vec::new()
    };
    Ok(ClaudePermissionsDocument { allow, ask, deny })
}

/// The `--settings` document for a process at the session's current `posture`, advisor, output
/// style and own rules, its commands reaching `command_channel` where one opened. Fails as
/// [`compose_claude_permissions`] does.
pub(crate) fn compose_claude_spawn_settings(
    request: &ClaudePermissionsRequest<'_>,
    posture: Option<&ExecutionPosture>,
    advisor: &ClaudeSessionAdvisor,
    output_style: Option<&str>,
    command_channel: Option<&ClaudeCommandChannel>,
) -> Result<ClaudeSpawnSettings, ClaudeRulesError> {
    let writable_roots = posture
        .map(ExecutionPosture::writable_roots)
        .unwrap_or_default();
    let level = posture.map(ExecutionPosture::permission_level);
    Ok(ClaudeSpawnSettings {
        cleanup_period_days: CLAUDE_CLEANUP_PERIOD_DAYS,
        disable_agent_view: AgentViewOff,
        permissions: Some(compose_claude_permissions(request, writable_roots, level)?),
        advisor_model: advisor.setting(),
        output_style: output_style.map(str::to_owned),
        sandbox: (level == Some(PermissionLevel::Sandboxed))
            .then(|| compose_claude_sandbox_settings(writable_roots, command_channel)),
        disable_all_hooks: false,
        env: compose_app_variables(),
        otel_headers_helper: None,
    })
}

// The variables the app sets on every Claude Code process, from its descriptor: in the
// document's `env` they outrank an `env` in the person's own settings files, which would overwrite
// them in the starting environment.
fn compose_app_variables() -> BTreeMap<&'static str, String> {
    DESCRIPTOR
        .settings_environment
        .iter()
        .map(|(name, value)| (*name, (*value).to_owned()))
        .collect()
}

/// The command sandbox at Sandboxed, writable in `writable_roots` and in `command_channel`'s
/// folder, where the wrapper and askpass a command runs under write their records, but not in its
/// requests folder, which only the daemon writes: a process's `--settings` carries it, and a live
/// move into Sandboxed sends it in the flag settings. The daemon never writes
/// `allowUnsandboxedCommands`, so the person's own setting holds; the empty exclusion list adds
/// none of the daemon's own.
pub(crate) fn compose_claude_sandbox_settings(
    writable_roots: &[FilesystemPath],
    command_channel: Option<&ClaudeCommandChannel>,
) -> ClaudeSandboxSettings {
    let channel_folder = |folder: &Path| folder.to_string_lossy().into_owned();
    ClaudeSandboxSettings {
        enabled: true,
        fail_if_unavailable: true,
        excluded_commands: Vec::new(),
        filesystem: ClaudeSandboxFilesystem {
            allow_write: writable_roots
                .iter()
                .map(|root| root.as_str().to_owned())
                .chain(command_channel.map(|channel| channel_folder(channel.folder())))
                .collect(),
            deny_write: command_channel
                .map(|channel| channel_folder(&channel.requests_folder()))
                .into_iter()
                .collect(),
        },
    }
}

// A `tool` rule on the absolute `path`, as Claude Code matches it (`Read(//c/Users/a/**)`), with
// `glob` under it where given.
fn path_rule(tool: &str, path: &str, glob: Option<&str>, path_rules: PathRules) -> String {
    let content = compose_path_content(path, path_rules);
    match glob {
        Some(glob) => format!("{tool}({}/{glob})", content.trim_end_matches('/')),
        None => format!("{tool}({content})"),
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use serde_json::{Value, json};
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_platforms::PathRules;

    use super::{
        ClaudePermissionsRequest, ClaudeSessionAdvisor, ClaudeSpawnSettings,
        compose_claude_permissions, compose_claude_spawn_settings,
    };
    use crate::background_work::BackgroundWorkForms;
    use crate::driver::PROVIDERS;
    use crate::driver::claude::DESCRIPTOR;
    use crate::driver::claude::spawn::environment::compose_claude_environment_without_home;
    use crate::driver::claude::spawn::legs::compose_claude_memory_folders;
    use crate::pricing::receiver::TelemetryTarget;
    use crate::pricing::receiver::bearers::{TelemetryBearers, TelemetryHolderId};
    use crate::run::posture::{CredentialDenyPath, CredentialDenyPathKind};
    use crate::spawn_environment::{ReservedEnvironmentNames, SessionEnvironment};

    // Killed by the derived `Debug`, which writes the export's `Authorization` value into any log
    // line or panic that prints the document.
    #[test]
    fn a_printed_document_names_its_variables_without_the_token() {
        let bearers = Arc::new(TelemetryBearers::default());
        let bearer = bearers
            .mint(DESCRIPTOR.provider_id(), TelemetryHolderId::new(1))
            .expect("a token mints");
        let target = TelemetryTarget::new(43_210, bearers);
        let mut settings = ClaudeSpawnSettings::short_process(false);
        settings.set_telemetry_switches(Some((&target, &bearer)));

        let printed = format!("{settings:?}");

        assert!(printed.contains("OTEL_EXPORTER_OTLP_HEADERS"));
        assert!(!printed.contains(bearer.exporter_headers().as_str()));
    }

    // Killed by dropping the credential paths from `permissions.deny`, which lets every
    // file-reading tool read them, by a folder's rule that leaves out what is under it, and by a
    // file's rule widened to a folder's.
    #[test]
    fn each_credential_path_is_denied_to_the_file_reading_tools() {
        let denied = |path: &str, kind| CredentialDenyPath {
            path: PathBuf::from(path),
            kind,
        };
        let credential_deny_paths = [
            denied("/Users/alice/.ssh", CredentialDenyPathKind::Folder),
            denied("/Users/alice/.aws", CredentialDenyPathKind::Folder),
            denied("/Users/alice/.netrc", CredentialDenyPathKind::File),
        ];
        let request = ClaudePermissionsRequest {
            credential_deny_paths: &credential_deny_paths,
            memory_folders: &[],
            session_rules: &[],
            path_rules: PathRules::Posix,
            background_work: &BackgroundWorkForms::of_providers(PROVIDERS),
        };

        let document = compose_claude_permissions(&request, &[], Some(PermissionLevel::Ask))
            .expect("the rules compose");

        assert_eq!(
            document.deny,
            [
                "Read(//Users/alice/.ssh/**)",
                "Read(//Users/alice/.aws/**)",
                "Read(//Users/alice/.netrc)",
            ]
        );
    }

    // Killed by dropping the memory allows or the `//` anchor, by a `Write(` rule Claude Code never
    // reads, by narrowing the allows to `.md` files, which would keep the agent from its other
    // memory files, by dropping either spelling of the folder from the composition, by allowing
    // the folder at another level (Yolo beside Sandboxed among them), or by dropping the
    // background deny rules at Sandboxed.
    #[test]
    fn sandboxed_allows_the_agent_memory_folder_and_denies_background_work() {
        let memory_folders = compose_claude_memory_folders(
            Path::new("/Users/alice/.claude"),
            Path::new("/Users/alice/.ai-sidekicks"),
        );
        let request = ClaudePermissionsRequest {
            credential_deny_paths: &[],
            memory_folders: &memory_folders,
            session_rules: &[],
            path_rules: PathRules::Posix,
            background_work: &BackgroundWorkForms::of_providers(PROVIDERS),
        };

        let document = compose_claude_permissions(&request, &[], Some(PermissionLevel::Sandboxed))
            .expect("the rules compose");

        assert_eq!(
            document.allow,
            [
                "Read(//Users/alice/.claude/agent-memory/**)",
                "Edit(//Users/alice/.claude/agent-memory/**)",
                "Read(//Users/alice/.ai-sidekicks/agent-memory/**)",
                "Edit(//Users/alice/.ai-sidekicks/agent-memory/**)",
            ]
        );
        assert!(
            !document
                .allow
                .iter()
                .chain(&document.deny)
                .any(|rule| rule.starts_with("Write("))
        );
        assert!(
            document
                .deny
                .iter()
                .any(|rule| rule == "Bash(claude agents *)")
        );

        for level in [
            PermissionLevel::Readonly,
            PermissionLevel::Ask,
            PermissionLevel::Reviewed,
            PermissionLevel::Yolo,
        ] {
            let document =
                compose_claude_permissions(&request, &[], Some(level)).expect("the rules compose");
            assert_eq!(document.allow, [] as [String; 0], "{level:?}");
        }
        let reviewed = compose_claude_permissions(&request, &[], Some(PermissionLevel::Reviewed))
            .expect("the rules compose");
        assert_eq!(reviewed.ask, ["Bash(rm *)"]);
    }

    // Killed by an unpicked advisor sent as off, which hides the person's own advisor, and by an
    // advisor turned off left out, which lets the person's own advisor through.
    #[test]
    fn only_an_unpicked_advisor_is_left_to_claude_codes_own_settings() {
        let request = ClaudePermissionsRequest {
            credential_deny_paths: &[],
            memory_folders: &[],
            session_rules: &[],
            path_rules: PathRules::Posix,
            background_work: &BackgroundWorkForms::of_providers(PROVIDERS),
        };
        let advisor_setting = |advisor: ClaudeSessionAdvisor| {
            let settings = compose_claude_spawn_settings(&request, None, &advisor, None, None)
                .expect("the settings compose");
            serde_json::to_value(settings).expect("the settings serialize")["advisorModel"].clone()
        };

        assert_eq!(advisor_setting(ClaudeSessionAdvisor::Unpicked), Value::Null);
        assert_eq!(advisor_setting(ClaudeSessionAdvisor::Off), json!(""));
        assert_eq!(
            advisor_setting(ClaudeSessionAdvisor::Model("opus".to_owned())),
            json!("opus")
        );
    }

    // Killed by a variable dropped from a session's or a short process's document or given another
    // value there, which lets an `env` in the person's own settings files set it (the helper caps
    // lowered under the person's limit, a dialog deadline armed, the build updated mid-session),
    // and by any of them also set in the starting environment.
    #[test]
    fn every_process_sets_the_apps_variables_in_its_document_alone() {
        let request = ClaudePermissionsRequest {
            credential_deny_paths: &[],
            memory_folders: &[],
            session_rules: &[],
            path_rules: PathRules::Posix,
            background_work: &BackgroundWorkForms::of_providers(PROVIDERS),
        };
        let session = compose_claude_spawn_settings(
            &request,
            None,
            &ClaudeSessionAdvisor::Unpicked,
            None,
            None,
        )
        .expect("the settings compose");

        for settings in [session, ClaudeSpawnSettings::short_process(true)] {
            assert_eq!(
                serde_json::to_value(settings).expect("the settings serialize")["env"],
                json!({
                    "DISABLE_AUTOUPDATER": "1",
                    "DISABLE_UPDATES": "1",
                    "CLAUDE_AUTO_BACKGROUND_TASKS": "1",
                    "CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS": "0",
                    "BASH_MAX_TIMEOUT_MS": "2147483647",
                    "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT": "markdown",
                    "CLAUDE_CODE_QUESTION_EXTENDED": "1",
                    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "9223372036854775807",
                    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "9223372036854775807",
                })
            );
        }
        let reserved_names = ReservedEnvironmentNames::of_providers(&[]);
        let environment = compose_claude_environment_without_home(SessionEnvironment {
            base: &[],
            every_project_rows: &[],
            project_rows: &[],
            reserved_names: &reserved_names,
            rules: PathRules::Posix,
        })
        .expect("the environment builds");
        assert_eq!(environment, [] as [(String, String); 0]);
    }
}
