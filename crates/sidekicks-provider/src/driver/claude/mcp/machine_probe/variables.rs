//! How a probed entry's `${VAR}` references are filled, as Claude Code fills a server's entry when
//! it loads it: a plugin's own placeholders first, then each variable from the probe's
//! environment, a credential variable read as empty. A program's command, arguments and
//! environment blank a covered name only where it is set; a remote server's address and headers
//! blank it whether set or not and ignore its `:-default`, so no credential leaves for a server
//! the entry names. The lists and patterns are Claude Code 2.1.310's, cited by byte offset in its
//! bundle.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::{Captures, Regex};
use sidekicks_ipc::redaction::scrub_credentials;

use crate::driver::claude::session::transport::control::ClaudeToolServerEntry;

/// What a plugin's placeholders read: `${CLAUDE_PLUGIN_ROOT}` its install root,
/// `${CLAUDE_PLUGIN_DATA}` its data folder and `${CLAUDE_PROJECT_DIR}` the root the probe runs
/// at, left as written where it runs at none.
pub(super) struct ClaudePluginPlaceholders {
    /// The plugin's install root.
    pub(super) root: String,
    /// The plugin's data folder.
    pub(super) data: String,
    /// The root the probe's process runs at.
    pub(super) project: Option<String>,
}

// Where a filled value goes: to a program the probe starts, or to a remote server.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ValueSink {
    Program,
    Remote,
}

// Names a program's values blank where set (`x4().plain`, b:18425355): the static part of `DYr`
// (b:11442296), that is `qwn` with `cfe` (b:9324785, b:9325189), its fixed `CLAUDE_CODE_*` names
// and `_rt` with `gkt` (b:11434842, b:11431226). `DOt`, which `x4` adds under `INPUT_` too, is
// `INPUT_COVERED` below.
const PROGRAM_COVERED: &[&str] = &[
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    "CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_ARTIFACTS_API_TOKEN",
    "CLAUDE_CODE_SLACK_TAG_TOKEN",
    "CLAUDE_CODE_HFI_BEARER_TOKEN",
    "CLAUDE_BRIDGE_OAUTH_TOKEN",
    "CLAUDE_TRUSTED_DEVICE_TOKEN",
    "AGENT_PROXY_AUTH_TOKEN",
    "CLAUDE_CODE_MCP_SERVE_AUTH_TOKEN",
    "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
    "CLAUDE_BG_SOCKET_TOKENS_PATH",
    "CLAUDE_BG_RV_AUTH",
    "CLAUDE_BG_PTY_AUTH",
    "CLAUDE_BG_CLAIM_AUTH",
    "CLAUDE_CODE_SUBSCRIPTION_TYPE",
    "CLAUDE_CODE_RATE_LIMIT_TIER",
    "CLAUDE_CODE_PLUGIN_ATTRIBUTION",
    "CLAUDE_CODE_SKILL_ATTRIBUTION",
    "CLAUDE_CODE_BRIDGE_CHILD_AUTO_DEFAULT",
    "CLAUDE_CODE_BRIDGE_CHILD_ARTIFACT",
    "CLAUDE_CODE_BRIDGE_CHILD_MACHINE_SETTINGS",
    "CLAUDE_CODE_BRIDGE_CHILD_PROJECTS_ENTRYPOINT",
    "CLAUDE_CODE_CONFIG_PROBE",
    "CLAUDE_CODE_HOST_PROMPT_SUPERSEDES_RECORD",
    "CLAUDE_CODE_MCP_SERVE_SETTINGS",
    "CLAUDE_CODE_MCP_SERVE_ENABLED_PLUGINS",
    "CLAUDE_CODE_REMOTE_TOOLS_FORWARD",
    "CLAUDE_CODE_MCP_SERVE_WORKSPACE_ROOT",
    "CLAUDE_CODE_SESSION_KIND",
    "CLAUDE_BG_SOURCE",
    "CLAUDE_BG_ISOLATION",
    "CLAUDE_BG_BACKEND",
    "CLAUDE_CODE_SESSION_NAME",
    "CLAUDE_CODE_RESUME_INTERRUPTED_TURN",
    "CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS",
    "CLAUDE_CODE_RESUME_PROMPT",
    "CLAUDE_CODE_RESUME_SHOWS_CUT_OFF_CALLS",
    "CLAUDE_CODE_RESUME_REASON",
    "CLAUDE_CODE_RESUME_SOURCE_ALIVE",
    "CLAUDE_BG_POST_CLEAR_RESPAWN",
    "CLAUDE_BG_SESSION_PERMISSION_RULES",
    "CLAUDE_BG_MEMORY_TOGGLED_OFF",
    "CLAUDE_BG_AUTO_MEMORY_OFF",
    "CLAUDE_BG_WORKSPACE_TRUSTED",
    "CLAUDE_BG_CARRIED_PROMPTS_SHA256",
    "CLAUDE_BG_GATEWAY_WITHHELD",
    "CLAUDE_CODE_RELAUNCH_HOME_TRUST",
    "CLAUDE_BG_DISPATCHER_SUBSCRIPTION_TYPE",
    "CLAUDE_BG_DISPATCHER_RATE_LIMIT_TIER",
];

