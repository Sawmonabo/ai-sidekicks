//! A person's stdio server started inside the session's sandbox at `Sandboxed`. Codex starts a
//! stdio server with no sandbox of its own, so the entry runs Codex's own `codex sandbox` on the
//! level's profile in the session's worktree, with the session's service home as its Codex home,
//! so the person's own config and profiles never load. The server's environment is the names Codex
//! hands any stdio server and the names its entry declares; their values stay in the entry's
//! environment and never reach the command line.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::{Map, Value, json};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_platforms::PathRules;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::lifecycle::naming::lockdown::write_exec_overrides;
use crate::driver::codex::mcp::config::server_entry::{
    ARGS_MEMBER, COMMAND_MEMBER, ENV_MEMBER, read_stdio_variable_names,
};
use crate::driver::codex::native_program::CodexNativeCommand;
use crate::driver::codex::permission_level::compose_codex_permission_config;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::settings::CodexThreadSettings;

/// The variables Codex hands every stdio server it starts on macOS and Linux, its own default set.
const CODEX_POSIX_SERVER_VARIABLES: &[&str] = &[
    "HOME",
    "LOGNAME",
    "PATH",
    "SHELL",
    "USER",
    "__CF_USER_TEXT_ENCODING",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "TZ",
];

/// The variables Codex hands every stdio server it starts on Windows, its own default set.
const CODEX_WINDOWS_SERVER_VARIABLES: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SHELL",
    "COMSPEC",
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "USERNAME",
    "USERDOMAIN",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PROGRAMDATA",
    "LOCALAPPDATA",
    "APPDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "POWERSHELL",
    "PWSH",
];

/// The variables Codex hands every stdio server it starts on any system, which name a CA bundle.
const CODEX_CA_BUNDLE_VARIABLES: &[&str] = &[
    "CODEX_CA_CERTIFICATE",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "GIT_SSL_CAINFO",
    "CARGO_HTTP_CAINFO",
    "PIP_CERT",
    "BUNDLE_SSL_CA_CERT",
    "npm_config_cafile",
    "NPM_CONFIG_CAFILE",
];

/// Everything a stdio server's entry is wrapped in the session's sandbox with.
#[derive(Clone, Debug)]
pub(crate) struct CodexSandboxWrap {
    /// Codex's native command, the one the session's service runs.
    native_command: CodexNativeCommand,
    /// The session's service home, the sandbox's Codex home.
    service_home: PathBuf,
    /// The id of the level's profile.
    profile_name: String,
    /// The level's profile, as the conversation's `config.permissions` defines it.
    profile: Value,
    /// The session's worktree, where the server runs and the profile's workspace is.
    worktree: PathBuf,
}

/// The wrap of `settings`' session's stdio servers, run by `native_command`, the session's
/// service's, on `service_home`: one at `Sandboxed`, and none at any other level, whose servers
/// Codex starts as declared. Fails with `CodexError::Transport` at `Sandboxed` when the service
/// knows no native command, so no server starts outside the sandbox.
pub(crate) fn compose_codex_sandbox_wrap(
    settings: &CodexThreadSettings,
    native_command: Option<CodexNativeCommand>,
    service_home: PathBuf,
) -> Result<Option<CodexSandboxWrap>, CodexError> {
    if settings.level != PermissionLevel::Sandboxed {
        return Ok(None);
    }
    let native_command = native_command.ok_or_else(|| CodexError::Transport {
        detail: "Codex's program could not be found, so the session's tool servers cannot run \
            in its sandbox."
            .to_owned(),
        cause: None,
    })?;
    let mut config = compose_codex_permission_config(settings.level, &settings.profile_folders);
    let profile = config
        .permissions
        .remove(&config.default_permissions)
        .expect("every level below YOLO defines its own profile");
    Ok(Some(CodexSandboxWrap {
        native_command,
        service_home,
        profile_name: config.default_permissions,
        profile: serde_json::to_value(profile).expect("a profile is string-keyed maps and names"),
        worktree: settings.working_directory.clone(),
    }))
}

