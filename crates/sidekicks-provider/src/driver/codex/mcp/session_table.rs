//! The `mcp_servers` table one Codex start, resume or fork carries, composed against the servers
//! that call's own `config/read` loads. Codex merges the table into its own config by name and by
//! member, so a server of the person's the session leaves out is switched off by name, never
//! dropped: each loaded server is switched off unless the session switches it on here, a `local`
//! or `project` binding only in its own repository; a server the session switches on that the
//! read does not load is sent whole, its values read for this call from the person's own Codex
//! folder; and the daemon's own server goes on its route.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Map, Value, json};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::mcp::config::server_entry::ENABLED_MEMBER;
use crate::driver::codex::mcp::server_name::CODEX_MCP_SERVER_NAMES;
use crate::driver::codex::permission_level::CodexProfileFolders;
use crate::driver::codex::thread::settings::MCP_SERVERS_KEY;
use crate::driver::mcp_server::write::McpServerEntry;
use crate::driver::session_control::SessionToolServer;
use crate::port::tool_server_route::ToolServerRoute;
use crate::tool_server_name::{DAEMON_TOOL_SERVER_NAME, McpServerNameRefusal};

/// Seconds Codex waits on one call to the daemon's tool server: Codex's own default, above the
/// route's own bound, so the route answers first.
const CODEX_DAEMON_TOOL_TIMEOUT_SECONDS: u64 = 300;

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
    #[expect(
        dead_code,
        reason = "the sandbox wrap of a loaded stdio server reads its command and arguments"
    )]
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
    /// The session, which names its servers' addresses on the daemon's route.
    pub(crate) session_id: SessionId,
    /// The session's own tool servers, each with the person's switch.
    pub(crate) tool_servers: &'input [SessionToolServer],
    /// What the call's own `config/read` loads.
    pub(crate) loaded: &'input CodexLoadedServers,
    /// The whole entry of each server [`codex_unloaded_bindings`] names, read for this call from
    /// the person's own Codex folder; a binding the folder declares no transport for has none.
    pub(crate) unloaded_entries: &'input [(McpServerBindingRef, McpServerEntry)],
    /// The route to the daemon's tool servers, once its owner registered it.
    pub(crate) route: Option<&'input dyn ToolServerRoute>,
    /// The root of the repository the conversation runs in ([`codex_repository_root`]), which a
    /// `local` or `project` binding must name to be switched on here.
    pub(crate) repository_root: &'input Path,
    /// Whether the call is a side question's copy, which reaches no tool server.
    pub(crate) is_copy_fork: bool,
}