// Names a program's values blank where set, bare and under `INPUT_`: `zmo` (b:18425033), which
// `DOt` doubles.
const INPUT_COVERED: &[&str] = &[
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
    "CLAUDE_CODE_HOST_CREDS_FILE",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "MCP_CLIENT_SECRET",
    "MCP_XAA_IDP_CLIENT_SECRET",
    "ENVIRONMENT_SERVICE_KEY",
    "SELF_HOSTED_RUNNER_POOL_SECRET",
    "SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET",
];

// Names a remote server's values also blank, bare and under `INPUT_` (`Vmo`, b:18425355): `eo`
// (b:9973102) less `Kmo`'s five (b:18425355), then `qmo` (b:18425355).
const REMOTE_COVERED: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_ARTIFACTS_API_TOKEN",
    "CLAUDE_CODE_MEMORY_API_TOKEN",
    "CLAUDE_CODE_SLACK_TAG_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_CUSTOM_HEADERS",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_GHA_CREDS_PATH",
    "AZURE_CLIENT_SECRET",
    "IDENTITY_HEADER",
    "MSI_SECRET",
    "AZURE_CLIENT_CERTIFICATE_PATH",
    "AZURE_CLIENT_CERTIFICATE_PASSWORD",
    "AZURE_PASSWORD",
    "AZURE_FEDERATED_TOKEN_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "CLOUDSDK_AUTH_ACCESS_TOKEN",
    "GOOGLE_OAUTH_ACCESS_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "NODE_AUTH_TOKEN",
    "NUGET_AUTH_TOKEN",
    "CARGO_REGISTRY_TOKEN",
    "TWINE_PASSWORD",
    "TWINE_USERNAME",
    "PYPI_TOKEN",
    "PYPI_API_TOKEN",
    "UV_PUBLISH_TOKEN",
    "UV_PUBLISH_PASSWORD",
    "UV_PUBLISH_USERNAME",
    "FLIT_PASSWORD",
    "FLIT_USERNAME",
    "HATCH_INDEX_AUTH",
    "HATCH_INDEX_USER",
    "GEM_HOST_API_KEY",
    "MATURIN_PYPI_TOKEN",
    "MATURIN_PASSWORD",
    "MATURIN_USERNAME",
    "CONAN_LOGIN_USERNAME",
    "CONAN_PASSWORD",
    "ANACONDA_API_TOKEN",
    "BINSTAR_API_TOKEN",
    "VAULT_TOKEN",
    "VAULT_AUTH_TOKEN",
    "VAULT_ROLE_ID",
    "VAULT_SECRET_ID",
    "CONSUL_HTTP_TOKEN",
    "CONSUL_HTTP_AUTH",
    "NOMAD_TOKEN",
    "NOMAD_HTTP_AUTH",
    "CI_REGISTRY_USER",
    "CI_DEPLOY_USER",
    "JF_USER",
    "FASTLANE_SESSION",
    "MATCH_GIT_BASIC_AUTHORIZATION",
    "SONAR_TOKEN",
    "SONARQUBE_SCANNER_PARAMS",
    "SONAR_SCANNER_JSON_PARAMS",
    "SLACK_WEBHOOK_URL",
    "SLACK_WEBHOOK",
    "DISCORD_WEBHOOK",
    "DISCORD_WEBHOOK_URL",
    "TEAMS_WEBHOOK_URL",
    "MS_TEAMS_WEBHOOK_URI",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
    "CLOUDSDK_AUTH_AUTHORIZATION_TOKEN_FILE",
    "AZURE_AUTH_LOCATION",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_RUNTIME_URL",
    "ALL_INPUTS",
    "VSS_NUGET_EXTERNAL_FEED_ENDPOINTS",
    "ARTIFACTS_CREDENTIALPROVIDER_EXTERNAL_FEED_ENDPOINTS",
    "VSS_NUGET_ACCESSTOKEN",
    "ARTIFACTS_CREDENTIALPROVIDER_ACCESSTOKEN",
    "COMPOSER_AUTH",
    "OVERRIDE_GITHUB_TOKEN",
    "DEFAULT_WORKFLOW_TOKEN",
    "SSH_SIGNING_KEY",
    "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
    "CLAUDE_CODE_CLIENT_KEY",
    "CLAUDE_CODE_CLIENT_CERT",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "CODEARTIFACT_AUTH_TOKEN",
    "PIP_INDEX_URL",
    "PIP_EXTRA_INDEX_URL",
    "UV_INDEX_URL",
    "UV_EXTRA_INDEX_URL",
    "UV_DEFAULT_INDEX",
    "UV_INDEX",
    "GOPROXY",
    "GOAUTH",
];

