//! The `mcp_servers` table one Codex start, resume or fork carries, composed against the servers
//! that call's own `config/read` loads. Codex merges the table into its own config by name and by
//! member, so a server of the person's the session leaves out is switched off by name, never
//! dropped: each loaded server is switched off unless the session switches it on here, a `local`
//! or `project` binding only in its own repository; a server the session switches on that the
//! read does not load is sent whole, its values read for this call from the person's own Codex
//! folder; and the daemon's own server goes on its route, its secret in a header.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Map, Value, json};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};

use crate::driver::codex::mcp::config::server_entry::{ARGS_MEMBER, COMMAND_MEMBER, ENV_MEMBER};
use crate::driver::codex::mcp::sandbox_wrap::{CodexSandboxWrap, wrap_codex_stdio_server};
use crate::driver::codex::mcp::server_name::CODEX_MCP_SERVER_NAMES;
use crate::driver::codex::thread::settings::MCP_SERVERS_KEY;
use crate::driver::codex::thread::settings::tool_servers::{
    CODEX_DAEMON_TOOL_SERVER_NAMES, insert_codex_daemon_tool_servers,
};
use crate::driver::mcp_server::write::{ENTRY_SWITCH_MEMBER, McpServerEntry};
use crate::driver::session_control::SessionToolServer;
use crate::port::tool_server_route::OpenedToolServerRoute;
use crate::tool_server_name::McpServerNameRefusal;

/// The servers one call's `config/read` loads, by name, each with its entry's members, values
/// included. It lives in memory for that call alone and is written nowhere.
#[derive(Clone, Debug, Default)]
pub(crate) struct CodexLoadedServers {
    servers: BTreeMap<String, McpServerEntry>,
}

impl CodexLoadedServers {
    /// The servers `config`, Codex's effective config for a folder, loads: each member of its
    /// `mcp_servers` table, an entry that is no table read with no members.
    pub(crate) fn of_config(config: Value) -> Self {
        let Value::Object(mut config) = config else {
            return Self::default();
        };
        let Some(Value::Object(servers)) = config.remove(MCP_SERVERS_KEY) else {
            return Self::default();
        };
        let servers = servers
            .into_iter()
            .map(|(name, entry)| {
                let members = match entry {
                    Value::Object(members) => members,
                    Value::Null
                    | Value::Bool(_)
                    | Value::Number(_)
                    | Value::String(_)
                    | Value::Array(_) => Map::new(),
                };
                (name, McpServerEntry::from_members(members))
            })
            .collect();
        Self { servers }
    }

    /// Whether `other` loads exactly the names this read loads. Names alone decide, since the
    /// table switches a loaded server by its name and never sends its members.
    pub(crate) fn has_same_names(&self, other: &Self) -> bool {
        self.servers.keys().eq(other.servers.keys())
    }

    /// The entry the read loads under `name`, its members as Codex merged them.
    pub(crate) fn entry(&self, name: &str) -> Option<&McpServerEntry> {
        self.servers.get(name)
    }

    fn is_loaded(&self, name: &str) -> bool {
        self.servers.contains_key(name)
    }

    fn names(&self) -> impl Iterator<Item = &str> {
        self.servers.keys().map(String::as_str)
    }
}

/// Everything one call's `mcp_servers` table is composed from.
#[derive(Clone, Copy)]
pub(crate) struct CodexSessionTableInput<'input> {
    /// The session's own tool servers, each with the person's switch.
    pub(crate) tool_servers: &'input [SessionToolServer],
    /// What the call's own `config/read` loads.
    pub(crate) loaded: &'input CodexLoadedServers,
    /// The whole entry of each server [`codex_unloaded_bindings`] names, read for this call from
    /// the person's own Codex folder; a binding the folder declares no transport for has none.
    pub(crate) unloaded_entries: &'input [(McpServerBindingRef, McpServerEntry)],
    /// The daemon's tool-server entries the spawn opened, once the route's owner registered it.
    pub(crate) route: Option<&'input OpenedToolServerRoute>,
    /// The root of the repository the conversation runs in, which a
    /// `local` or `project` binding must name to be switched on here.
    pub(crate) repository_root: &'input Path,
    /// Whether the call is a side question's copy, which reaches no tool server.
    pub(crate) is_copy_fork: bool,
    /// The wrap each stdio server the session switches on runs in, at `Sandboxed` only.
    pub(crate) sandbox_wrap: Option<&'input CodexSandboxWrap>,
}

