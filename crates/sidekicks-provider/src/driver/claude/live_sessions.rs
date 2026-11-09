//! Claude Code's live-session registry: the `sessions/<pid>.json` file each running Claude Code
//! session keeps in its config folder, naming the session and how to reach it. The registry is
//! Claude Code's, written while the daemon reads it and shaped by its version, so it is read at
//! each call, never cached or watched, every field is optional, and a file that cannot be read
//! still says a session is running there.
#![cfg_attr(not(test), expect(dead_code, reason = "the send states read a status"))]

use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sidekicks_platforms::PathRules;
use sidekicks_std::file::real_location::resolve_real_location;

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::registry::ProviderAccountRegistry;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::inbox::address::is_inbox_socket_name;
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::driver::contract::params_and_results::StandaloneTerminalSession;
use crate::inbound_json::decode_inbound_json;
use crate::lenient_json::read_lenient;

/// The registry's folder inside a Claude Code config folder.
const REGISTRY_FOLDER: &str = "sessions";

/// The extension of a session's registry file, `<pid>.json`.
const REGISTRY_FILE_EXTENSION: &str = "json";

/// One running Claude Code session as its registry file names it; each field is `None` where the
/// file left it out, gave it another type, or could not be read at all.
#[derive(Debug)]
pub(crate) struct ClaudeLiveSession {
    /// The session's id, `sessionId`.
    pub(crate) session_id: Option<String>,
    /// The name other sessions address it by.
    pub(crate) name: Option<String>,
    /// Whether the session is working or idle, in Claude Code's words.
    pub(crate) status: Option<String>,
    /// The session's inbox socket, `messagingSocketPath`.
    pub(crate) socket: Option<PathBuf>,
    /// The folder the session runs in, `cwd`.
    pub(crate) working_folder: Option<PathBuf>,
    /// The registry file the entry was read from.
    pub(crate) registry_file: PathBuf,
    /// The session's process id, from the file's name.
    pub(crate) process_id: u32,
}

/// The fields of a registry file the daemon reads; every other field is skipped unread.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    #[serde(default, deserialize_with = "read_lenient")]
    session_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    status: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    messaging_socket_path: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    cwd: Option<String>,
}

/// The config folders whose registries name the Claude Code sessions on this machine: the
/// person's own, from `base_environment`, then each Claude account's home, a folder already listed
/// skipped. Fails when the accounts cannot be read.
pub(crate) async fn read_claude_registry_folders(
    base_environment: &[(String, String)],
    accounts: &ProviderAccountRegistry,
) -> Result<Vec<PathBuf>, ProviderAccountRegistryError> {
    let mut folders: Vec<PathBuf> = claude_config_folder(base_environment, PathRules::NATIVE)
        .into_iter()
        .collect();
    for account in accounts.list(Some(DESCRIPTOR.provider_id())).await? {
        let folder = account.credential_home.path().to_path_buf();
        if !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    Ok(folders)
}

/// Every session the registries under `config_folders` name, each folder in the order given and
/// its files by process id. A folder with no registry answers nothing, and a file that is not
/// JSON, or went between the listing and the read, answers only its file and process id; nothing
/// here fails.
pub(crate) async fn read_live_sessions(config_folders: &[PathBuf]) -> Vec<ClaudeLiveSession> {
    let mut sessions = Vec::new();
    for config_folder in config_folders {
        let registry = config_folder.join(REGISTRY_FOLDER);
        let mut files = match list_registry_files(&registry).await {
            Ok(files) => files,
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    tracing::debug!(
                        registry = %registry.display(),
                        error = &error as &(dyn Error + 'static),
                        "the live-session registry could not be listed",
                    );
                }
                continue;
            }
        };
        files.sort_unstable_by_key(|(process_id, _)| *process_id);
        for (process_id, registry_file) in files {
            sessions.push(read_registry_file(process_id, registry_file).await);
        }
    }
    sessions
}