/// `entry`, a stdio server's, run inside `wrap`'s sandbox: its `command` Codex's native program,
/// its `args` the native command's leading arguments, the switches that select the level's
/// profile and pin the server's environment to the names it may read, then `sandbox` with the
/// profile and the worktree, then the entry's own command and arguments; its `env` its own with
/// Codex's home set to the service home. Every other member is kept. An entry with no program, an
/// argument that is not text or a variable list that does not read is kept whole, since Codex
/// refuses it before anything starts.
pub(crate) fn wrap_codex_stdio_server(
    wrap: &CodexSandboxWrap,
    entry: &Map<String, Value>,
) -> Map<String, Value> {
    let Some(Value::String(command)) = entry.get(COMMAND_MEMBER) else {
        return entry.clone();
    };
    let arguments = match entry.get(ARGS_MEMBER) {
        None => Vec::new(),
        Some(Value::Array(arguments)) => {
            let Some(arguments) = arguments
                .iter()
                .map(|argument| argument.as_str().map(str::to_owned))
                .collect::<Option<Vec<String>>>()
            else {
                return entry.clone();
            };
            arguments
        }
        Some(_) => return entry.clone(),
    };
    let Some(declared_names) = read_stdio_variable_names(entry) else {
        return entry.clone();
    };
    let mut wrapped = entry.clone();
    wrapped.insert(
        COMMAND_MEMBER.to_owned(),
        Value::String(wrap.native_command.program.to_string_lossy().into_owned()),
    );
    let mut wrapped_arguments = wrap.native_command.leading_arguments.clone();
    wrapped_arguments.extend(write_exec_overrides(vec![
        (
            format!("permissions.{}", wrap.profile_name),
            wrap.profile.clone(),
        ),
        // The server sees the names it may read and no others: Codex's own patterns, which drop
        // a declared `*TOKEN*` name, and any the person set are cleared.
        ("shell_environment_policy.inherit".to_owned(), json!("all")),
        (
            "shell_environment_policy.ignore_default_excludes".to_owned(),
            json!(true),
        ),
        ("shell_environment_policy.exclude".to_owned(), json!([])),
        (
            "shell_environment_policy.include_only".to_owned(),
            json!(server_variable_names(&declared_names)),
        ),
    ]));
    wrapped_arguments.extend([
        "sandbox".to_owned(),
        "-P".to_owned(),
        wrap.profile_name.clone(),
        "-C".to_owned(),
        wrap.worktree.to_string_lossy().into_owned(),
        "--".to_owned(),
        command.clone(),
    ]);
    wrapped_arguments.extend(arguments);
    wrapped.insert(ARGS_MEMBER.to_owned(), json!(wrapped_arguments));
    let mut environment = match entry.get(ENV_MEMBER) {
        Some(Value::Object(environment)) => environment.clone(),
        _ => Map::new(),
    };
    let service_home = wrap.service_home.to_string_lossy().into_owned();
    for name in DESCRIPTOR.credential_home_environment_names {
        environment.insert((*name).to_owned(), Value::String(service_home.clone()));
    }
    wrapped.insert(ENV_MEMBER.to_owned(), Value::Object(environment));
    wrapped
}

