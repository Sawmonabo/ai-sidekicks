//! The write of one MCP server to the person's own Claude Code config at the binding's scope: an
//! add or an update through the guarded edit of the entry, so no value sits on a command line, and
//! a removal through `claude mcp remove`, which also clears the server's saved sign-in. Every
//! command runs in the person's own environment, so it reads and writes the person's own files, in
//! the project's root for a `project` or `local` binding. An add or an update is then read back
//! with `claude mcp get`, Claude Code's own check, once the lock is released.

use std::error::Error;
use std::path::{Path, PathBuf};

use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName, McpWritableBindingRef};
use sidekicks_store::data_folder::plugin_home;
use tokio::time::Instant;

use super::compose::NO_SWITCH_WORDS;
use super::edit::{ClaudeEditTarget, edit_claude_mcp_entry, refused_by_daemon};
use super::observe::observe_claude_mcp_server;
use super::{ClaudePersonConfigFiles, SERVERS_FILE, claude_project_key};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::session::establishment::spawn_sources::ClaudeSpawnSources;
use crate::driver::claude::session::settings_file::ClaudeSettingsReadError;
use crate::driver::claude::spawn::launch::installed_build::resolve_claude_build;
use crate::driver::claude::spawn::one_shot_command::{
    CLAUDE_MCP_WRITE_TIMEOUT, ClaudeOneShotError, run_claude_one_shot,
};
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::write::{
    McpServerEntry, McpServerObserved, McpServerWrite, McpServerWriteOutcome,
    McpServerWriteRefusal, provider_words_without_values,
};
use crate::spawned_version::ResolvedProviderExecutable;

/// Claude Code's command group for its MCP servers.
const MCP_COMMAND: &str = "mcp";

/// The command that removes a server.
const REMOVE_COMMAND: &str = "remove";

/// The command that reads a server back.
const GET_COMMAND: &str = "get";

/// The flag naming the scope a command writes.
const SCOPE_FLAG: &str = "--scope";

/// What the daemon's words for a write that no command could make begin with.
const UNWRITTEN_CONTEXT: &str = "Claude Code's MCP config was not written";

impl ClaudeDriver {
    /// The person's own Claude Code config files and the daemon's plugin home for Claude Code,
    /// where every binding's entry is read.
    pub(crate) async fn resolve_mcp_entry_places(&self) -> (ClaudePersonConfigFiles, PathBuf) {
        let sources = &self.sources;
        let person =
            ClaudePersonConfigFiles::resolve(&sources.base_environment, &sources.home_folder).await;
        let plugin_home = plugin_home(&sources.home_folder, &DESCRIPTOR.provider_id());
        (person, plugin_home)
    }