/// The sessions the registries under `config_folders` name that a person runs on their own, in
/// [`read_live_sessions`]' order. A session the daemon hosts listens on a socket the daemon named,
/// so one whose socket carries such a name is left out, as is one whose file names no id, which
/// nothing could address.
pub(crate) async fn read_standalone_sessions(
    config_folders: &[PathBuf],
) -> Vec<StandaloneTerminalSession> {
    read_live_sessions(config_folders)
        .await
        .into_iter()
        .filter(|session| !is_hosted(session))
        .filter_map(|session| {
            Some(StandaloneTerminalSession {
                id: session.session_id?,
                name: session.name,
                folder: session.working_folder,
            })
        })
        .collect()
}

// Whether `session` listens on a socket the daemon named, which only a process it started does.
fn is_hosted(session: &ClaudeLiveSession) -> bool {
    session
        .socket
        .as_deref()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .is_some_and(is_inbox_socket_name)
}

/// The sessions in `sessions` named `name`, in their order there; a name several sessions share
/// answers each.
pub(crate) fn by_name<'a>(
    sessions: &'a [ClaudeLiveSession],
    name: &str,
) -> impl Iterator<Item = &'a ClaudeLiveSession> {
    sessions
        .iter()
        .filter(move |session| session.name.as_deref() == Some(name))
}

/// The session in `sessions` whose inbox is the socket `address` names, a leading `uds:` dropped.
/// Both sides are compared with every link in their folders resolved, so `/tmp` meets
/// `/private/tmp`; each folder is resolved once per call, and a session whose folder cannot be
/// resolved is passed over, logged. Fails as the address's own folder cannot be resolved.
pub(crate) async fn by_socket<'a>(
    sessions: &'a [ClaudeLiveSession],
    address: &str,
) -> io::Result<Option<&'a ClaudeLiveSession>> {
    let mut resolved_folders = HashMap::new();
    let socket = Path::new(address.strip_prefix("uds:").unwrap_or(address));
    let Some(wanted) = resolve_socket(socket, &mut resolved_folders).await? else {
        return Ok(None);
    };
    for session in sessions {
        let Some(socket) = session.socket.as_deref() else {
            continue;
        };
        match resolve_socket(socket, &mut resolved_folders).await {
            Ok(resolved) if resolved.as_ref() == Some(&wanted) => return Ok(Some(session)),
            Ok(_) => {}
            Err(error) => tracing::debug!(
                registry_file = %session.registry_file.display(),
                error = &error as &(dyn Error + 'static),
                "a running session's socket folder could not be resolved, so it was passed over",
            ),
        }
    }
    Ok(None)
}

/// Whether `address`, a leading `uds:` dropped, names the socket at `socket`: the same text, or the
/// same file once the links in both folders are resolved. A folder that cannot be resolved holds
/// no socket the other names.
pub(crate) async fn names_socket(address: &str, socket: &str) -> bool {
    let address = address.strip_prefix("uds:").unwrap_or(address);
    if address == socket {
        return true;
    }
    let mut resolved_folders = HashMap::new();
    let wanted = resolve_socket(Path::new(address), &mut resolved_folders).await;
    let held = resolve_socket(Path::new(socket), &mut resolved_folders).await;
    matches!((wanted, held), (Ok(Some(wanted)), Ok(Some(held))) if wanted == held)
}

// `socket` with its folder's links resolved, each folder once through `resolved_folders`; `None`
// for a path with no folder or no file name.
async fn resolve_socket(
    socket: &Path,
    resolved_folders: &mut HashMap<PathBuf, PathBuf>,
) -> io::Result<Option<PathBuf>> {
    let (Some(folder), Some(name)) = (socket.parent(), socket.file_name()) else {
        return Ok(None);
    };
    let resolved = if let Some(resolved) = resolved_folders.get(folder) {
        resolved.clone()
    } else {
        let resolved = resolve_real_location(folder).await?;
        resolved_folders.insert(folder.to_path_buf(), resolved.clone());
        resolved
    };
    Ok(Some(resolved.join(name)))
}