// The names a wrapped server may read: Codex's own default set on this system, the CA bundle
// variables Codex hands every server, and the names the entry's `env` and `env_vars` declare.
fn server_variable_names(declared: &[String]) -> BTreeSet<&str> {
    let defaults = match PathRules::NATIVE {
        PathRules::Posix => CODEX_POSIX_SERVER_VARIABLES,
        PathRules::Windows => CODEX_WINDOWS_SERVER_VARIABLES,
    };
    defaults
        .iter()
        .chain(CODEX_CA_BUNDLE_VARIABLES)
        .copied()
        .chain(declared.iter().map(String::as_str))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::session::controls::methods::PermissionLevel;

    use super::{compose_codex_sandbox_wrap, wrap_codex_stdio_server};
    use crate::driver::codex::native_program::CodexNativeCommand;
    use crate::driver::codex::permission_level::{
        CodexProfileFolders, compose_codex_permission_config,
    };
    use crate::driver::codex::thread::settings::CodexThreadSettings;

    /// The session's service home in every case.
    const SERVICE_HOME: &str = "/data/codex-homes/account-1";

    fn settings_at(level: PermissionLevel) -> CodexThreadSettings {
        let folders = CodexProfileFolders {
            working_directory: PathBuf::from("/work/app.feature"),
            git_common_folder: Some(PathBuf::from("/work/app/.git")),
            deny_paths: vec![PathBuf::from("/home/person/.ssh")],
            command_channel_folder: PathBuf::from("/data/command-channels/session"),
        };
        CodexThreadSettings {
            working_directory: folders.working_directory.clone(),
            model: "gpt-5".to_owned(),
            model_context_window: None,
            level,
            profile_folders: folders,
            command_environment: Vec::new(),
            subagent_policy: None,
            helper_roles: Vec::new(),
            tool_servers: Vec::new(),
            base_instructions: None,
            auto_memory: None,
        }
    }

    fn github_entry() -> Map<String, Value> {
        serde_json::from_value(json!({
            "command": "github-server",
            "args": ["--stdio"],
            "env": { "GITHUB_TOKEN": "SECRET-VALUE" },
            "env_vars": ["API_KEY", { "name": "ORG_NAME", "source": "local" }],
            "cwd": "/work/elsewhere",
            "startup_timeout_sec": 20,
        }))
        .expect("the test's entry is an object")
    }

    // The value a `-c key=value` argument sets `key` to, read back as Codex reads it: as TOML.
    fn override_value(arguments: &[String], key: &str) -> toml::Value {
        let prefix = format!("{key}=");
        let written = arguments
            .iter()
            .find_map(|argument| argument.strip_prefix(&prefix))
            .expect("the arguments set the key");
        let mut read: toml::Table =
            toml::from_str(&format!("value = {written}")).expect("the switch's value is TOML");
        read.remove("value").expect("the value was read")
    }

    // The wrap at `Sandboxed` and its absence at every other level. Killed by writing a declared
    // value on the command line, by keeping Codex's own or the person's excludes, which drop a
    // declared `GITHUB_TOKEN`, by leaving a declared name or a CA bundle variable out of the
    // include list, by dropping the native command's leading arguments, by a Codex home left to
    // the person's own folder, by a profile that reads back as another, by touching a member beside
    // the three, by a wrap below or above `Sandboxed`, and by a server started unsandboxed where
    // the service knows no native command.
    #[rstest]
    #[case::read_only(PermissionLevel::Readonly)]
    #[case::ask(PermissionLevel::Ask)]
    #[case::reviewed(PermissionLevel::Reviewed)]
    #[case::sandboxed(PermissionLevel::Sandboxed)]
    #[case::yolo(PermissionLevel::Yolo)]
    fn the_wrap_runs_the_server_in_the_sandbox_with_no_value_on_its_command_line(
        #[case] level: PermissionLevel,
    ) {
        let settings = settings_at(level);
        let without_program =
            compose_codex_sandbox_wrap(&settings, None, PathBuf::from(SERVICE_HOME));
        assert_eq!(
            without_program.is_err(),
            level == PermissionLevel::Sandboxed
        );
        let wrap = compose_codex_sandbox_wrap(
            &settings,
            Some(CodexNativeCommand {
                program: PathBuf::from("/opt/codex/bin/codex"),
                leading_arguments: vec!["--launched-by".to_owned()],
            }),
            PathBuf::from(SERVICE_HOME),
        )
        .expect("a service with a native command wraps its servers");
        let Some(wrap) = wrap else {
            assert_ne!(level, PermissionLevel::Sandboxed);
            return;
        };
        assert_eq!(level, PermissionLevel::Sandboxed);

        let entry = github_entry();
        let wrapped = wrap_codex_stdio_server(&wrap, &entry);
        let arguments: Vec<String> = serde_json::from_value(wrapped["args"].clone())
            .expect("the wrapped arguments are text");
        assert_eq!(wrapped["command"], json!("/opt/codex/bin/codex"));
        assert_eq!(arguments[0], "--launched-by");
        assert!(
            arguments
                .iter()
                .all(|argument| !argument.contains("SECRET-VALUE"))
        );
        assert_eq!(
            override_value(
                &arguments,
                "shell_environment_policy.ignore_default_excludes"
            ),
            toml::Value::Boolean(true)
        );
        assert_eq!(
            override_value(&arguments, "shell_environment_policy.exclude"),
            toml::Value::Array(Vec::new())
        );
        assert_eq!(
            override_value(&arguments, "shell_environment_policy.inherit"),
            toml::Value::String("all".to_owned())
        );
        let include_only = override_value(&arguments, "shell_environment_policy.include_only");
        for name in [
            "GITHUB_TOKEN",
            "API_KEY",
            "ORG_NAME",
            "PATH",
            "SSL_CERT_FILE",
            "NODE_EXTRA_CA_CERTS",
        ] {
            assert!(
                include_only
                    .as_array()
                    .expect("the include list is an array")
                    .contains(&toml::Value::String(name.to_owned())),
                "{name} is included"
            );
        }
        let config = compose_codex_permission_config(level, &settings.profile_folders);
        let profile_name = config.default_permissions.clone();
        assert_eq!(
            override_value(&arguments, &format!("permissions.{profile_name}")),
            toml::Value::try_from(&config.permissions[&profile_name])
                .expect("a profile is a TOML table")
        );
        let tail_start = arguments
            .iter()
            .position(|argument| argument == "sandbox")
            .expect("the arguments run the sandbox");
        assert_eq!(
            arguments[tail_start..],
            [
                "sandbox",
                "-P",
                profile_name.as_str(),
                "-C",
                "/work/app.feature",
                "--",
                "github-server",
                "--stdio"
            ]
        );
        assert_eq!(
            wrapped["env"],
            json!({ "GITHUB_TOKEN": "SECRET-VALUE", "CODEX_HOME": SERVICE_HOME })
        );
        let mut untouched = wrapped;
        for member in ["command", "args", "env"] {
            untouched.insert(member.to_owned(), entry[member].clone());
        }
        assert_eq!(untouched, entry);
    }
}