    /// What Claude Code's config holds for `binding`, read from the person's own files and the
    /// plugins in the daemon's plugin home. Fails as the config read fails.
    pub(crate) async fn observe_mcp_server(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<McpServerObserved, DriverError> {
        let (person, plugin_home) = self.resolve_mcp_entry_places().await;
        observe_claude_mcp_server(&person, &plugin_home, binding)
            .await
            .map_err(|error| DriverError::Internal(Box::new(error)))
    }

    /// Writes `write` to the person's own Claude Code config against `before`, every step under
    /// one deadline [`CLAUDE_MCP_WRITE_TIMEOUT`] away. A switch is refused, since Claude Code's is
    /// the daemon's own; a build that does not resolve or a command that cannot start refuses the
    /// write in the daemon's words, and a command that exits with a failure in its own. A command
    /// ended by a signal, past the deadline or not waited for, and a read-back that does not
    /// answer cleanly, leave the write `Unknown`.
    pub(crate) async fn write_mcp_server(
        &self,
        write: &McpServerWrite,
        before: &McpServerObserved,
    ) -> McpServerWriteOutcome {
        let deadline = Instant::now() + CLAUDE_MCP_WRITE_TIMEOUT;
        let (binding, change) = match write {
            McpServerWrite::Upsert { binding, entry } => (binding, ClaudeMcpChange::Edit(entry)),
            McpServerWrite::Remove { binding } => (binding, ClaudeMcpChange::Remove),
            McpServerWrite::SetEnabled { .. } => {
                return McpServerWriteOutcome::Refused(McpServerWriteRefusal::Provider {
                    words: provider_words_without_values(NO_SWITCH_WORDS),
                });
            }
        };
        let sources = &self.sources;
        let executable = match resolve_claude_build(
            &sources.command_search,
            &sources.home_folder,
            sources.base_environment.to_vec(),
        )
        .await
        {
            Ok(executable) => executable,
            Err(error) => return refused_by_daemon(UNWRITTEN_CONTEXT, &error),
        };
        let place = ClaudeMcpWritePlace::of(binding, &sources.home_folder);
        let command = ClaudeMcpCommand {
            sources,
            executable: &executable,
            working_folder: &place.working_folder,
            deadline,
        };
        let server_name = place.server_name.as_str();
        match change {
            ClaudeMcpChange::Edit(entry) => {
                let (person, _plugin_home) = self.resolve_mcp_entry_places().await;
                let target = match edit_target(binding, &person).await {
                    Ok(target) => target,
                    Err(error) => return refused_by_daemon(UNWRITTEN_CONTEXT, &error),
                };
                match edit_claude_mcp_entry(
                    target,
                    place.server_name,
                    entry,
                    &before.entry,
                    deadline,
                )
                .await
                {
                    McpServerWriteOutcome::Applied { .. } => {}
                    outcome @ (McpServerWriteOutcome::Refused(_)
                    | McpServerWriteOutcome::Unknown) => return outcome,
                }
            }
            ClaudeMcpChange::Remove => {
                return match command
                    .run(&[REMOVE_COMMAND, server_name, SCOPE_FLAG, place.scope])
                    .await
                {
                    Ok(()) => McpServerWriteOutcome::Applied {
                        reload_failure: None,
                    },
                    Err(outcome) => outcome,
                };
            }
        }
        // Claude Code's own read-back, after the lock is released; a read-back that does not
        // answer cleanly leaves the write for the service to observe.
        match command.run(&[GET_COMMAND, server_name]).await {
            Ok(()) => McpServerWriteOutcome::Applied {
                reload_failure: None,
            },
            Err(_unread) => McpServerWriteOutcome::Unknown,
        }
    }
}

/// What one write does to Claude Code's config.
enum ClaudeMcpChange<'write> {
    /// Writes the entry, added where the config holds none or in place of the one observed.
    Edit(&'write McpServerEntry),
    /// Removes the server.
    Remove,
}

/// Where a write of one binding runs its commands.
struct ClaudeMcpWritePlace<'binding> {
    /// The server's name.
    server_name: &'binding McpServerName,
    /// The scope Claude Code's commands name.
    scope: &'static str,
    /// The project's root for a `project` or `local` binding, the person's home folder for a
    /// `user` one.
    working_folder: PathBuf,
}

impl<'binding> ClaudeMcpWritePlace<'binding> {
    /// The place of `binding`, whose commands run in `home` where it names no project.
    fn of(binding: &'binding McpWritableBindingRef, home: &Path) -> Self {
        match binding {
            McpWritableBindingRef::User { server_name, .. } => Self {
                server_name,
                scope: "user",
                working_folder: home.to_path_buf(),
            },
            McpWritableBindingRef::Project {
                scope_ref,
                server_name,
                ..
            } => Self {
                server_name,
                scope: "project",
                working_folder: PathBuf::from(scope_ref.as_str()),
            },
            McpWritableBindingRef::Local {
                scope_ref,
                server_name,
                ..
            } => Self {
                server_name,
                scope: "local",
                working_folder: PathBuf::from(scope_ref.as_str()),
            },
        }
    }
}

// The file an add or an update of `binding` edits: the person's config, at the project's key for a
// `local` binding, as Claude Code keys it, or the project's `.mcp.json` for a `project` one. Fails
// as the key's resolve does.
async fn edit_target(
    binding: &McpWritableBindingRef,
    person: &ClaudePersonConfigFiles,
) -> Result<ClaudeEditTarget, ClaudeSettingsReadError> {
    Ok(match binding {
        McpWritableBindingRef::User { .. } => ClaudeEditTarget::PersonConfig {
            path: person.person_config.clone(),
            project_key: None,
        },
        McpWritableBindingRef::Local { scope_ref, .. } => ClaudeEditTarget::PersonConfig {
            path: person.person_config.clone(),
            project_key: Some(claude_project_key(scope_ref.as_str()).await?),
        },
        McpWritableBindingRef::Project { scope_ref, .. } => ClaudeEditTarget::ProjectServersFile {
            path: Path::new(scope_ref.as_str()).join(SERVERS_FILE),
        },
    })
}

