//! The server entry Codex will hold for one binding after a write: the members it held before, the
//! other transport's members removed, the submitted members set, and an emulated `local` binding
//! switched off.

use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::McpWritableBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerConfigInput;

use crate::driver::codex::mcp::config::server_entry::{
    ARGS_MEMBER, AUTH_MEMBER, BEARER_TOKEN_ENV_VAR_MEMBER, BEARER_TOKEN_MEMBER, COMMAND_MEMBER,
    CWD_MEMBER, ENABLED_MEMBER, ENV_HTTP_HEADERS_MEMBER, ENV_MEMBER, ENV_VARS_MEMBER,
    HTTP_HEADERS_HELPER_MEMBER, HTTP_HEADERS_MEMBER, OAUTH_MEMBER, OAUTH_RESOURCE_MEMBER,
    REQUIRED_MEMBER, SCOPES_MEMBER, STARTUP_TIMEOUT_MS_MEMBER, STARTUP_TIMEOUT_SEC_MEMBER,
    TOOL_TIMEOUT_SEC_MEMBER, URL_MEMBER,
};
use crate::driver::mcp_server::write::{
    McpServerEntry, McpServerObservedEntry, McpServerWriteRefusal, SubmittedMember,
    apply_submitted_member, set_member,
};

/// The members only an entry that starts a program holds, removed when an address is submitted.
const PROGRAM_MEMBERS: [&str; 6] = [
    COMMAND_MEMBER,
    ARGS_MEMBER,
    ENV_MEMBER,
    ENV_VARS_MEMBER,
    CWD_MEMBER,
    BEARER_TOKEN_MEMBER,
];

/// The members only an entry that reaches an address holds, removed when a program is submitted.
const ADDRESS_MEMBERS: [&str; 9] = [
    URL_MEMBER,
    BEARER_TOKEN_ENV_VAR_MEMBER,
    BEARER_TOKEN_MEMBER,
    HTTP_HEADERS_HELPER_MEMBER,
    HTTP_HEADERS_MEMBER,
    ENV_HTTP_HEADERS_MEMBER,
    OAUTH_MEMBER,
    OAUTH_RESOURCE_MEMBER,
    AUTH_MEMBER,
];

/// The entry Codex holds for `binding` once `config` is written over `before`. Fails with
/// `McpServerWriteRefusal::EntryInvalid` for a transport Codex reaches no server over, or a value
/// that does not serialize.
pub(crate) fn compose_codex_mcp_entry(
    binding: &McpWritableBindingRef,
    config: &McpServerConfigInput,
    before: &McpServerObservedEntry,
) -> Result<McpServerEntry, McpServerWriteRefusal> {
    let (other_transport_members, submitted) = read_submitted_members(config)?;
    let mut members = before_members(before);
    for member in other_transport_members {
        members.remove(*member);
    }
    for submitted_member in submitted {
        let member = submitted_member.0;
        apply_submitted_member(&mut members, submitted_member);
        // The seconds member takes the place of the older milliseconds one.
        if member == STARTUP_TIMEOUT_SEC_MEMBER {
            members.remove(STARTUP_TIMEOUT_MS_MEMBER);
        }
    }
    match binding {
        // Codex keeps a `local` binding in the user file, switched off.
        McpWritableBindingRef::Local { .. } => {
            members.insert(ENABLED_MEMBER.to_owned(), Value::Bool(false));
        }
        McpWritableBindingRef::User { .. } | McpWritableBindingRef::Project { .. } => {}
    }
    Ok(McpServerEntry::from_members(members))
}

/// The members `before` holds, a write's starting point: an entry's own, the switch alone for a
/// binding the config only switches, and none for an absent one.
pub(super) fn before_members(before: &McpServerObservedEntry) -> Map<String, Value> {
    match before {
        McpServerObservedEntry::Present(entry) => entry.members().clone(),
        McpServerObservedEntry::Switch(is_enabled) => {
            [(ENABLED_MEMBER.to_owned(), Value::Bool(*is_enabled))]
                .into_iter()
                .collect()
        }
        McpServerObservedEntry::Absent => Map::new(),
    }
}