/// The `mcp_servers` table of one call: each loaded server `{"enabled": false}` unless the
/// session switches it on here, then `{"enabled": true}`; each server the session switches on
/// that the read does not load sent whole with `"enabled": true`; and the daemon's own server on
/// its route, none without one. With a sandbox wrap, each stdio server switched on runs inside it:
/// a loaded one carries its wrapped `command`, `args` and `env`, an unloaded one is sent wrapped.
/// A copy fork's table switches every loaded server off and holds nothing else. A name Codex
/// keeps for its own server is never sent.
pub(crate) fn compose_codex_session_table(table: CodexSessionTableInput<'_>) -> Map<String, Value> {
    let mut servers = Map::new();
    for name in table.loaded.names() {
        if !is_kept_by_codex(name) {
            servers.insert(name.to_owned(), json!({ ENTRY_SWITCH_MEMBER: false }));
        }
    }
    if table.is_copy_fork {
        return servers;
    }
    for binding in switched_on_here(table.tool_servers, table.repository_root) {
        let name = binding.server_name().as_str();
        if is_kept_by_codex(name) {
            continue;
        }
        if table.loaded.is_loaded(name) {
            let mut members = Map::new();
            if let Some((wrap, entry)) = table.sandbox_wrap.zip(table.loaded.entry(name))
                && entry.members().contains_key(COMMAND_MEMBER)
            {
                // Codex merges by member, so the three the wrap replaces are all it needs.
                let mut wrapped = wrap_codex_stdio_server(wrap, entry.members());
                for member in [COMMAND_MEMBER, ARGS_MEMBER, ENV_MEMBER] {
                    if let Some(value) = wrapped.remove(member) {
                        members.insert(member.to_owned(), value);
                    }
                }
            }
            members.insert(ENTRY_SWITCH_MEMBER.to_owned(), Value::Bool(true));
            servers.insert(name.to_owned(), Value::Object(members));
            continue;
        }
        // A binding the person's folder declares no transport for has no entry to send.
        if let Some((_, entry)) = table
            .unloaded_entries
            .iter()
            .find(|(unloaded, _)| unloaded == binding)
        {
            let mut members = match table.sandbox_wrap {
                Some(wrap) => wrap_codex_stdio_server(wrap, entry.members()),
                None => entry.members().clone(),
            };
            members.insert(ENTRY_SWITCH_MEMBER.to_owned(), Value::Bool(true));
            servers.insert(name.to_owned(), Value::Object(members));
        }
    }
    if let Some(route) = table.route {
        insert_codex_daemon_tool_servers(&mut servers, route);
    }
    servers
}

/// The bindings of `tool_servers` the session switches on in `repository_root` that `loaded`
/// lacks, whose whole entries a call's table needs read from the person's own Codex folder.
pub(crate) fn codex_unloaded_bindings<'servers>(
    tool_servers: &'servers [SessionToolServer],
    loaded: &CodexLoadedServers,
    repository_root: &Path,
) -> impl Iterator<Item = &'servers McpServerBindingRef> {
    switched_on_here(tool_servers, repository_root).filter(|binding| {
        let name = binding.server_name().as_str();
        !loaded.is_loaded(name) && !is_kept_by_codex(name)
    })
}

/// Whether a call's table for `tool_servers` in `repository_root` leaves `name` running: the
/// daemon's own servers, a name Codex keeps for a server of its own, or a server the session
/// switches on there.
pub(crate) fn is_run_by_codex_table(
    tool_servers: &[SessionToolServer],
    repository_root: &Path,
    name: &str,
) -> bool {
    CODEX_DAEMON_TOOL_SERVER_NAMES.contains(&name)
        || is_kept_by_codex(name)
        || switched_on_here(tool_servers, repository_root)
            .any(|binding| binding.server_name().as_str() == name)
}

