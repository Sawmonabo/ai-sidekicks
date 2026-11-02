//! Claude Code's live-session registry: the `sessions/<pid>.json` file each running Claude Code
//! session keeps in its config folder, naming the session and how to reach it. The registry is
//! Claude Code's, written while the daemon reads it and shaped by its version, so it is read at
//! each call, never cached or watched, every field is optional, and a file that cannot be read
//! still says a session is running there.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the send hook, the target resolver and the send states read the running sessions"
    )
)]

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::inbound_json::decode_inbound_json;

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
    #[serde(default, deserialize_with = "text_or_nothing")]
    session_id: Option<String>,
    #[serde(default, deserialize_with = "text_or_nothing")]
    name: Option<String>,
    #[serde(default, deserialize_with = "text_or_nothing")]
    status: Option<String>,
    #[serde(default, deserialize_with = "text_or_nothing")]
    messaging_socket_path: Option<String>,
    #[serde(default, deserialize_with = "text_or_nothing")]
    cwd: Option<String>,
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

/// The session in `sessions` whose inbox is `socket`, compared as the registry writes the path.
pub(crate) fn by_socket<'a>(
    sessions: &'a [ClaudeLiveSession],
    socket: &Path,
) -> Option<&'a ClaudeLiveSession> {
    sessions
        .iter()
        .find(|session| session.socket.as_deref() == Some(socket))
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

// A field's text, or `None` where a version of Claude Code wrote it as anything but a string.
fn text_or_nothing<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(if let Value::String(text) = value {
        Some(text)
    } else {
        None
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{by_name, by_socket, read_live_sessions};

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
            by_socket(&sessions, Path::new("/tmp/cc-socks/4101.sock"))
                .map(|session| session.process_id),
            Some(4101)
        );
    }
}
