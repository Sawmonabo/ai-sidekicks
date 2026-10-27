//! Where the daemon keeps each session's inbox, and its own, so Claude Code answers them: a socket
//! in Claude Code's default socket folder of each place, or a named pipe on native Windows. Claude
//! Code sends receipts, idle notices and artifact replies only to a socket in one of its default
//! folders whose name is shaped like its own, or to a pipe named `cc-msg-<32 hex>`.

use sha2::{Digest as _, Sha256};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::id::SessionId;

use crate::port::session_inbox_address::SessionInboxAddresser;

/// The variable Claude Code puts its socket folder under when it is set and not empty.
const RUNTIME_FOLDER_VARIABLE: &str = "XDG_RUNTIME_DIR";

/// The folder Claude Code puts its socket folder under where no runtime folder is set.
const TEMPORARY_FOLDER: &str = "/tmp";

/// Claude Code's socket folder, under the runtime folder or `/tmp`.
const SOCKET_FOLDER_NAME: &str = "cc-socks";

/// Claude Code's socket folder where the place's environment names no runtime folder, which is
/// also the answer for a place the daemon's start did not list.
const DEFAULT_SOCKET_FOLDER: &str = "/tmp/cc-socks";

/// The default socket folder macOS shows `/tmp` as, which Claude Code also answers into.
const PRIVATE_TEMPORARY_SOCKET_FOLDER: &str = "/private/tmp/cc-socks";

/// The named-pipe namespace and the name prefix Claude Code accepts a sender pipe under.
const WINDOWS_PIPE_PREFIX: &str = r"\\.\pipe\cc-msg-";

/// What a session inbox's name is derived from, before the session id.
const SESSION_INBOX_PURPOSE: &str = "session-inbox:";

/// What the daemon's own inbox name is derived from, before the place.
const DAEMON_INBOX_PURPOSE: &str = "daemon-inbox:";

/// The letters an inbox name starts with.
const NAME_FIRST_LETTERS: [char; 6] = ['a', 'b', 'c', 'd', 'e', 'f'];

/// What Claude Code's socket folder in one POSIX place is derived from.
pub struct PlaceInboxEnvironment<'a> {
    /// The place's login-shell environment captured at the daemon's start, never the daemon's own
    /// composed one, which points Claude Code's temporary folder elsewhere.
    pub login_shell: &'a [(String, String)],
    /// The person's user id in that place.
    pub user_id: u32,
}

/// Each session's inbox address, and the daemon's own, in every place: a socket named
/// `<16 lowercase hex>.sock` in Claude Code's default socket folder, or on native Windows the pipe
/// `\\.\pipe\cc-msg-<32 lowercase hex>`. The socket name matches Claude Code's `[0-9a-f]{1,16}`
/// sender pattern, starts with a letter so it never equals or reads as a process id, carries no
/// `<pid>-` prefix Claude Code's own cleanup removes, and is fixed-length, so every address fits
/// the socket address field.
pub struct ClaudeSessionInboxAddresser {
    /// Each listed POSIX place's socket folder, the computer's own system as `None`.
    folders: Vec<(Option<Place>, String)>,
}

impl ClaudeSessionInboxAddresser {
    /// The addresser for `places`, each POSIX place with its environment; a native Windows place
    /// needs none, since its inbox is a pipe.
    pub fn new<'a>(
        places: impl IntoIterator<Item = (Option<Place>, PlaceInboxEnvironment<'a>)>,
    ) -> Self {
        Self {
            folders: places
                .into_iter()
                .map(|(place, environment)| (place, socket_folder(&environment)))
                .collect(),
        }
    }

    fn address_in(&self, place: Option<&Place>, digest: &[u8]) -> FilesystemPath {
        let address = match place {
            Some(Place::Windows(_)) => format!(
                "{WINDOWS_PIPE_PREFIX}{}",
                base16ct::lower::encode_string(&digest[..16])
            ),
            None | Some(Place::Wsl(_)) => {
                let folder = self
                    .folders
                    .iter()
                    .find(|(listed, _)| listed.as_ref() == place)
                    .map_or(DEFAULT_SOCKET_FOLDER, |(_, folder)| folder.as_str());
                format!("{folder}/{}", socket_name(digest))
            }
        };
        FilesystemPath::new(address).expect("an inbox address is short and holds no NUL")
    }
}

impl SessionInboxAddresser for ClaudeSessionInboxAddresser {
    fn session_inbox_address(
        &self,
        session_id: &SessionId,
        place: Option<&Place>,
    ) -> FilesystemPath {
        let digest = Sha256::digest(format!(
            "{SESSION_INBOX_PURPOSE}{}",
            session_id.text().as_str()
        ));
        self.address_in(place, &digest)
    }

