//! Where a clone goes and whether it may: the repository's name as git reads it from the address,
//! the folder that name makes inside the clone folder, and whether that folder is free to clone
//! into. Two addresses are compared by the repository they name, whatever transport reaches it, and
//! an address is kept with no user or password in it. Git clones into a folder the daemon makes
//! beside the destination and knows by its identity, which alone a failure removes, and a finished
//! clone is renamed into place.

use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_platforms::{EntryIdentity, entry_identity};
use tokio::task::JoinError;
use url::Url;

use crate::path_resolution::resolve_path;
use crate::random_hex::random_hex;

// `git@github.com:team/app.git`: a user and host, a colon, then a path that is not `//`. The user
// is tried first and the address read again without one when its path starts `//`, as a pattern
// that refuses `//` by lookahead backtracks.
static SCP_LIKE_ADDRESS_WITH_USER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[^@/]+@([^:/]+):([^\n\r\u{2028}\u{2029}]+)$").expect("the pattern is valid")
});
static SCP_LIKE_ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([^:/]+):([^\n\r\u{2028}\u{2029}]+)$").expect("the pattern is valid")
});

// A Windows drive path, `C:\work\app` or `C:/work/app`, which the address form above would match.
static WINDOWS_DRIVE_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").expect("the pattern is valid"));

// A network address's scheme and `//`.
static NETWORK_ADDRESS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[A-Za-z][A-Za-z0-9+.-]*://").expect("the pattern is valid"));

// A network address's scheme and `//`, then the user and password before the host's `@`.
static ADDRESS_CREDENTIALS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#]*@").expect("the pattern is valid")
});

// Random bytes in a staged clone's folder name, so two clones of one name never meet.
const STAGED_CLONE_SUFFIX_BYTES: usize = 6;

/// The repository's name as `git clone` reads it from the address: the last path part with any
/// trailing slash, `/.git` and `.git` dropped (`https://host/team/app.git` reads `app`), or `None`
/// when the address leaves no name, which no clone may use as a folder.
pub(crate) fn repository_name_of(url: &str) -> Option<&str> {
    let is_separator = |character: char| character == '/' || character == '\\';
    let rest = url
        .trim_matches(is_ecmascript_whitespace)
        .trim_end_matches(is_separator);
    let rest = rest
        .strip_suffix("/.git")
        .or_else(|| rest.strip_suffix("\\.git"))
        .unwrap_or(rest)
        .trim_end_matches(is_separator);
    let last_part = rest
        .rfind(['/', '\\', ':'])
        .map_or(rest, |separator| &rest[separator + 1..]);
    let name = last_part.strip_suffix(".git").unwrap_or(last_part);
    match name {
        "" | "." | ".." => None,
        _ => Some(name),
    }
}

/// The repository an address names, for comparing two addresses: host and path for a network
/// address, whatever its transport and user (`git@host:team/app` and `https://host/team/app.git`
/// name one repository), and the absolute path for a local one or an address no rule reads. Fails
/// only as [`resolve_path`] fails, when the daemon's working folder cannot be read.
pub(crate) fn repository_key_of(url: &str) -> io::Result<String> {
    let address = url
        .trim_matches(is_ecmascript_whitespace)
        .trim_end_matches('/');
    let address = address.strip_suffix(".git").unwrap_or(address);
    if let Some((host, repository_path)) = scp_like_parts_of(address) {
        return Ok(format!(
            "{}/{}",
            host.to_lowercase(),
            repository_path.trim_start_matches('/')
        ));
    }
    if NETWORK_ADDRESS.is_match(address)
        && let Ok(parsed) = Url::parse(address)
    {
        if parsed.scheme() == "file" {
            // A `file:` address that names no local path is read as the path its text spells.
            let local_path = parsed
                .to_file_path()
                .ok()
                .and_then(|path| path.into_os_string().into_string().ok());
            return resolve_path(local_path.as_deref().unwrap_or(address));
        }
        let host = parsed.host_str().unwrap_or_default().to_lowercase();
        let port = parsed
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default();
        return Ok(format!("{host}{port}{}", parsed.path()));
    }
    resolve_path(address)
}

// The host and path of a `user@host:path` address whose path does not start `//`.
fn scp_like_parts_of(address: &str) -> Option<(&str, &str)> {
    if WINDOWS_DRIVE_PATH.is_match(address) {
        return None;
    }
    [&*SCP_LIKE_ADDRESS_WITH_USER, &*SCP_LIKE_ADDRESS]
        .into_iter()
        .find_map(|pattern| {
            let parts = pattern.captures(address)?;
            let (host, repository_path) = (parts.get(1)?.as_str(), parts.get(2)?.as_str());
            (!repository_path.starts_with("//")).then_some((host, repository_path))
        })
}

/// The address with any user and password taken out (`https://ana:token@host/app.git` reads
/// `https://host/app.git`), for keeping it; git still runs with the address as typed.
pub(crate) fn address_without_credentials(url: &str) -> String {
    ADDRESS_CREDENTIALS.replace(url, "$1").into_owned()
}