// Endpoint names a remote server's values blank, bare and under `INPUT_`, where the value carries
// a credential (`AHe`, `Zmo`, b:18425355): `Yj`'s `_BASE_URL` names (b:9321777, with `qi` and
// `To`, b:9321438) and `CLAUDE_CODE_API_BASE_URL`.
const CREDENTIALED_ENDPOINTS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "CLAUDE_CODE_ARTIFACTS_API_BASE_URL",
    "CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL",
    "CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL",
    "CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL",
    "CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL",
    "CLAUDE_CODE_MEMORY_API_BASE_URL",
    "CLAUDE_CODE_API_BASE_URL",
];

// The prefixes under which a name passes `Ewn`'s first test (`Qn`, `Wo`, b:9992354), and those
// that cover every name under them (`Nt`, `Bo`).
const PACKAGE_CREDENTIAL_PREFIXES: &[&str] = &[
    "INPUT_",
    "ORG_GRADLE_PROJECT_",
    "POETRY_PYPI_TOKEN_",
    "POETRY_HTTP_BASIC_",
    "CARGO_REGISTRIES_",
    "CONAN_LOGIN_USERNAME_",
    "CONAN_PASSWORD_",
];
const PACKAGE_LOGIN_PREFIXES: &[&str] = &["POETRY_HTTP_BASIC_", "CONAN_LOGIN_USERNAME_"];

// The Bundler setting words a `BUNDLE_<word>__…` name may start with and still not be a
// credential, unless its rest names a host (`Zn`, `Mo`, `vwn`, b:9991402).
const BUNDLE_SETTING_WORDS: &[&str] = &[
    "BUILD", "LOCAL", "MIRROR", "PATH", "WITH", "WITHOUT", "CACHE", "DISABLE", "IGNORE", "ONLY",
];

/// `entry` with each `${VAR}` and `${VAR:-default}` in its program, arguments, environment,
/// address and headers filled from `environment` by Claude Code's rule, a plugin's placeholders
/// filled first and its root and data folder handed to its program's environment; a variable with
/// no value and no default is left as written.
pub(super) fn expand_entry_variables(
    entry: ClaudeToolServerEntry,
    environment: &[(String, String)],
    plugin: Option<&ClaudePluginPlaceholders>,
) -> ClaudeToolServerEntry {
    let expand = |value: String, sink: ValueSink| {
        let filled = match plugin {
            Some(plugin) => fill_plugin_placeholders(&value, plugin),
            None => value,
        };
        expand_variables(&filled, environment, sink)
    };
    let expand_values = |values: BTreeMap<String, String>, sink: ValueSink| {
        values
            .into_iter()
            .map(|(name, value)| (name, expand(value, sink)))
            .collect::<BTreeMap<_, _>>()
    };
    match entry {
        ClaudeToolServerEntry::Stdio { command, args, env } => {
            let mut env = expand_values(env, ValueSink::Program);
            if let Some(plugin) = plugin {
                // Claude Code hands a plugin's program these two unless its entry sets them.
                for (name, value) in [
                    ("CLAUDE_PLUGIN_ROOT", &plugin.root),
                    ("CLAUDE_PLUGIN_DATA", &plugin.data),
                ] {
                    env.entry(name.to_owned()).or_insert_with(|| value.clone());
                }
            }
            ClaudeToolServerEntry::Stdio {
                command: expand(command, ValueSink::Program),
                args: args
                    .into_iter()
                    .map(|argument| expand(argument, ValueSink::Program))
                    .collect(),
                env,
            }
        }
        ClaudeToolServerEntry::Http { url, headers } => ClaudeToolServerEntry::Http {
            url: expand(url, ValueSink::Remote),
            headers: expand_values(headers, ValueSink::Remote),
        },
        ClaudeToolServerEntry::Sse { url, headers } => ClaudeToolServerEntry::Sse {
            url: expand(url, ValueSink::Remote),
            headers: expand_values(headers, ValueSink::Remote),
        },
        sdk @ ClaudeToolServerEntry::Sdk { .. } => sdk,
    }
}

