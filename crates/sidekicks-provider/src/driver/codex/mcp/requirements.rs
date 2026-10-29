//! The allow list of MCP servers an administrator sets for Codex on this computer, in the
//! `[mcp_servers]` table of the system `requirements.toml`: where the table is present, Codex
//! starts a server only when the table names it and its transport matches the entry's identity.
//! Codex's `config/read` never carries it, so the driver reads the file itself.

use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::path::Path;

use regex::Regex;
use serde::Deserialize;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;

use crate::driver::codex::mcp::config::CodexMcpConfigReading;
use crate::driver::mcp_server::read::McpServerPolicyEntry;

#[cfg(test)]
mod tests;

/// The file in Codex's administrator-managed settings folder that holds the requirements.
const REQUIREMENTS_FILE_NAME: &str = "requirements.toml";

/// The servers Codex's requirements allow, by name, each with the identity its transport must
/// have.
pub(crate) struct CodexMcpRequirements {
    servers: BTreeMap<String, ServerIdentity>,
}

impl CodexMcpRequirements {
    /// Whether Codex starts the server `name` declared as `config`: the allow list names it and
    /// its transport matches. A remote server's address is matched as the read keeps it, its
    /// query and any user name or password stripped.
    pub(crate) fn allows(&self, name: &str, config: &McpServerConfigView) -> bool {
        self.servers
            .get(name)
            .is_some_and(|identity| identity.matches(config))
    }

    /// Fills `reading` with the allow list: its policy names each allowed server, and each root
    /// keeps out every server declared there that the list does not allow.
    pub(crate) fn apply(&self, reading: &mut CodexMcpConfigReading) {
        let allowed = self
            .servers
            .keys()
            .filter_map(|name| McpServerName::new(name.clone()).ok())
            .map(McpServerPolicyEntry::ServerName)
            .collect();
        reading.server_policy.allowed = Some(allowed);
        for root in &mut reading.roots {
            let mut kept_out: Vec<McpServerName> = Vec::new();
            for declaration in &reading.declarations {
                let Some(name) = server_name_at(&declaration.binding, Some(&root.root)) else {
                    continue;
                };
                if !kept_out.contains(name) && !self.allows(name.as_str(), &declaration.config) {
                    kept_out.push(name.clone());
                }
            }
            root.kept_out_server_names = kept_out;
        }
    }
}

/// Reads Codex's requirements from `requirements.toml` in `managed_settings_folder`; `None` where
/// no folder is named, the file is absent or the daemon may not read it, or it sets no
/// `[mcp_servers]` table, all of which declare no allow list. A file Codex could not read either
/// is logged and declares none.
pub(crate) async fn read_codex_mcp_requirements(
    managed_settings_folder: Option<&Path>,
) -> Option<CodexMcpRequirements> {
    let path = managed_settings_folder?.join(REQUIREMENTS_FILE_NAME);
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(text) => text,
        Err(failure)
            if matches!(
                failure.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
            ) =>
        {
            return None;
        }
        Err(failure) => {
            tracing::warn!(
                file = %path.display(),
                error = &failure as &(dyn Error + 'static),
                "codex's requirements file could not be read; it declares no mcp allow list"
            );
            return None;
        }
    };
    match parse_codex_mcp_requirements(&text) {
        Ok(requirements) => requirements,
        Err(failure) => {
            tracing::warn!(
                file = %path.display(),
                error = %failure,
                "codex's requirements file is not one codex reads; it declares no mcp allow list"
            );
            None
        }
    }
}

// The `[mcp_servers]` table of the requirements file `text`; `None` where it sets none. Fails as
// the file is not TOML of Codex's shape or an entry's pattern is not one Codex compiles.
fn parse_codex_mcp_requirements(text: &str) -> Result<Option<CodexMcpRequirements>, String> {
    let file: RequirementsFile = toml::from_str(text).map_err(|failure| failure.to_string())?;
    let Some(entries) = file.mcp_servers else {
        return Ok(None);
    };
    let servers = entries
        .into_iter()
        .map(|(name, entry)| Ok((name, ServerIdentity::compile(entry.identity)?)))
        .collect::<Result<_, String>>()?;
    Ok(Some(CodexMcpRequirements { servers }))
}