/// The `mcp_servers` table of one call: each loaded server `{"enabled": false}` unless the
/// session switches it on here, then `{"enabled": true}`; each server the session switches on
/// that the read does not load sent whole with `"enabled": true`; and the daemon's own server on
/// its route, none without one. A copy fork's table switches every loaded server off and holds
/// nothing else. A name Codex keeps for its own server is never sent.
pub(crate) fn compose_codex_session_table(table: CodexSessionTableInput<'_>) -> Map<String, Value> {
    let mut servers = Map::new();
    for name in table.loaded.names() {
        if !is_kept_by_codex(name) {
            servers.insert(name.to_owned(), json!({ ENABLED_MEMBER: false }));
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
            servers.insert(name.to_owned(), json!({ ENABLED_MEMBER: true }));
            continue;
        }
        // A binding the person's folder declares no transport for has no entry to send.
        if let Some((_, entry)) = table
            .unloaded_entries
            .iter()
            .find(|(unloaded, _)| unloaded == binding)
        {
            let mut members = entry.members().clone();
            members.insert(ENABLED_MEMBER.to_owned(), Value::Bool(true));
            servers.insert(name.to_owned(), Value::Object(members));
        }
    }
    if let Some(route) = table.route {
        servers.insert(
            DAEMON_TOOL_SERVER_NAME.to_owned(),
            json!({
                "url": route.url_for(&table.session_id, DAEMON_TOOL_SERVER_NAME),
                "enabled": true,
                // The daemon judges each of its own calls itself, so Codex asks nothing first.
                "default_tools_approval_mode": "approve",
                "tool_timeout_sec": CODEX_DAEMON_TOOL_TIMEOUT_SECONDS,
            }),
        );
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

/// The root of the repository a conversation in `folders` runs in: the parent of its common git
/// folder, which a linked worktree shares with its repository, else its working folder outside a
/// repository.
pub(crate) fn codex_repository_root(folders: &CodexProfileFolders) -> &Path {
    folders
        .git_common_folder
        .as_deref()
        .map_or(folders.working_directory.as_path(), |git_common_folder| {
            git_common_folder.parent().unwrap_or(git_common_folder)
        })
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
    use sidekicks_contracts::session::id::SessionId;

    use super::{
        CodexLoadedServers, CodexSessionTableInput, codex_repository_root, codex_unloaded_bindings,
        compose_codex_session_table,
    };
    use crate::driver::codex::permission_level::CodexProfileFolders;
    use crate::driver::mcp_server::write::McpServerEntry;
    use crate::driver::session_control::SessionToolServer;
    use crate::port::tool_server_route::ToolServerRoute;

    /// The repository every test conversation runs in, from a linked worktree of it.
    const REPOSITORY: &str = "/work/app";

    /// A route that names each server's address by the server alone.
    struct TestRoute;

    impl ToolServerRoute for TestRoute {
        fn url_for(&self, _session_id: &SessionId, server_name: &str) -> String {
            format!("http://127.0.0.1:1/{server_name}")
        }
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
        McpServerEntry::from_members(
            serde_json::from_value(json!({ "command": "docs-server", "args": ["--stdio"] }))
                .expect("the test's entry is an object"),
        )
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
        Value::Object(compose_codex_session_table(CodexSessionTableInput {
            session_id: SessionId::new("0192f3a4-5b6c-7d8e-9f01-23456789abcd")
                .expect("the text is a UUID"),
            tool_servers,
            loaded,
            unloaded_entries: &unloaded,
            route: Some(&TestRoute),
            repository_root,
            is_copy_fork,
        }))
    }

    fn daemon_entry() -> Value {
        json!({
            "url": "http://127.0.0.1:1/sidekicks",
            "enabled": true,
            "default_tools_approval_mode": "approve",
            "tool_timeout_sec": 300,
        })
    }

    // Each row of the table the call sends, against the call's own read. Killed by dropping a
    // loaded server the session leaves out (it stays on in the person's config), by sending a
    // loaded server as a `url` on the daemon's route, by leaving out the entry of a switched-on
    // server the read does not load, by a copy fork whose table is empty or reaches a server, by
    // comparing a `local` binding's root with the worktree in place of its repository, and by
    // switching a `local` or `project` binding on outside its root.
    #[rstest]
    #[case::left_out_and_switched_off(
        vec![switched(user("github"), false)],
        &["github", "notes"],
        false,
        json!({
            "github": { "enabled": false },
            "notes": { "enabled": false },
            "sidekicks": daemon_entry(),
        })
    )]
    #[case::loaded_and_switched_on(
        vec![switched(user("github"), true)],
        &["github"],
        false,
        json!({ "github": { "enabled": true }, "sidekicks": daemon_entry() })
    )]
    #[case::switched_on_and_unloaded(
        vec![switched(user("docs"), true)],
        &["github"],
        false,
        json!({
            "github": { "enabled": false },
            "docs": { "command": "docs-server", "args": ["--stdio"], "enabled": true },
            "sidekicks": daemon_entry(),
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
        json!({ "notes": { "enabled": true }, "sidekicks": daemon_entry() })
    )]
    #[case::emulated_local_elsewhere(
        vec![switched(local("notes", "/work/other"), true)],
        &["notes"],
        false,
        json!({ "notes": { "enabled": false }, "sidekicks": daemon_entry() })
    )]
    #[case::project_elsewhere(
        vec![
            switched(project("notes", "/work/other"), true),
            switched(project("docs", "/work/other"), true),
        ],
        &["notes"],
        false,
        json!({ "notes": { "enabled": false }, "sidekicks": daemon_entry() })
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
}