// The members of the transport `config` does not submit, then the members it submits by their
// names in Codex's entry, each set to its value or removed where it is cleared; a member left
// absent is not listed, so the entry keeps it. The one reader of `config`'s members.
fn read_submitted_members(
    config: &McpServerConfigInput,
) -> Result<(&'static [&'static str], Vec<SubmittedMember>), McpServerWriteRefusal> {
    let (other_transport_members, members): (&'static [&'static str], _) = match config {
        McpServerConfigInput::Stdio {
            command,
            args,
            env,
            env_vars,
            enabled,
            required,
            startup_timeout_sec,
            tool_timeout_sec,
        } => (
            &ADDRESS_MEMBERS,
            vec![
                set_member(COMMAND_MEMBER, Some(Some(command)))?,
                set_member(ARGS_MEMBER, args.as_ref().map(Option::as_ref))?,
                set_member(ENV_MEMBER, env.as_ref().map(Option::as_ref))?,
                set_member(ENV_VARS_MEMBER, env_vars.as_ref().map(Option::as_ref))?,
                set_member(ENABLED_MEMBER, enabled.as_ref().map(Some))?,
                set_member(REQUIRED_MEMBER, required.as_ref().map(Some))?,
                set_member(
                    STARTUP_TIMEOUT_SEC_MEMBER,
                    startup_timeout_sec.as_ref().map(Option::as_ref),
                )?,
                set_member(
                    TOOL_TIMEOUT_SEC_MEMBER,
                    tool_timeout_sec.as_ref().map(Option::as_ref),
                )?,
            ],
        ),
        McpServerConfigInput::Http {
            url,
            headers,
            bearer_token_env_var,
            env_http_headers,
            oauth_scopes,
            oauth_resource,
            enabled,
            required,
            startup_timeout_sec,
            tool_timeout_sec,
        } => (
            &PROGRAM_MEMBERS,
            vec![
                set_member(URL_MEMBER, Some(Some(url)))?,
                set_member(HTTP_HEADERS_MEMBER, headers.as_ref().map(Option::as_ref))?,
                set_member(
                    BEARER_TOKEN_ENV_VAR_MEMBER,
                    bearer_token_env_var.as_ref().map(Option::as_ref),
                )?,
                set_member(
                    ENV_HTTP_HEADERS_MEMBER,
                    env_http_headers.as_ref().map(Option::as_ref),
                )?,
                set_member(SCOPES_MEMBER, oauth_scopes.as_ref().map(Option::as_ref))?,
                set_member(
                    OAUTH_RESOURCE_MEMBER,
                    oauth_resource.as_ref().map(Option::as_ref),
                )?,
                set_member(ENABLED_MEMBER, enabled.as_ref().map(Some))?,
                set_member(REQUIRED_MEMBER, required.as_ref().map(Some))?,
                set_member(
                    STARTUP_TIMEOUT_SEC_MEMBER,
                    startup_timeout_sec.as_ref().map(Option::as_ref),
                )?,
                set_member(
                    TOOL_TIMEOUT_SEC_MEMBER,
                    tool_timeout_sec.as_ref().map(Option::as_ref),
                )?,
            ],
        ),
        McpServerConfigInput::Sse { .. } => {
            return Err(McpServerWriteRefusal::EntryInvalid {
                words: "Codex reaches no server over server-sent events.".to_owned(),
            });
        }
    };
    Ok((
        other_transport_members,
        members.into_iter().flatten().collect(),
    ))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::McpWritableBindingRef;
    use sidekicks_contracts::mcp::server::config::McpServerConfigInput;
    use sidekicks_store::events::canonicalizer::canonicalize_json;

    use super::compose_codex_mcp_entry;
    use crate::driver::codex::mcp::config::observe::observe_scripted;
    use crate::driver::mcp_server::write::{McpServerEntry, McpServerObservedEntry};

    // Compose's entry is what Codex's config reads back after the write, in Codex's own form, or
    // every landed write would read as a changed entry. Codex's `config/read` lists each layer as
    // its file holds it, before any merge and with no default added, so the read-back layer is the
    // written file's own table. Killed by keeping `startup_timeout_ms` beside `startup_timeout_sec`,
    // by keeping the program's members on a switch to an address, and by dropping the switch-off
    // of an emulated `local` binding.
    #[rstest]
    #[case::local_add(
        json!({
            "scope": "local", "provider": "codex", "scopeRef": "/work/app", "serverName": "docs"
        }),
        McpServerObservedEntry::Absent,
        json!({"url": "https://example.com/mcp", "startup_timeout_sec": 10.0, "enabled": false})
    )]
    #[case::user_program_to_address(
        json!({"scope": "user", "provider": "codex", "serverName": "docs"}),
        McpServerObservedEntry::Present(McpServerEntry::from_json(json!({
            "command": "npx",
            "args": ["docs-server"],
            "env": {"DOCS_TOKEN": "docs-token"},
            "startup_timeout_ms": 5000.0,
        }))),
        json!({"url": "https://example.com/mcp", "startup_timeout_sec": 10.0})
    )]
    #[tokio::test]
    async fn a_composed_entry_reads_back_as_written(
        #[case] binding: Value,
        #[case] before: McpServerObservedEntry,
        #[case] read_back: Value,
    ) {
        let binding: McpWritableBindingRef =
            serde_json::from_value(binding).expect("the test's binding reads");
        let config: McpServerConfigInput = serde_json::from_value(json!({
            "transport": "http", "url": "https://example.com/mcp", "startupTimeoutSec": 10
        }))
        .expect("the test's declaration reads");

        let composed =
            compose_codex_mcp_entry(&binding, &config, &before).expect("the entry composes");
        let layers = json!([{
            "name": {"type": "user", "file": "/home/person/.codex/config.toml"},
            "version": "sha256:written",
            "config": {"mcp_servers": {"docs": read_back}},
        }]);
        let observed = observe_scripted(&binding.binding(), Path::new("/work/app"), &layers).await;

        let McpServerObservedEntry::Present(observed_entry) = observed.entry else {
            panic!("the written entry reads back as a declaration");
        };
        assert_eq!(
            canonicalize_json(&Value::Object(composed.members().clone()))
                .expect("the composed entry canonicalizes"),
            canonicalize_json(&Value::Object(observed_entry.members().clone()))
                .expect("the read entry canonicalizes")
        );
        assert_eq!(observed.config_version.as_deref(), Some("sha256:written"));
    }
}