/// The name `binding` declares a server by where a session at `root`, or at the person's home
/// folder where `root` is `None`, loads it: every binding but a project's or a root's own at
/// another root, and a connector, which Codex's config does not hold.
pub(super) fn server_name_at<'binding>(
    binding: &'binding McpServerBindingRef,
    root: Option<&PlacedPath>,
) -> Option<&'binding McpServerName> {
    match binding {
        McpServerBindingRef::User { server_name, .. }
        | McpServerBindingRef::Managed { server_name, .. }
        | McpServerBindingRef::Plugin { server_name, .. } => Some(server_name),
        McpServerBindingRef::Project {
            scope_ref,
            place,
            server_name,
            ..
        }
        | McpServerBindingRef::Local {
            scope_ref,
            place,
            server_name,
            ..
        } => root
            .is_some_and(|root| *scope_ref == root.path && *place == root.place)
            .then_some(server_name),
        McpServerBindingRef::Connector { .. } => None,
    }
}

// The members of Codex's requirements file the read takes.
#[derive(Deserialize)]
struct RequirementsFile {
    #[serde(default)]
    mcp_servers: Option<BTreeMap<String, RequirementEntry>>,
}

// One allowed server's entry.
#[derive(Deserialize)]
struct RequirementEntry {
    identity: IdentityEntry,
}

// What an allowed server's transport must be: a program, exactly or by its arguments, or an
// address, exactly or by a pattern.
#[derive(Deserialize)]
#[serde(untagged)]
enum IdentityEntry {
    Command { command: CommandEntry },
    Url { url: ValueEntry },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CommandEntry {
    Program(String),
    Matcher {
        executable: String,
        args: Vec<ValueMatcherEntry>,
    },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ValueEntry {
    Exact(String),
    Matcher(ValueMatcherEntry),
}

#[derive(Deserialize)]
#[serde(tag = "match", rename_all = "snake_case", deny_unknown_fields)]
enum ValueMatcherEntry {
    Exact { value: String },
    Prefix { value: String },
    Regex { expression: String },
}

// An allowed server's identity, its patterns compiled.
enum ServerIdentity {
    // A program by its path alone, whatever its arguments.
    Program(String),
    // A program and each of its arguments, which must be as many as the matchers.
    Command {
        executable: String,
        args: Vec<ValueMatcher>,
    },
    // An address.
    Url(ValueMatcher),
}

impl ServerIdentity {
    fn compile(entry: IdentityEntry) -> Result<Self, String> {
        Ok(match entry {
            IdentityEntry::Command {
                command: CommandEntry::Program(program),
            } => Self::Program(program),
            IdentityEntry::Command {
                command: CommandEntry::Matcher { executable, args },
            } => Self::Command {
                executable,
                args: args
                    .into_iter()
                    .map(ValueMatcher::compile)
                    .collect::<Result<_, _>>()?,
            },
            IdentityEntry::Url {
                url: ValueEntry::Exact(url),
            } => Self::Url(ValueMatcher::Exact(url)),
            IdentityEntry::Url {
                url: ValueEntry::Matcher(matcher),
            } => Self::Url(ValueMatcher::compile(matcher)?),
        })
    }

    fn matches(&self, config: &McpServerConfigView) -> bool {
        match (self, config) {
            (Self::Program(program), McpServerConfigView::Stdio { command, .. }) => {
                command == program
            }
            (
                Self::Command { executable, args },
                McpServerConfigView::Stdio {
                    command,
                    args: declared,
                    ..
                },
            ) => {
                let declared = declared.as_deref().unwrap_or_default();
                command == executable
                    && args.len() == declared.len()
                    && args
                        .iter()
                        .zip(declared)
                        .all(|(matcher, argument)| matcher.matches(argument))
            }
            (
                Self::Url(matcher),
                McpServerConfigView::Http { url, .. } | McpServerConfigView::Sse { url, .. },
            ) => matcher.matches(url),
            _ => false,
        }
    }
}

// One value's matcher, a pattern matched against the whole value as Codex matches it.
enum ValueMatcher {
    Exact(String),
    Prefix(String),
    Pattern(Regex),
}

impl ValueMatcher {
    fn compile(entry: ValueMatcherEntry) -> Result<Self, String> {
        Ok(match entry {
            ValueMatcherEntry::Exact { value } => Self::Exact(value),
            ValueMatcherEntry::Prefix { value } => Self::Prefix(value),
            ValueMatcherEntry::Regex { expression } => Self::Pattern(
                Regex::new(&format!(r"\A(?:{expression})\z"))
                    .map_err(|failure| format!("pattern `{expression}`: {failure}"))?,
            ),
        })
    }

    fn matches(&self, value: &str) -> bool {
        match self {
            Self::Exact(exact) => value == exact,
            Self::Prefix(prefix) => value.starts_with(prefix.as_str()),
            Self::Pattern(pattern) => pattern.is_match(value),
        }
    }
}
