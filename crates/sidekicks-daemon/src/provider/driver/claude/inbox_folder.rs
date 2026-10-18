//! Claude Code's socket folder in each place, where the daemon keeps each session's inbox, so a
//! message Claude Code's own inbox drops is reported back to the daemon.

use std::collections::HashMap;
use std::path::PathBuf;

use sidekicks_contracts::place::Place;
use sidekicks_platforms::PathRules;

use crate::provider::port::session_inbox_folder::SessionInboxFolders;

/// The folder Claude Code keeps its sockets in, under the runtime folder, else under `/tmp`.
const SOCKET_FOLDER_NAME: &str = "cc-socks";

/// The folder Claude Code's socket folder sits under where no runtime folder is set, and the one
/// its per-user fallback sits under.
const TEMPORARY_FOLDER: &str = "/tmp";

/// The longest socket path Claude Code binds, in bytes; a longer one takes the per-user fallback.
const SOCKET_PATH_MAX_BYTES: usize = 103;

/// The longest name Claude Code gives its own socket, `<process id>.sock` at Linux's largest
/// process id.
const PROCESS_SOCKET_NAME_MAX_BYTES: usize = "4194304.sock".len();

/// What Claude Code derives its socket folder from in one place.
pub(crate) struct SocketFolderEnvironment {
    /// The place's `XDG_RUNTIME_DIR`; `None` where it is unset or empty.
    pub(crate) runtime_folder: Option<String>,
    /// The person's user id in that place.
    pub(crate) user_id: u32,
}

/// Claude Code's socket folder in each place the daemon's start lists.
pub(crate) struct ClaudeSessionInboxFolders {
    folders: HashMap<Option<Place>, PathBuf>,
}

impl ClaudeSessionInboxFolders {
    /// The folders of `places`, each place (`None`: the computer's own system) with its
    /// environment; a place that names its sockets by path only.
    pub(crate) fn new(
        places: impl IntoIterator<Item = (Option<Place>, SocketFolderEnvironment)>,
    ) -> Self {
        Self {
            folders: places
                .into_iter()
                .map(|(place, environment)| (place, socket_folder(&environment)))
                .collect(),
        }
    }
}

impl SessionInboxFolders for ClaudeSessionInboxFolders {
    fn inbox_folder(&self, place: Option<&Place>) -> PathBuf {
        self.folders
            .get(&place.cloned())
            .cloned()
            .expect("the daemon's start lists each place it asks an inbox folder for")
    }
}

/// `<runtime folder or /tmp>/cc-socks` while Claude Code's own socket path in it fits the address
/// field, else `/tmp/cc-socks-<user id>`, as Claude Code places its own socket.
fn socket_folder(environment: &SocketFolderEnvironment) -> PathBuf {
    let separator = PathRules::Posix.separator();
    let base = environment
        .runtime_folder
        .as_deref()
        .filter(|folder| !folder.is_empty())
        .map_or(TEMPORARY_FOLDER, |folder| {
            folder
                .strip_suffix(separator)
                .filter(|trimmed| !trimmed.is_empty())
                .unwrap_or(folder)
        });
    let folder = format!("{base}{separator}{SOCKET_FOLDER_NAME}");
    if folder.len() + separator.len_utf8() + PROCESS_SOCKET_NAME_MAX_BYTES <= SOCKET_PATH_MAX_BYTES
    {
        return PathBuf::from(folder);
    }
    PathBuf::from(format!(
        "{TEMPORARY_FOLDER}{separator}{SOCKET_FOLDER_NAME}-{}",
        environment.user_id
    ))
}
