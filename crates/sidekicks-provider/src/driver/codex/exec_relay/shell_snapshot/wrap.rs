//! A login shell's command rewritten to source the conversation's snapshot first, in the form
//! Codex's local path builds for an ordinary command: one non-login shell saves the variables a
//! snapshot must not change, sources the snapshot, puts them back, then runs the command's shell
//! on its line.

use std::path::Path;

use serde_json::{Map, Value};

/// The command's own runtime variables that win over the snapshot where its environment sets
/// them.
const RUNTIME_VARIABLES: [&str; 7] = [
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "CODEX_TOOL_CALL_ID",
    "CODEX_VERSION",
    "CODEX_PERMISSION_PROFILE",
    "CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS",
    "CODEX_PLUGIN_METRICS_OUTPUT",
];

/// The variables put back after the snapshot even where the command's environment lacks them, so a
/// snapshot never brings back a value the start left unset.
const RESTORED_EVEN_WHEN_ABSENT: [&str; 4] = [
    "CODEX_PERMISSION_PROFILE",
    "CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS",
    "CODEX_PLUGIN_METRICS_OUTPUT",
    "CODEX_TOOL_CALL_ID",
];

/// The variables Codex never lets a command's shell inherit, matched without case.
const NON_INHERITABLE: [&str; 6] = [
    "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
    "NODE_REPL_AUTH_TOKEN",
    "CODEX_GUARDIAN_DECISIONS_API_KEY",
    "OPENAI_FEDERATION_RULE_ID",
    "OPENAI_IDENTITY_TOKEN_FILE",
    "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
];

/// The variable Codex's network proxy sets while it runs; its proxy variables are put back only
/// then.
const PROXY_ACTIVE_VARIABLE: &str = "CODEX_NETWORK_PROXY_ACTIVE";

/// The proxy and certificate variables Codex's network proxy manages, put back after the snapshot
/// while the proxy runs.
const PROXY_VARIABLES: [&str; 49] = [
    PROXY_ACTIVE_VARIABLE,
    "CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE",
    "CODEX_NETWORK_PROXY_BROKERED_CREDENTIALS",
    "CODEX_NETWORK_ALLOW_LOCAL_BINDING",
    "CODEX_NETWORK_PROXY_ATTRIBUTION",
    "ELECTRON_GET_USE_PROXY",
    "NODE_USE_ENV_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "YARN_HTTP_PROXY",
    "YARN_HTTPS_PROXY",
    "npm_config_http_proxy",
    "npm_config_https_proxy",
    "npm_config_proxy",
    "NPM_CONFIG_HTTP_PROXY",
    "NPM_CONFIG_HTTPS_PROXY",
    "NPM_CONFIG_PROXY",
    "BUNDLE_HTTP_PROXY",
    "BUNDLE_HTTPS_PROXY",
    "PIP_PROXY",
    "DOCKER_HTTP_PROXY",
    "DOCKER_HTTPS_PROXY",
    "WS_PROXY",
    "WSS_PROXY",
    "ws_proxy",
    "wss_proxy",
    "NO_PROXY",
    "no_proxy",
    "npm_config_noproxy",
    "NPM_CONFIG_NOPROXY",
    "YARN_NO_PROXY",
    "BUNDLE_NO_PROXY",
    "ALL_PROXY",
    "all_proxy",
    "FTP_PROXY",
    "ftp_proxy",
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

/// The lines that keep the proxy's own `GIT_SSH_COMMAND`, marked by its prefix, across the
/// snapshot: saved before it runs, then put back after it.
const PROXY_GIT_SSH_CAPTURE: &str =
    "__CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND_SET=\"${GIT_SSH_COMMAND+x}\"
__CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND=\"${GIT_SSH_COMMAND-}\"
case \"$__CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND\" in
  CODEX_PROXY_GIT_SSH_COMMAND=1\\ *) __CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND_LIVE_MARKED=1 ;;
  *) __CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND_LIVE_MARKED= ;;
esac";

/// The lines that put the proxy's marked `GIT_SSH_COMMAND` back after the snapshot.
const PROXY_GIT_SSH_RESTORE: &str = "case \"${GIT_SSH_COMMAND-}\" in
  CODEX_PROXY_GIT_SSH_COMMAND=1\\ *) __CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND_AFTER_MARKED=1 ;;
  *) __CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND_AFTER_MARKED= ;;