// Each `<pid>.json` file in `registry` with its process id; the key files beside them are never
// opened.
async fn list_registry_files(registry: &Path) -> io::Result<Vec<(u32, PathBuf)>> {
    let mut entries = tokio::fs::read_dir(registry).await?;
    let mut files = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str())
            != Some(REGISTRY_FILE_EXTENSION)
        {
            continue;
        }
        let process_id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| stem.parse::<u32>().ok());
        if let Some(process_id) = process_id {
            files.push((process_id, path));
        }
    }
    Ok(files)
}

// One registry file's session: the fields it names, or none where it cannot be read as JSON.
async fn read_registry_file(process_id: u32, registry_file: PathBuf) -> ClaudeLiveSession {
    let fields = tokio::fs::read(&registry_file)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_str::<RegistryFile>(&decode_inbound_json(&bytes)).ok());
    let Some(fields) = fields else {
        return ClaudeLiveSession {
            session_id: None,
            name: None,
            status: None,
            socket: None,
            working_folder: None,
            registry_file,
            process_id,
        };
    };
    ClaudeLiveSession {
        session_id: fields.session_id,
        name: fields.name,
        status: fields.status,
        socket: fields.messaging_socket_path.map(PathBuf::from),
        working_folder: fields.cwd.map(PathBuf::from),
        registry_file,
        process_id,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;
    use sidekicks_platforms::{make_folder_link, real_path};

    use super::{by_name, by_socket, read_live_sessions, read_standalone_sessions};
    use crate::driver::contract::params_and_results::StandaloneTerminalSession;

    // Writes `contents` as the registry file of `process_id` under `config_folder`.
    fn write_registry_file(config_folder: &Path, process_id: u32, contents: &str) {
        let registry = config_folder.join("sessions");
        std::fs::create_dir_all(&registry).expect("the registry folder is made");
        std::fs::write(registry.join(format!("{process_id}.json")), contents)
            .expect("the registry file is written");
    }

    // Killed by a broken file failing the read or being skipped (three entries become fewer), by a
    // missing field read as an error (the name-only file loses its name), by the second folder
    // skipped (its session is absent), and by a missing folder failing the read.
    #[tokio::test]
    async fn the_registry_reads_every_file_under_every_folder_and_degrades_a_broken_one() {
        let scratch = tempfile::tempdir().expect("a scratch folder is made");
        let first = scratch.path().join("person");
        let second = scratch.path().join("account");
        write_registry_file(
            &first,
            4101,
            r#"{"pid":4101,"sessionId":"s-full","cwd":"/work/app","name":"builder",
                "status":"busy","messagingSocketPath":"/tmp/cc-socks/4101.sock",
                "peerFeatures":["reply_across_default_dirs"],"peerProtocol":1}"#,
        );
        write_registry_file(&first, 4102, "{\"name\":");
        write_registry_file(&second, 4103, r#"{"name":"builder"}"#);
        std::fs::write(first.join("sessions").join("4101.0a1b.key"), "never opened")
            .expect("the key file is written");

        let sessions =
            read_live_sessions(&[first.clone(), scratch.path().join("absent"), second.clone()])
                .await;

        let read: Vec<_> = sessions
            .iter()
            .map(|session| {
                (
                    session.process_id,
                    session.registry_file.clone(),
                    session.session_id.as_deref(),
                    session.name.as_deref(),
                    session.status.as_deref(),
                    session.socket.as_deref(),
                    session.working_folder.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            read,
            vec![
                (
                    4101,
                    first.join("sessions").join("4101.json"),
                    Some("s-full"),
                    Some("builder"),
                    Some("busy"),
                    Some(Path::new("/tmp/cc-socks/4101.sock")),
                    Some(Path::new("/work/app")),
                ),
                (
                    4102,
                    first.join("sessions").join("4102.json"),
                    None,
                    None,
                    None,
                    None,
                    None,
                ),
                (
                    4103,
                    second.join("sessions").join("4103.json"),
                    None,
                    Some("builder"),
                    None,
                    None,
                    None,
                ),
            ]
        );
        let named: Vec<u32> = by_name(&sessions, "builder")
            .map(|session| session.process_id)
            .collect();
        assert_eq!(named, vec![4101, 4103]);
        assert_eq!(
            by_socket(&sessions, "/tmp/cc-socks/4101.sock")
                .await
                .expect("the sockets' folders resolve")
                .map(|session| session.process_id),
            Some(4101)
        );
    }

    // Killed by the daemon's own sessions kept (the session on a daemon-named socket is answered
    // too) and by a file with no id kept.
    #[tokio::test]
    async fn a_standalone_read_leaves_out_the_daemon_s_sessions_and_any_without_an_id() {
        let scratch = tempfile::tempdir().expect("a scratch folder is made");
        let config_folder = scratch.path().join("person");
        write_registry_file(
            &config_folder,
            4301,
            r#"{"sessionId":"s-hosted","name":"planner","cwd":"/work/app",
                "messagingSocketPath":"/tmp/cc-socks/a0123456789abcde.sock"}"#,
        );
        write_registry_file(
            &config_folder,
            4302,
            r#"{"sessionId":"s-typed","name":"tax-fix","cwd":"/work/tax",
                "messagingSocketPath":"/tmp/cc-socks/4302.sock"}"#,
        );
        write_registry_file(&config_folder, 4303, r#"{"name":"no-id"}"#);

        let sessions = read_standalone_sessions(&[config_folder]).await;

        assert_eq!(
            sessions,
            vec![StandaloneTerminalSession {
                id: "s-typed".to_owned(),
                name: Some("tax-fix".to_owned()),
                folder: Some(Path::new("/work/tax").to_path_buf()),
            }]
        );
    }

    // Killed by an exact compare of the paths (the registry's spelling runs through a link), by a
    // leading `uds:` kept, and by a session whose folder cannot be resolved failing the lookup; the
    // other file name finding a session kills a folder-only compare.
    #[tokio::test]
    async fn a_socket_is_found_through_a_linked_folder_and_a_uds_address() {
        let scratch = tempfile::tempdir().expect("a scratch folder is made");
        let real_folder = scratch.path().join("real");
        std::fs::create_dir(&real_folder).expect("the socket folder is made");
        let linked_folder = scratch.path().join("linked");
        make_folder_link(&real_folder, &linked_folder).expect("the link is made");
        let config_folder = scratch.path().join("config");
        let linked_socket = linked_folder.join("4201.sock");
        write_registry_file(
            &config_folder,
            4201,
            &json!({"messagingSocketPath": linked_socket}).to_string(),
        );
        // A session whose socket folder is a link that loops, which no resolve gets through.
        let looping_folder = scratch.path().join("looping");
        make_folder_link(&looping_folder, &looping_folder).expect("the looping link is made");
        write_registry_file(
            &config_folder,
            4200,
            &json!({"messagingSocketPath": looping_folder.join("inner").join("4200.sock")})
                .to_string(),
        );
        let sessions = read_live_sessions(&[config_folder]).await;
        let real_folder = real_path(&real_folder).expect("the folder resolves");

        let found = by_socket(
            &sessions,
            &format!("uds:{}", real_folder.join("4201.sock").display()),
        )
        .await
        .expect("the sockets' folders resolve");
        let other = by_socket(
            &sessions,
            &format!("uds:{}", real_folder.join("4202.sock").display()),
        )
        .await
        .expect("the sockets' folders resolve");

        assert_eq!(found.map(|session| session.process_id), Some(4201));
        assert!(other.is_none());
    }
}