/// One `claude mcp` command of a write: the build it runs, the folder it runs in and the deadline
/// the whole write runs under.
struct ClaudeMcpCommand<'write> {
    /// The daemon's services the command starts from.
    sources: &'write ClaudeSpawnSources,
    /// The person's Claude Code build, in the person's environment.
    executable: &'write ResolvedProviderExecutable,
    /// The folder the command runs in.
    working_folder: &'write Path,
    /// When the write gives up on the command.
    deadline: Instant,
}

impl ClaudeMcpCommand<'_> {
    /// Runs `claude mcp` with `arguments` and answers once it exited with code 0. Ends with the
    /// outcome the write takes otherwise: refused in the daemon's words where it cannot start, in
    /// its own error output's where it exits with a failure, and `Unknown` where a signal ends it,
    /// its wait fails or the deadline passes, which kills it.
    async fn run(&self, arguments: &[&str]) -> Result<(), McpServerWriteOutcome> {
        let arguments: Vec<&str> = [MCP_COMMAND].iter().chain(arguments).copied().collect();
        let ran = tokio::time::timeout_at(
            self.deadline,
            run_claude_one_shot(
                &self.sources.spawner,
                self.executable,
                &arguments,
                self.working_folder,
                true,
            ),
        )
        .await;
        let ended = match ran {
            Ok(Ok(ended)) => ended,
            Ok(Err(error @ ClaudeOneShotError::Start(_))) => {
                return Err(refused_by_daemon(UNWRITTEN_CONTEXT, &error));
            }
            Ok(Err(error @ ClaudeOneShotError::Wait(_))) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a Claude Code MCP command's end is not known"
                );
                return Err(McpServerWriteOutcome::Unknown);
            }
            Err(_elapsed) => return Err(McpServerWriteOutcome::Unknown),
        };
        if ended.exit.signal_name.is_some() {
            return Err(McpServerWriteOutcome::Unknown);
        }
        if ended.is_success() {
            return Ok(());
        }
        let error_output = ended.error_output.unwrap_or_default();
        Err(McpServerWriteOutcome::Refused(
            McpServerWriteRefusal::Provider {
                words: provider_words_without_values(&format!(
                    "Claude Code exited with code {}: {error_output}",
                    ended.exit.exit_code
                )),
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::McpWritableBindingRef;
    use sidekicks_platforms::make_folder_link;
    use sidekicks_std::file::atomic_write::write_file_atomically;
    use tempfile::TempDir;

    use crate::driver::claude::lifecycle::ClaudeDriver;
    use crate::driver::claude::spawn::settings::compose_claude_export_off_settings;
    use crate::driver::mcp_server::write::{
        McpServerEntry, McpServerObserved, McpServerObservedEntry, McpServerWrite,
        McpServerWriteOutcome, McpServerWriteRefusal,
    };
    use crate::driver::test_registry::test_driver_services;

    // A driver whose `claude` is a stand-in under a scratch folder: it appends its physical
    // working folder, its `CLAUDE_CONFIG_DIR` and its arguments to the folder's `commands`
    // record, and exits 1 with a quoted value on its error output once a `refuse` file is there.
    struct StandIn {
        root: TempDir,
        driver: ClaudeDriver,
    }

    impl StandIn {
        async fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let programs = root.path().join("programs");
            for folder in ["programs", "home", "config", "project"] {
                tokio::fs::create_dir_all(root.path().join(folder))
                    .await
                    .unwrap();
            }
            make_folder_link(
                &root.path().join("project"),
                &root.path().join("project-link"),
            )
            .unwrap();
            write_file_atomically(
                &programs.join("claude"),
                format!(
                    "#!/bin/sh\nprintf '%s|%s|%s\\n' \"$(pwd -P)\" \"$CLAUDE_CONFIG_DIR\" \"$*\" \
                     >> '{commands}'\n[ -e '{refuse}' ] && {{ printf '%s\\n' \
                     'Error: invalid value \"SECRET-STRING\"' >&2; exit 1; }}\nexit 0\n",
                    commands = root.path().join("commands").display(),
                    refuse = root.path().join("refuse").display(),
                ),
                0o755,
            )
            .await
            .unwrap();
            let mut services = test_driver_services();
            services.data_folder = root.path().join("data");
            services.home_folder = root.path().join("home");
            services.base_environment = Arc::from([
                (
                    "PATH".to_owned(),
                    format!("{}:/usr/bin:/bin", programs.display()),
                ),
                (
                    "CLAUDE_CONFIG_DIR".to_owned(),
                    root.path().join("config").display().to_string(),
                ),
            ]);
            let driver = ClaudeDriver::new(&services);
            Self { root, driver }
        }

        fn folder(&self, name: &str) -> PathBuf {
            self.root.path().join(name)
        }

        // The `docs` binding at `scope`, a `project` or `local` one in the scratch project, reached
        // through a link to it.
        fn binding(&self, scope: &str) -> McpWritableBindingRef {
            let mut binding = json!({"scope": scope, "provider": "claude", "serverName": "docs"});
            if scope != "user" {
                binding["scopeRef"] = json!(self.folder("project-link").display().to_string());
            }
            serde_json::from_value(binding).unwrap()
        }

        // The key Claude Code files the scratch project under: its folder with every link
        // resolved.
        fn project_key(&self) -> String {
            std::fs::canonicalize(self.folder("project"))
                .unwrap()
                .display()
                .to_string()
        }

        // One line of the record: the command run in `folder` with `arguments`, after the
        // export-off settings.
        fn command_line(&self, folder: &Path, arguments: &str) -> String {
            format!(
                "{}|{}|--settings {} mcp {arguments}\n",
                std::fs::canonicalize(folder).unwrap().display(),
                self.folder("config").display(),
                compose_claude_export_off_settings()
            )
        }

        async fn commands(&self) -> String {
            tokio::fs::read_to_string(self.folder("commands"))
                .await
                .unwrap_or_default()
        }
    }

    fn observed(entry: McpServerObservedEntry) -> McpServerObserved {
        McpServerObserved {
            entry,
            config_version: None,
            config_files: Vec::new(),
        }
    }

    // An add edits the file of its scope, made where it is not there yet, and runs no command but
    // the read-back, in the project's root for a `project` or `local` binding and in the home for
    // a `user` one, under the person's own `CLAUDE_CONFIG_DIR`, so no value it carries reaches a
    // command line. Killed by an add through a command, an entry written at another scope's place
    // or at a `local` binding's root as given rather than resolved through its link, the home as a
    // project write's folder, the environment cleared of the person's variable, and no read-back.
    #[rstest]
    #[case::user("user")]
    #[case::project("project")]
    #[case::local("local")]
    #[tokio::test]
    async fn an_add_edits_its_scopes_file_and_puts_no_value_on_a_command_line(#[case] scope: &str) {
        let stand_in = StandIn::new().await;
        let project = stand_in.project_key();
        let added = json!({
            "command": "npx",
            "args": ["docs"],
            "env": {"DOCS_TOKEN": "SECRET-VALUE"},
        });
        let write = McpServerWrite::Upsert {
            binding: stand_in.binding(scope),
            entry: McpServerEntry::from_json(added.clone()),
        };

        let outcome = stand_in
            .driver
            .write_mcp_server(&write, &observed(McpServerObservedEntry::Absent))
            .await;

        assert_eq!(
            outcome,
            McpServerWriteOutcome::Applied {
                reload_failure: None
            }
        );
        let folder = stand_in.folder(if scope == "user" { "home" } else { "project" });
        let commands = stand_in.commands().await;
        assert_eq!(commands, stand_in.command_line(&folder, "get docs"));
        assert!(!commands.contains("SECRET-VALUE"));
        let (file, expected) = match scope {
            "user" => (
                stand_in.folder("config").join(".claude.json"),
                json!({"mcpServers": {"docs": added}}),
            ),
            "local" => (
                stand_in.folder("config").join(".claude.json"),
                json!({"projects": {project: {"mcpServers": {"docs": added}}}}),
            ),
            _ => (
                stand_in.folder("project").join(".mcp.json"),
                json!({"mcpServers": {"docs": added}}),
            ),
        };
        let after: Value =
            serde_json::from_str(&tokio::fs::read_to_string(&file).await.unwrap()).unwrap();
        assert_eq!(after, expected);
    }

    // A removal runs `mcp remove` at the binding's scope in the project's root, under the
    // person's own `CLAUDE_CONFIG_DIR`, and nothing after it. Killed by a wrong scope, the home as
    // a project write's folder and the environment cleared of the person's variable.
    #[tokio::test]
    async fn a_removal_runs_claude_mcp_remove_at_its_scope() {
        let stand_in = StandIn::new().await;
        let write = McpServerWrite::Remove {
            binding: stand_in.binding("project"),
        };
        let before =
            McpServerObservedEntry::Present(McpServerEntry::from_json(json!({"command": "npx"})));

        let outcome = stand_in
            .driver
            .write_mcp_server(&write, &observed(before))
            .await;

        assert_eq!(
            outcome,
            McpServerWriteOutcome::Applied {
                reload_failure: None
            }
        );
        assert_eq!(
            stand_in.commands().await,
            stand_in.command_line(&stand_in.folder("project"), "remove docs --scope project")
        );
    }

    // An update edits the entry in place, at the user's servers or under the project's key, and
    // runs no command before it: only the read-back runs. Killed by a removal and an add in place
    // of the edit, and by an edit at another place in the file, the root as given among them.
    #[rstest]
    #[case::user("user")]
    #[case::local("local")]
    #[tokio::test]
    async fn an_update_edits_the_entry_and_runs_no_command_before_it(#[case] scope: &str) {
        let stand_in = StandIn::new().await;
        let project = stand_in.project_key();
        let held = json!({"command": "npx"});
        let written = json!({"command": "npx", "args": ["--verbose"]});
        let config_with = |docs: &Value| {
            if scope == "user" {
                json!({"numStartups": 1, "mcpServers": {"docs": docs}})
            } else {
                json!({"numStartups": 1, "projects": {project.clone(): {
                    "allowedTools": [],
                    "mcpServers": {"docs": docs, "other": {"command": "other"}},
                }}})
            }
        };
        let config_file = stand_in.folder("config").join(".claude.json");
        tokio::fs::write(&config_file, config_with(&held).to_string())
            .await
            .unwrap();
        let write = McpServerWrite::Upsert {
            binding: stand_in.binding(scope),
            entry: McpServerEntry::from_json(written.clone()),
        };
        let before = McpServerObservedEntry::Present(McpServerEntry::from_json(held));

        let outcome = stand_in
            .driver
            .write_mcp_server(&write, &observed(before))
            .await;

        assert_eq!(
            outcome,
            McpServerWriteOutcome::Applied {
                reload_failure: None
            }
        );
        let folder = stand_in.folder(if scope == "user" { "home" } else { "project" });
        assert_eq!(
            stand_in.commands().await,
            stand_in.command_line(&folder, "get docs")
        );
        let after: Value =
            serde_json::from_str(&tokio::fs::read_to_string(&config_file).await.unwrap()).unwrap();
        assert_eq!(after, config_with(&written));
    }

    // A command that exits with a failure refuses the write in its own words with no value it
    // quoted. Killed by its raw error output in the words.
    #[tokio::test]
    async fn a_refusal_carries_no_value_the_command_quoted() {
        let stand_in = StandIn::new().await;
        tokio::fs::write(stand_in.folder("refuse"), "")
            .await
            .unwrap();
        let write = McpServerWrite::Remove {
            binding: stand_in.binding("user"),
        };
        let before =
            McpServerObservedEntry::Present(McpServerEntry::from_json(json!({"command": "npx"})));

        let outcome = stand_in
            .driver
            .write_mcp_server(&write, &observed(before))
            .await;

        let McpServerWriteOutcome::Refused(McpServerWriteRefusal::Provider { words }) = outcome
        else {
            panic!("a failed command refuses the write: {outcome:?}");
        };
        assert!(words.contains("invalid value"));
        assert!(!words.contains("SECRET-STRING"));
    }
}