esac
if [ -n \"$__CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND_LIVE_MARKED\" ]; then
  if [ -z \"${GIT_SSH_COMMAND+x}\" ] || [ -n \"$__CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND_AFTER_MARKED\" ]; then
    export GIT_SSH_COMMAND=\"$__CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND\"
  fi
elif [ -n \"$__CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND_AFTER_MARKED\" ]; then
  if [ -n \"$__CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND_SET\" ]; then
    export GIT_SSH_COMMAND=\"$__CODEX_SNAPSHOT_PROXY_GIT_SSH_COMMAND\"
  else
    unset GIT_SSH_COMMAND
  fi
fi";

/// Whether a command's shell never inherits `name`, matched without case.
pub(in crate::driver::codex::exec_relay) fn is_non_inheritable(name: &str) -> bool {
    NON_INHERITABLE
        .iter()
        .any(|denied| denied.eq_ignore_ascii_case(name))
}

/// `argv`, a `[shell, "-lc", line, ...]` start whose environment is `environment`, rewritten to
/// source `snapshot` first; `None` for any other start, which runs as it is.
pub(in crate::driver::codex::exec_relay) fn wrap_with_snapshot(
    argv: &[String],
    snapshot: &Path,
    environment: &Map<String, Value>,
) -> Option<Vec<String>> {
    let [shell, flag, line, trailing @ ..] = argv else {
        return None;
    };
    if flag != "-lc" {
        return None;
    }
    let mut override_keys: Vec<&str> = RUNTIME_VARIABLES
        .into_iter()
        .filter(|key| environment.contains_key(*key))
        .chain(RESTORED_EVEN_WHEN_ABSENT)
        .filter(|key| !is_non_inheritable(key))
        .collect();
    override_keys.sort_unstable();
    override_keys.dedup();
    let (override_captures, override_restores) =
        compose_override_exports("__CODEX_SNAPSHOT_OVERRIDE", &override_keys);
    let mut proxy_keys = PROXY_VARIABLES.to_vec();
    proxy_keys.sort_unstable();
    proxy_keys.dedup();
    let (proxy_captures, proxy_restores) =
        compose_override_exports("__CODEX_SNAPSHOT_PROXY_OVERRIDE", &proxy_keys);
    let captures = [
        override_captures,
        format!(
            "{proxy_captures}\n__CODEX_SNAPSHOT_PROXY_ENV_SET=\"${{{PROXY_ACTIVE_VARIABLE}+x}}\""
        ),
        PROXY_GIT_SSH_CAPTURE.to_owned(),
    ]
    .join("\n");
    let restores = [
        override_restores,
        format!(
            "if [ -n \"$__CODEX_SNAPSHOT_PROXY_ENV_SET\" ] || [ -n \"${{{PROXY_ACTIVE_VARIABLE}+x}}\" ]; then\n{proxy_restores}\nfi"
        ),
        PROXY_GIT_SSH_RESTORE.to_owned(),
    ]
    .join("\n");
    let trailing: String = trailing
        .iter()
        .map(|word| format!(" '{}'", quote_single(word)))
        .collect();
    let run_line = format!(
        "exec '{}' -c '{}'{trailing}",
        quote_single(shell),
        quote_single(line)
    );
    let source = format!(
        "if . '{}' >/dev/null 2>&1; then :; fi",
        quote_single(&snapshot.to_string_lossy())
    );
    let script = format!("{captures}\n\n{source}\n\n{restores}\n\n{run_line}");
    Some(vec![shell.clone(), "-c".to_owned(), script])
}

// The lines that save each of `keys` under `prefix` before the snapshot runs and the lines that
// put each back after it: a set variable takes its saved value, an unset one is unset again.
fn compose_override_exports(prefix: &str, keys: &[&str]) -> (String, String) {
    let captures = keys
        .iter()
        .enumerate()
        .map(|(index, key)| {
            format!("{prefix}_SET_{index}=\"${{{key}+x}}\"\n{prefix}_{index}=\"${{{key}-}}\"")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let restores = keys
        .iter()
        .enumerate()
        .map(|(index, key)| {
            let set_variable = format!("{prefix}_SET_{index}");
            let value_variable = format!("{prefix}_{index}");
            format!(
                "if [ -n \"${{{set_variable}}}\" ]; then\n  if [ -z \"${{{key}+x}}\" ] || [ \"${{{key}-}}\" != \"${{{value_variable}}}\" ]; then export {key}=\"${{{value_variable}}}\"; else export {key}; fi\nelse builtin unset {key} 2>/dev/null || command unset {key}; fi\nbuiltin unset {set_variable} {value_variable} 2>/dev/null || command unset {set_variable} {value_variable}"
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    (captures, restores)
}

// `text` made safe inside single quotes.
fn quote_single(text: &str) -> String {
    text.replace('\'', r#"'"'"'"#)
}