// Each binding of `tool_servers` the person switched on that applies in `repository_root`: a
// `local` or `project` binding only where its root is that repository's.
fn switched_on_here<'servers>(
    tool_servers: &'servers [SessionToolServer],
    repository_root: &Path,
) -> impl Iterator<Item = &'servers McpServerBindingRef> {
    tool_servers
        .iter()
        .filter(|tool_server| tool_server.is_enabled)
        .map(|tool_server| &tool_server.binding)
        .filter(move |binding| match binding {
            McpServerBindingRef::Local { scope_ref, .. }
            | McpServerBindingRef::Project { scope_ref, .. } => {
                Path::new(scope_ref.as_str()) == repository_root
            }
            McpServerBindingRef::User { .. }
            | McpServerBindingRef::Plugin { .. }
            | McpServerBindingRef::Connector { .. }
            | McpServerBindingRef::Managed { .. } => true,
        })
}

// Whether Codex keeps `name` for a server of its own; a name no server name can hold is not one.
fn is_kept_by_codex(name: &str) -> bool {
    McpServerName::new(name.to_owned()).is_ok_and(|name| {
        CODEX_MCP_SERVER_NAMES.check(&name) == Err(McpServerNameRefusal::KeptByProvider)
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::mcp::server::McpServerBindingRef;

    use sidekicks_contracts::session::controls::methods::PermissionLevel;

    use super::{
        CodexLoadedServers, CodexSessionTableInput, codex_unloaded_bindings,
        compose_codex_session_table,
    };
    use crate::driver::codex::mcp::sandbox_wrap::{
        compose_codex_sandbox_wrap, wrap_codex_stdio_server,
    };
    use crate::driver::codex::native_program::CodexNativeCommand;
    use crate::driver::codex::permission_level::{CodexProfileFolders, codex_repository_root};
    use crate::driver::codex::thread::settings::CodexThreadSettings;
    use crate::driver::codex::thread::settings::tool_servers::CODEX_OPENED_TOOL_SERVER_NAMES;
    use crate::driver::mcp_server::write::McpServerEntry;
    use crate::driver::session_control::SessionToolServer;
    use crate::port::tool_server_route::{OpenedToolServerRoute, ToolServerRouteEntry};

    /// The repository every test conversation runs in, from a linked worktree of it.
    const REPOSITORY: &str = "/work/app";

    // The daemon's entries a spawn opens, each at a fixed address under a fixed secret, as the
    // route opens every name it is handed.
    fn opened_route() -> OpenedToolServerRoute {
        OpenedToolServerRoute::new(
            CODEX_OPENED_TOOL_SERVER_NAMES
                .iter()
                .map(|server_name| ToolServerRouteEntry {
                    server_name: (*server_name).to_owned(),
                    url: format!("http://127.0.0.1:1/tools/{server_name}"),
                    http_headers: vec![(
                        "Authorization".to_owned(),
                        "Bearer spawn-secret".to_owned(),
                    )],
                    tool_input_schema_max_bytes: 4_096,
                })
                .collect(),
            Box::new(()),
        )
    }

    // The binding `json`, a Codex binding in the wire's form.
    fn binding(json: Value) -> McpServerBindingRef {
        serde_json::from_value(json).expect("the test's binding reads")
    }

    fn user(name: &str) -> McpServerBindingRef {
        binding(json!({ "scope": "user", "provider": "codex", "serverName": name }))
    }

    fn local(name: &str, root: &str) -> McpServerBindingRef {
        binding(json!({
            "scope": "local", "provider": "codex", "scopeRef": root, "serverName": name
        }))
    }

    fn project(name: &str, root: &str) -> McpServerBindingRef {
        binding(json!({
            "scope": "project", "provider": "codex", "scopeRef": root, "serverName": name
        }))
    }

    fn switched(binding: McpServerBindingRef, is_enabled: bool) -> SessionToolServer {
        SessionToolServer {
            binding,
            is_enabled,
        }
    }

    // What a read loads: each of `names`, an address server.
    fn loaded(names: &[&str]) -> CodexLoadedServers {
        let servers: Map<String, Value> = names
            .iter()
            .map(|name| {
                (
                    (*name).to_owned(),
                    json!({ "url": "https://example.com/mcp" }),
                )
            })
            .collect();
        CodexLoadedServers::of_config(json!({ "mcp_servers": servers }))
    }

    fn docs_entry() -> McpServerEntry {
        McpServerEntry::from_json(json!({ "command": "docs-server", "args": ["--stdio"] }))
    }

    // The table composed for one call from a linked worktree of `REPOSITORY`, with the daemon's
    // route registered.
    fn compose(
        tool_servers: &[SessionToolServer],
        loaded: &CodexLoadedServers,
        is_copy_fork: bool,
    ) -> Value {
        let folders = CodexProfileFolders {
            working_directory: PathBuf::from("/work/app-feature"),
            git_common_folder: Some(Path::new(REPOSITORY).join(".git")),
            deny_paths: Vec::new(),
            command_channel_folder: PathBuf::from("/work/channel"),
        };
        let repository_root = codex_repository_root(&folders);
        let unloaded: Vec<(McpServerBindingRef, McpServerEntry)> =
            codex_unloaded_bindings(tool_servers, loaded, repository_root)
                .map(|binding| (binding.clone(), docs_entry()))
                .collect();
        let route = opened_route();
        Value::Object(compose_codex_session_table(CodexSessionTableInput {
            tool_servers,
            loaded,
            unloaded_entries: &unloaded,
            route: Some(&route),
            repository_root,
            is_copy_fork,
            sandbox_wrap: None,
        }))
    }

    fn daemon_entry() -> Value {
        json!({
            "url": "http://127.0.0.1:1/tools/sidekicks",
            "http_headers": { "Authorization": "Bearer spawn-secret" },
            "enabled": true,
            "default_tools_approval_mode": "approve",
            "tool_timeout_sec": 300,
            "tool_input_schema_max_bytes": 5_000,
            "omit_tools_from": ["deferred"],
        })
    }

    fn hooks_entry() -> Value {
        json!({
            "url": "http://127.0.0.1:1/tools/sidekicks_hooks",
            "http_headers": { "Authorization": "Bearer spawn-secret" },
            "enabled": true,
            "required": true,
            "default_tools_approval_mode": "approve",
            "tool_timeout_sec": 1_000_000_000_000_u64,
            "tool_input_schema_max_bytes": 5_000,
            "omit_tools_from": ["direct", "deferred", "code_mode"],
        })
    }

    // Each row of the table the call sends, against the call's own read. Killed by dropping a
    // loaded server the session leaves out (it stays on in the person's config), by sending a
    // loaded server as a `url` on the daemon's route, by leaving out the entry of a switched-on
    // server the read does not load, by a copy fork whose table is empty or reaches a server, by
    // comparing a `local` binding's root with the worktree in place of its repository, by
    // switching a `local` or `project` binding on outside its root, by a daemon entry that
    // leaves out the spawn's `Authorization` header, which the route then refuses, or Codex's
    // `approve`, 300 s or the up-front loading, and by an empty deferred entry while the daemon
    // lists no deferred group, and by a hooks entry Codex could start without, show the model or
    // time out before a held hook.
    #[rstest]
    #[case::left_out_and_switched_off(
        vec![switched(user("github"), false)],
        &["github", "notes"],
        false,
        json!({
            "github": { "enabled": false },
            "notes": { "enabled": false },
            "sidekicks": daemon_entry(),
            "sidekicks_hooks": hooks_entry(),
        })
    )]
    #[case::loaded_and_switched_on(
        vec![switched(user("github"), true)],
        &["github"],
        false,
        json!({
            "github": { "enabled": true },
            "sidekicks": daemon_entry(),
            "sidekicks_hooks": hooks_entry(),
        })
    )]
    #[case::switched_on_and_unloaded(
        vec![switched(user("docs"), true)],
        &["github"],
        false,
        json!({
            "github": { "enabled": false },
            "docs": { "command": "docs-server", "args": ["--stdio"], "enabled": true },
            "sidekicks": daemon_entry(),
            "sidekicks_hooks": hooks_entry(),
        })
    )]
    #[case::copy_fork(
        vec![switched(user("github"), true), switched(user("docs"), true)],
        &["github", "notes"],
        true,
        json!({ "github": { "enabled": false }, "notes": { "enabled": false } })
    )]
    #[case::emulated_local_from_a_linked_worktree(
        vec![switched(local("notes", REPOSITORY), true)],
        &["notes"],
        false,
        json!({
            "notes": { "enabled": true },
            "sidekicks": daemon_entry(),
            "sidekicks_hooks": hooks_entry(),
        })
    )]
    #[case::emulated_local_elsewhere(
        vec![switched(local("notes", "/work/other"), true)],
        &["notes"],
        false,
        json!({
            "notes": { "enabled": false },
            "sidekicks": daemon_entry(),
            "sidekicks_hooks": hooks_entry(),
        })
    )]
    #[case::project_elsewhere(
        vec![
            switched(project("notes", "/work/other"), true),
            switched(project("docs", "/work/other"), true),
        ],
        &["notes"],
        false,
        json!({
            "notes": { "enabled": false },
            "sidekicks": daemon_entry(),
            "sidekicks_hooks": hooks_entry(),
        })
    )]
    fn the_table_switches_each_server_against_the_calls_own_read(
        #[case] tool_servers: Vec<SessionToolServer>,
        #[case] loaded_names: &[&str],
        #[case] is_copy_fork: bool,
        #[case] table: Value,
    ) {
        assert_eq!(
            compose(&tool_servers, &loaded(loaded_names), is_copy_fork),
            table
        );
    }

    // At `Sandboxed` each stdio server the session switches on runs in the sandbox, loaded or
    // not, and a server at an address is switched as before. Killed by the table's row not calling
    // the wrap, by a loaded server sent as `{"enabled": true}` alone, which Codex starts as the
    // person declared it, and by wrapping an address server.
    #[test]
    fn the_table_runs_each_stdio_server_it_switches_on_in_the_sandbox() {
        let folders = CodexProfileFolders {
            working_directory: PathBuf::from("/work/app-feature"),
            git_common_folder: Some(Path::new(REPOSITORY).join(".git")),
            deny_paths: Vec::new(),
            command_channel_folder: PathBuf::from("/work/channel"),
        };
        let settings = CodexThreadSettings {
            working_directory: folders.working_directory.clone(),
            model: "gpt-5".to_owned(),
            model_context_window: None,
            level: PermissionLevel::Sandboxed,
            profile_folders: folders,
            command_environment: Vec::new(),
            subagent_policy: None,
            helper_roles: Vec::new(),
            tool_servers: vec![
                switched(user("github"), true),
                switched(user("notes"), true),
                switched(user("docs"), true),
            ],
            base_instructions: None,
            auto_memory: None,
        };
        let wrap = compose_codex_sandbox_wrap(
            &settings,
            Some(CodexNativeCommand {
                program: PathBuf::from("/opt/codex/bin/codex"),
                leading_arguments: Vec::new(),
            }),
            PathBuf::from("/data/codex-homes/account-1"),
        )
        .expect("the service knows its native program")
        .expect("a session at Sandboxed wraps its servers");
        let github: Map<String, Value> = serde_json::from_value(json!({
            "command": "github-server",
            "env": { "GITHUB_TOKEN": "SECRET-VALUE" },
        }))
        .expect("the test's entry is an object");
        let loaded = CodexLoadedServers::of_config(json!({ "mcp_servers": {
            "github": github,
            "notes": { "url": "https://example.com/mcp" },
        }}));
        let repository_root = codex_repository_root(&settings.profile_folders);
        let unloaded = [(user("docs"), docs_entry())];

        let table = compose_codex_session_table(CodexSessionTableInput {
            tool_servers: &settings.tool_servers,
            loaded: &loaded,
            unloaded_entries: &unloaded,
            route: None,
            repository_root,
            is_copy_fork: false,
            sandbox_wrap: Some(&wrap),
        });

        let wrapped_github = wrap_codex_stdio_server(&wrap, &github);
        assert_eq!(
            table["github"],
            json!({
                "command": wrapped_github["command"],
                "args": wrapped_github["args"],
                "env": wrapped_github["env"],
                "enabled": true,
            })
        );
        assert_eq!(table["notes"], json!({ "enabled": true }));
        let mut wrapped_docs = wrap_codex_stdio_server(&wrap, docs_entry().members());
        wrapped_docs.insert("enabled".to_owned(), Value::Bool(true));
        assert_eq!(table["docs"], Value::Object(wrapped_docs));
        assert_eq!(table["github"]["command"], json!("/opt/codex/bin/codex"));
    }
}