/// A clone destination as it stands: not there, an empty folder, or holding something.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DestinationState {
    /// Nothing is at the path.
    Missing,
    /// An empty folder is at the path.
    Empty,
    /// The folder holds something.
    Taken,
}

/// Reads whether `folder` is free to clone into: missing, or an empty folder. Fails with the read's
/// error for anything but a missing folder, a file in its place included.
pub(crate) async fn read_destination_state(folder: &Path) -> io::Result<DestinationState> {
    match tokio::fs::read_dir(folder).await {
        Ok(mut entries) => Ok(match entries.next_entry().await? {
            Some(_) => DestinationState::Taken,
            None => DestinationState::Empty,
        }),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(DestinationState::Missing),
        Err(error) => Err(error),
    }
}

/// The folder the daemon made for a clone to run in, known by its identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StagedClone {
    /// Where the folder is.
    pub(crate) path: PathBuf,
    /// The folder's identity as it read when it was made; its text is what the clone's row keeps.
    pub(crate) identity: EntryIdentity,
}

/// Why a staged clone's folder could not be made, removed or moved into place.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StagedCloneError {
    /// The system gave no random bytes for the folder's name.
    #[error("the clone's folder could not be named")]
    Naming(#[source] getrandom::Error),
    /// Something other than the folder this call made stood at its path when it was read.
    #[error("the clone's folder was replaced as it was made")]
    Replaced,
    /// A file-system call on the folder or its parent failed.
    #[error("a file-system call on the clone's folder failed")]
    Io(#[from] io::Error),
    /// The read of the folder's identity stopped before it answered.
    #[error("the read of the clone's folder stopped")]
    Read(#[from] JoinError),
}

/// Makes the folder git clones into, hidden beside `destination` in its parent (made when
/// missing), by a create that fails if the folder exists, so the folder answered is one this call
/// made. The folder takes the system's default mode, since it becomes the project's folder.
/// `destination` is a parent folder joined with a repository name.
pub(crate) async fn make_staged_clone(destination: &Path) -> Result<StagedClone, StagedCloneError> {
    let parent = destination
        .parent()
        .expect("the caller joins a repository name to a parent folder");
    let name = destination
        .file_name()
        .expect("the caller joins a repository name to a parent folder");
    tokio::fs::create_dir_all(parent).await?;
    let suffix = random_hex(STAGED_CLONE_SUFFIX_BYTES).map_err(StagedCloneError::Naming)?;
    let mut folder_name = OsString::from(".");
    folder_name.push(name);
    folder_name.push(format!(".clone-{suffix}"));
    let folder = parent.join(folder_name);
    tokio::fs::create_dir(&folder).await?;
    let identity = read_folder_identity(folder.clone())
        .await?
        .ok_or(StagedCloneError::Replaced)?;
    Ok(StagedClone {
        path: folder,
        identity,
    })
}

/// Removes a staged clone's folder only while the path still holds that same folder; a path gone,
/// or holding anything else, is left as it is. Fails with the read's or the removal's error.
pub(crate) async fn remove_staged_clone(folder: &StagedClone) -> Result<(), StagedCloneError> {
    let identity = match read_folder_identity(folder.path.clone()).await {
        Ok(identity) => identity,
        Err(StagedCloneError::Io(error)) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if identity != Some(folder.identity) {
        return Ok(());
    }
    match tokio::fs::remove_dir_all(&folder.path).await {
        Ok(()) => Ok(()),
        // Gone already is what the removal wanted.
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Renames a finished staged clone's folder to `destination`, first removing an empty folder
/// there, and answers it at its new path. Answers `None`, moving nothing, when the destination
/// holds anything; fails with any other error of the removal or the rename.
pub(crate) async fn move_staged_clone_into_place(
    folder: &StagedClone,
    destination: &Path,
) -> io::Result<Option<StagedClone>> {
    // Removing only an empty folder means a folder that filled is refused, never emptied.
    match tokio::fs::remove_dir(destination).await {
        Ok(()) => {}
        Err(error) if is_destination_filled(&error) => return Ok(None),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    match tokio::fs::rename(&folder.path, destination).await {
        Ok(()) => Ok(Some(StagedClone {
            path: destination.to_owned(),
            identity: folder.identity,
        })),
        Err(error) if is_destination_filled(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

// Whether a removal or a rename failed because something stands at the destination.
fn is_destination_filled(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::DirectoryNotEmpty | ErrorKind::AlreadyExists | ErrorKind::NotADirectory
    )
}

// The identity of the folder at `path`, or `None` when anything else stands there; never follows
// a link.
async fn read_folder_identity(path: PathBuf) -> Result<Option<EntryIdentity>, StagedCloneError> {
    let entry = tokio::task::spawn_blocking(move || entry_identity(&path)).await??;
    Ok(entry.is_folder.then_some(entry.identity))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rstest::rstest;

    use super::{
        DestinationState, address_without_credentials, make_staged_clone,
        move_staged_clone_into_place, read_destination_state, remove_staged_clone,
        repository_key_of, repository_name_of,
    };
    use crate::path_resolution::resolve_path;

    #[rstest]
    #[case::https("https://github.com/team/app.git", Some("app"))]
    #[case::trailing_slash("https://github.com/team/app/", Some("app"))]
    #[case::dot_git_folder("/work/app/.git", Some("app"))]
    #[case::scp_like("git@github.com:team/app.git", Some("app"))]
    #[case::scp_like_no_path("git@github.com:app.git", Some("app"))]
    #[case::windows_path("C:\\work\\app\\", Some("app"))]
    #[case::padded("  https://host/app.git \u{feff}", Some("app"))]
    #[case::host_only("host:", None)]
    #[case::parent("team/..", None)]
    #[case::only_dot_git("https://host/.git", Some("host"))]
    #[case::empty("", None)]
    fn reads_the_name_git_reads(#[case] url: &str, #[case] name: Option<&str>) {
        assert_eq!(repository_name_of(url), name);
    }

    #[rstest]
    #[case::transport_and_user("git@GitHub.com:team/app.git", "https://github.com/team/app")]
    #[case::ssh_scheme("ssh://git@github.com/team/app", "https://github.com/team/app.git/")]
    #[case::scp_like_leading_slash("git@github.com:/team/app", "github.com:team/app")]
    #[case::port_kept("https://host:8443/app", "https://host:8443/app.git")]
    #[case::file_address("file:///work/app.git", "/work/app")]
    #[case::folded_path("/work/x/../app", "/work/app/")]
    fn compares_addresses_by_the_repository_they_name(#[case] left: &str, #[case] right: &str) {
        assert_eq!(
            repository_key_of(left).expect("the key reads"),
            repository_key_of(right).expect("the key reads")
        );
    }

    #[rstest]
    #[case::other_port("https://host:8443/app", "https://host/app")]
    #[case::scp_like_double_slash("host://team/app", "host:team/app")]
    fn tells_two_repositories_apart(#[case] left: &str, #[case] right: &str) {
        assert_ne!(
            repository_key_of(left).expect("the key reads"),
            repository_key_of(right).expect("the key reads")
        );
    }

    #[test]
    fn reads_a_relative_or_unconvertible_address_as_the_path_it_spells() {
        for address in ["team/app", "file://server/share/app"] {
            assert_eq!(
                repository_key_of(address).expect("the key reads"),
                resolve_path(address).expect("the path resolves")
            );
        }
    }

    #[rstest]
    #[case::user_and_password("https://ana:token@host/app.git", "https://host/app.git")]
    #[case::user_only("ssh://git@host/app", "ssh://host/app")]
    #[case::upper_case_scheme("HTTPS://ana:token@host/app", "HTTPS://host/app")]
    #[case::no_credentials("https://host/app", "https://host/app")]
    #[case::at_in_path("https://host/team/@app", "https://host/team/@app")]
    #[case::scp_like_kept("git@host:app.git", "git@host:app.git")]
    fn keeps_no_credential_in_an_address(#[case] url: &str, #[case] kept: &str) {
        assert_eq!(address_without_credentials(url), kept);
    }

    #[tokio::test]
    async fn removes_only_the_folder_it_made_and_never_moves_onto_a_filled_destination() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let destination = scratch.path().join("projects").join("app");

        // A folder replaced at the staged path after it was made survives the removal.
        let replaced = make_staged_clone(&destination)
            .await
            .expect("the folder is made");
        fs::rename(&replaced.path, scratch.path().join("moved")).expect("the folder moves away");
        fs::create_dir(&replaced.path).expect("another folder takes the path");
        remove_staged_clone(&replaced)
            .await
            .expect("the removal runs");
        assert!(replaced.path.is_dir());

        // A filled destination refuses the move and keeps both folders.
        let staged = make_staged_clone(&destination)
            .await
            .expect("the folder is made");
        fs::create_dir(&destination).expect("the destination is made");
        fs::write(destination.join("note"), "kept").expect("the destination fills");
        assert_eq!(
            read_destination_state(&destination)
                .await
                .expect("the state reads"),
            DestinationState::Taken
        );
        let refused = move_staged_clone_into_place(&staged, &destination)
            .await
            .expect("the move answers");
        assert_eq!(refused, None);
        assert!(staged.path.is_dir());
        assert!(destination.join("note").is_file());

        // An empty destination is replaced, and the clone is answered at it.
        fs::remove_file(destination.join("note")).expect("the destination empties");
        let placed = move_staged_clone_into_place(&staged, &destination)
            .await
            .expect("the move answers")
            .expect("the clone moves into place");
        assert_eq!(placed.path, destination);
        assert!(!staged.path.exists());
        remove_staged_clone(&placed)
            .await
            .expect("the removal runs");
        assert_eq!(
            read_destination_state(&destination)
                .await
                .expect("the state reads"),
            DestinationState::Missing
        );
    }
}