    // The place is keyed by its wire form, so no distribution's name reads as another place.
    fn daemon_inbox_address(&self, place: Option<&Place>) -> FilesystemPath {
        let place_key = serde_json::to_string(&place).expect("a place serializes");
        let digest = Sha256::digest(format!("{DAEMON_INBOX_PURPOSE}{place_key}"));
        self.address_in(place, &digest)
    }
}

/// `<16 lowercase hex>.sock` from `digest`: a letter `a`–`f` from its first byte, then the hex of
/// the next eight bytes less its last digit.
fn socket_name(digest: &[u8]) -> String {
    let first = NAME_FIRST_LETTERS[usize::from(digest[0]) % NAME_FIRST_LETTERS.len()];
    let mut rest = base16ct::lower::encode_string(&digest[1..9]);
    rest.pop();
    format!("{first}{rest}.sock")
}

/// Claude Code's default socket folder in one place: its runtime folder (else `/tmp`) plus
/// `/cc-socks`, kept only where Claude Code answers into it, else `/tmp/cc-socks-<user id>`. The
/// folder is compared as text and never resolved through links, as Claude Code compares it.
fn socket_folder(environment: &PlaceInboxEnvironment<'_>) -> String {
    let base = environment
        .login_shell
        .iter()
        .find(|(name, value)| name == RUNTIME_FOLDER_VARIABLE && !value.is_empty())
        .map_or(TEMPORARY_FOLDER, |(_, value)| value.as_str());
    let base = match base.trim_end_matches('/') {
        "" => "/",
        trimmed => trimmed,
    };
    let candidate = format!("{base}/{SOCKET_FOLDER_NAME}");
    let user_folder = format!("/run/user/{}/{SOCKET_FOLDER_NAME}", environment.user_id);
    if [
        DEFAULT_SOCKET_FOLDER,
        PRIVATE_TEMPORARY_SOCKET_FOLDER,
        &user_folder,
    ]
    .contains(&candidate.as_str())
    {
        return candidate;
    }
    format!(
        "{TEMPORARY_FOLDER}/{SOCKET_FOLDER_NAME}-{}",
        environment.user_id
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_contracts::place::Place;
    use sidekicks_store::database::writer::test_file::test_session_id;

    use super::{ClaudeSessionInboxAddresser, PlaceInboxEnvironment};
    use crate::port::session_inbox_address::SessionInboxAddresser as _;

    /// The folder `session_inbox_address` puts a session's socket in.
    fn folder_of(addresser: &ClaudeSessionInboxAddresser, place: Option<&Place>) -> String {
        let address = addresser.session_inbox_address(&test_session_id(), place);
        let (folder, _) = address
            .as_str()
            .rsplit_once('/')
            .expect("a socket address has a folder");
        folder.to_owned()
    }

    #[test]
    fn the_folder_is_claude_code_s_default_where_it_answers_into_it_else_the_per_user_one() {
        let runtime = |folder: &str| vec![("XDG_RUNTIME_DIR".to_owned(), folder.to_owned())];
        let cases = [
            (Vec::new(), 501, "/tmp/cc-socks"),
            (runtime("/run/user/1000"), 1000, "/run/user/1000/cc-socks"),
            (runtime("/run/user/1000/"), 1000, "/run/user/1000/cc-socks"),
            (runtime("/home/x/runtime"), 1000, "/tmp/cc-socks-1000"),
            (runtime("/run/user/1001"), 1000, "/tmp/cc-socks-1000"),
        ];
        for (login_shell, user_id, folder) in cases {
            let addresser = ClaudeSessionInboxAddresser::new([(
                None,
                PlaceInboxEnvironment {
                    login_shell: &login_shell,
                    user_id,
                },
            )]);
            assert_eq!(folder_of(&addresser, None), folder, "{login_shell:?}");
        }
        let ubuntu: Place =
            serde_json::from_value(json!({ "distro": "Ubuntu" })).expect("a WSL place");
        let unlisted = ClaudeSessionInboxAddresser::new([]);
        assert_eq!(folder_of(&unlisted, Some(&ubuntu)), "/tmp/cc-socks");
    }

    #[test]
    fn a_name_is_sixteen_lowercase_hex_starting_with_a_letter_and_one_per_session() {
        let addresser = ClaudeSessionInboxAddresser::new([]);
        let name_of = |session_id| {
            let address = addresser.session_inbox_address(&session_id, None);
            let (_, name) = address
                .as_str()
                .rsplit_once('/')
                .expect("a socket address has a name");
            name.to_owned()
        };
        let session_id = test_session_id();
        let name = name_of(session_id);
        let stem = name.strip_suffix(".sock").expect("a socket name");
        assert_eq!(stem.len(), 16, "{name}");
        assert!(
            stem.chars()
                .all(|character| matches!(character, '0'..='9' | 'a'..='f')),
            "{name}"
        );
        assert!(matches!(stem.chars().next(), Some('a'..='f')), "{name}");
        assert_eq!(name_of(session_id), name);
        assert_ne!(name_of(test_session_id()), name);
    }
}