// `value` with a plugin's three placeholders filled (`mde`, b:12908654).
fn fill_plugin_placeholders(value: &str, plugin: &ClaudePluginPlaceholders) -> String {
    let filled = value
        .replace("${CLAUDE_PLUGIN_ROOT}", &plugin.root)
        .replace("${CLAUDE_PLUGIN_DATA}", &plugin.data);
    match &plugin.project {
        Some(project) => filled.replace("${CLAUDE_PROJECT_DIR}", project),
        None => filled,
    }
}

// `value` with each `${VAR}` filled from `environment`'s last setting of `VAR`, a set value, even
// an empty one, before any default, and each covered name read as empty (`P4`, b:18427479).
fn expand_variables(value: &str, environment: &[(String, String)], sink: ValueSink) -> String {
    static VARIABLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")
            .expect("the variable pattern compiles")
    });
    VARIABLE
        .replace_all(value, |captures: &Captures<'_>| {
            let name = &captures[1];
            let set = environment
                .iter()
                .rev()
                .find(|(set_name, _value)| set_name == name)
                .map(|(_name, value)| value.as_str());
            let is_blanked =
                (set.is_some() || sink == ValueSink::Remote) && is_covered(name, set, sink);
            match (is_blanked, set, captures.get(2)) {
                (true, _set, _default) => String::new(),
                (false, Some(set), _default) => set.to_owned(),
                (false, None, Some(default)) => default.as_str().to_owned(),
                (false, None, None) => captures[0].to_owned(),
            }
        })
        .into_owned()
}

// Whether Claude Code reads `name` as empty in a value bound for `sink`: a name of the program
// set or `yqe`'s, and for a remote server also the remote set, `CHe`'s patterns and an endpoint
// carrying a credential. Names compare upper-cased, as Claude Code compares them.
fn is_covered(name: &str, value: Option<&str>, sink: ValueSink) -> bool {
    let name = name.to_ascii_uppercase();
    let is_listed = |list: &[&str]| list.contains(&name.as_str());
    let is_listed_with_input = |list: &[&str]| {
        is_listed(list)
            || name
                .strip_prefix("INPUT_")
                .is_some_and(|bare| list.contains(&bare))
    };
    if is_listed(PROGRAM_COVERED)
        || is_listed_with_input(INPUT_COVERED)
        || is_claude_variable(&name)
    {
        return true;
    }
    sink == ValueSink::Remote
        && (is_listed_with_input(REMOTE_COVERED)
            || is_credential_pattern(&name)
            || (is_listed_with_input(CREDENTIALED_ENDPOINTS)
                && value.is_some_and(|value| scrub_credentials(value) != value)))
}

// `yqe` (b:11442044): Claude Code's own artifact and memory endpoints and its telemetry settings,
// bare or under `INPUT_`, for an upper-cased name.
fn is_claude_variable(name: &str) -> bool {
    let name = name.strip_prefix("INPUT_").unwrap_or(name);
    (name.starts_with("CLAUDE_CODE_ARTIFACT") && name.ends_with("_BASE_URL"))
        || name == "CLAUDE_CODE_MEMORY_API_BASE_URL"
        || name == "CLAUDE_CODE_MEMORY_API_TOKEN"
        || name.starts_with("OTEL_")
        || name == "CLAUDE_CODE_OTEL_DIAG_STDERR"
}

// `CHe` (b:18425355) for an upper-cased name: a git config pair, a Cargo registry token, a
// package tool's login and a Bundler host credential, `INPUT_` stripped once.
fn is_credential_pattern(name: &str) -> bool {
    static GIT_CONFIG: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^GIT_CONFIG_(?:PARAMETERS|(?:KEY|VALUE)_[0-9]+)$")
            .expect("the git config pattern compiles")
    });
    static CARGO_REGISTRY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^CARGO_REGISTRIES_[A-Z0-9_]+_TOKEN$")
            .expect("the cargo registry pattern compiles")
    });
    let bare = name.strip_prefix("INPUT_").unwrap_or(name);
    is_claude_variable(name)
        || GIT_CONFIG.is_match(bare)
        || CARGO_REGISTRY.is_match(bare)
        || is_package_credential(bare)
        || is_bundler_credential(bare)
}

// `Ewn` (b:9992640) for an upper-cased name: one under a package tool's prefix that is a login or
// reads as a secret.
fn is_package_credential(name: &str) -> bool {
    static LOGIN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"USER(?:_?NAME)?_?[0-9]*$").expect("the login pattern compiles")
    });
    let name = name.replace('-', "_");
    let starts_with_any =
        |text: &str, prefixes: &[&str]| prefixes.iter().any(|prefix| text.starts_with(prefix));
    let bare = name.strip_prefix("INPUT_").unwrap_or(&name);
    starts_with_any(&name, PACKAGE_CREDENTIAL_PREFIXES)
        && (starts_with_any(bare, PACKAGE_LOGIN_PREFIXES)
            || LOGIN.is_match(&name)
            || is_secret_name(&name))
}

// `Ebe` (b:9991233) for an upper-cased name: one whose words read as a secret, a connection
// string or a Bundler host credential, and no git config key.
fn is_secret_name(name: &str) -> bool {
    static SECRET_WORD: LazyLock<Regex> = LazyLock::new(|| {
        // `Tn` (b:9982118, its word lists b:9981200), its look-ahead consumed, which finds the
        // same names.
        let words = "TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|KEY|AUTH|COOKIE|PAT|DSN|WEBHOOK|\
                     CREDENTIAL|CREDENTIALS|CREDS|APIKEY|ACCESSKEY|SECRETKEY|ACCOUNTKEY|PRIVATEKEY|\
                     AUTHKEY|SSHKEY|SIGNINGKEY|MASTERKEY|DEPLOYKEY|ENCRYPTIONKEY|PGPASSWORD|SSHPASS";
        Regex::new(&format!(
            "(?:(?:^|_)(?:{words}|(?:KEY|SECRET|PASSWORD|CREDENTIAL)S)|_(?:PWD|PASS|JWT)|\
             (?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE))(?:$|[_0-9])"
        ))
        .expect("the secret word pattern compiles")
    });
    static CONNECTION_STRING: LazyLock<Regex> = LazyLock::new(|| {
        // `Tt` (b:9981200).
        Regex::new(r"CONN(?:ECT(?:ION)?)?_?STR(?:ING)?S?(?:$|[_0-9])")
            .expect("the connection string pattern compiles")
    });
    static GIT_CONFIG_KEY: LazyLock<Regex> = LazyLock::new(|| {
        // `po` (b:9982286).
        Regex::new(r"^GIT_CONFIG_KEY_[0-9][A-Za-z0-9_]*$").expect("the git key pattern compiles")
    });
    let stripped = name
        .strip_prefix("AUTH0_")
        .unwrap_or(name)
        .replace('-', "_");
    let words = split_words(&stripped);
    (SECRET_WORD.is_match(&stripped)
        || SECRET_WORD.is_match(&words)
        || CONNECTION_STRING.is_match(&stripped)
        || CONNECTION_STRING.is_match(&words)
        || is_bundler_credential(&stripped))
        && !GIT_CONFIG_KEY.is_match(name)
}

// `Mn` (b:9981200) for an upper-cased name: `_` between a digit and the capital after it.
fn split_words(name: &str) -> String {
    static DIGIT_THEN_CAPITAL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"([0-9])([A-Z])").expect("the word pattern compiles"));
    DIGIT_THEN_CAPITAL
        .replace_all(name, "${1}_${2}")
        .into_owned()
}

// `vwn` (b:9991548) for an upper-cased name: `BUNDLE_…__…`, bare or under `INPUT_`, unless it
// starts with a Bundler setting word whose rest does not name a host.
fn is_bundler_credential(name: &str) -> bool {
    static HOST_KEY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:[A-Za-z0-9]+(?:___[A-Za-z0-9]+)*__)+[A-Za-z]{2,}$")
            .expect("the host key pattern compiles")
    });
    let bare = name.strip_prefix("INPUT_").unwrap_or(name);
    let Some(rest) = bare.strip_prefix("BUNDLE_") else {
        return false;
    };
    let is_setting = BUNDLE_SETTING_WORDS.iter().any(|word| {
        rest.strip_prefix(word)
            .and_then(|after| after.strip_prefix("__"))
            .is_some_and(|host| !HOST_KEY.is_match(host))
    });
    let word_run = rest
        .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .next()
        .unwrap_or_default();
    !is_setting && word_run.contains("__")
}
