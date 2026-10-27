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
use sidekicks_platforms::{EntryIdentity, PathRules, entry_identity, resolve_path};
use tokio::task::JoinError;
use url::Url;

use sidekicks_std::missing_entry::MissingEntry;
use sidekicks_std::random_hex::random_hex;

// `git@github.com:team/app.git`: a user and host, a colon, then a path that is not `//`. The user
// is tried first and the address read again without one when its path starts `//`, as a pattern
// that refuses `//` by lookahead backtracks.
static SCP_LIKE_ADDRESS_WITH_USER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[^@/]+@([^:/]+):([^\n\r\u{2028}\u{2029}]+)$").expect("the pattern is valid")
});
static SCP_LIKE_ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([^:/]+):([^\n\r\u{2028}\u{2029}]+)$").expect("the pattern is valid")
});

// A network address's scheme and `//`.
static NETWORK_ADDRESS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[A-Za-z][A-Za-z0-9+.-]*://").expect("the pattern is valid"));

// A network address's scheme and `//`, then the user and password before the host's `@`.
static ADDRESS_CREDENTIALS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#]*@").expect("the pattern is valid")
});

// Random bytes in a staged clone's folder name, so two clones of one name never meet.
const STAGED_CLONE_SUFFIX_BYTES: usize = 6;

/// The repository's name as `git clone` reads it from the address, which the daemon hands to git
/// as typed, by the running system's path separators: the last path part after the scheme, any
/// user and a lone host's port, with trailing separators and spaces, `/.git` and `.git` dropped
/// (`https://host/team/app.git` reads `app`), and each run of control characters and spaces made
/// one space. `None` when the address leaves no name, which no clone may use as a folder.
pub(crate) fn repository_name_of(url: &str) -> Option<String> {
    let is_separator = |character: char| PathRules::NATIVE.is_separator(character);
    let mut rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host_end = rest.find(is_separator).unwrap_or(rest.len());
    if let Some(user_end) = rest[..host_end].rfind('@') {
        rest = &rest[user_end + 1..];
    }
    let rest =
        rest.trim_end_matches(|character| is_separator(character) || is_git_space(character));
    let rest = match rest.strip_suffix(".git") {
        Some(before) if before.len() > 1 && before.ends_with(is_separator) => {
            before[..before.len() - 1].trim_end_matches(is_separator)
        }
        Some(_) | None => rest,
    };
    // A host alone (`host:2222`) loses its port, a colon and any digits after it.
    let rest = match rest.rfind(':') {
        Some(colon)
            if !rest.contains('/')
                && rest[colon + 1..].bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            &rest[..colon]
        }
        Some(_) | None => rest,
    };
    let last_part = rest
        .rfind(|character| is_separator(character) || character == ':')
        .map_or(rest, |separator| &rest[separator + 1..]);
    let last_part = last_part.strip_suffix(".git").unwrap_or(last_part);
    let mut name = String::with_capacity(last_part.len());
    let mut is_after_space = true;
    for character in last_part.chars() {
        if character <= ' ' {
            if is_after_space {
                continue;
            }
            is_after_space = true;
            name.push(' ');
        } else {
            is_after_space = false;
            name.push(character);
        }
    }
    if is_after_space {
        name.pop();
    }
    match name.as_str() {
        "" | "." | ".." => None,
        _ => Some(name),
    }
}

// git's own space set (its `ctype.c`), which it trims from an address's end; unlike the C
// library's, it holds no vertical tab or form feed.
fn is_git_space(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\n' | '\r')
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
    if let Some((host, repository_path)) = scp_like_parts_of(address, PathRules::NATIVE) {
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

// The host and path of a `user@host:path` address whose path does not start `//`; on a system
// with drive letters, an address git reads as a drive path is local instead.
fn scp_like_parts_of(address: &str, rules: PathRules) -> Option<(&str, &str)> {
    if rules.has_drive_letters() && has_git_drive_prefix(address) {
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

// git's own drive rule (`has_dos_drive_prefix`): any one character before a colon, not only a
// letter, since a drive may be given any character (`1:`, `ä:`).
fn has_git_drive_prefix(address: &str) -> bool {
    address.chars().nth(1) == Some(':')
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
    let Some(mut entries) = tokio::fs::read_dir(folder).await.none_if_missing()? else {
        return Ok(DestinationState::Missing);
    };
    Ok(match entries.next_entry().await? {
        Some(_) => DestinationState::Taken,
        None => DestinationState::Empty,
    })
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
    /// A file-system task on the folder stopped before it answered.
    #[error("a file-system task on the clone's folder stopped before it answered")]
    Interrupted(#[from] JoinError),
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
    // A path gone already is what the removal wanted, which the removal answers `Ok`.
    let path = folder.path.clone();
    tokio::task::spawn_blocking(move || sidekicks_platforms::remove_tree(&path)).await??;
    Ok(())
}

/// Renames a finished staged clone's folder to `destination`, first removing an empty folder
/// there, and answers it at its new path. Answers `None`, moving nothing, when the destination
/// holds anything; fails with any other error of the removal or the rename.
pub(crate) async fn move_staged_clone_into_place(
    folder: &StagedClone,
    destination: &Path,
) -> io::Result<Option<StagedClone>> {
    // Removing only an empty folder means a folder that filled is refused, never emptied.
    match tokio::fs::remove_dir(destination).await.none_if_missing() {
        Ok(_) => {}
        Err(error) if is_destination_filled(&error) => return Ok(None),
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
    use std::io::ErrorKind;

    use rstest::rstest;
    use sidekicks_platforms::{PathRules, UnremovableFile, is_superuser, resolve_path};

    use super::{
        DestinationState, StagedCloneError, address_without_credentials, make_staged_clone,
        move_staged_clone_into_place, read_destination_state, remove_staged_clone,
        repository_key_of, repository_name_of, scp_like_parts_of,
    };

    #[rstest]
    #[case::https("https://github.com/team/app.git", Some("app"))]
    #[case::trailing_slash("https://github.com/team/app/", Some("app"))]
    #[case::dot_git_folder("/work/app/.git", Some("app"))]
    #[case::scp_like("git@github.com:team/app.git", Some("app"))]
    #[case::scp_like_no_path("git@github.com:app.git", Some("app"))]
    #[case::drive_path("C:/work/app/", Some("app"))]
    // A backslash separates folders only where the system reads it so, as git reads it.
    #[case::backslashes(
        r"C:\work\app\",
        Some(if PathRules::NATIVE.is_separator('\\') { "app" } else { r"\work\app\" })
    )]
    #[case::trailing_line_feed("host:team/app.git\n", Some("app"))]
    // git's space set holds no vertical tab, so `.git` stays.
    #[case::trailing_vertical_tab("host:team/app.git\u{b}/", Some("app.git"))]
    #[case::host_only("host:", Some("host"))]
    #[case::host_and_port("https://host:8443", Some("host"))]
    #[case::user_and_host("ssh://ana@host", Some("host"))]
    #[case::control_characters("https://host/my\tapp  name.git", Some("my app name"))]
    #[case::parent("team/..", None)]
    #[case::only_dot_git("https://host/.git", Some("host"))]
    #[case::empty("", None)]
    fn reads_the_name_git_reads(#[case] url: &str, #[case] name: Option<&str>) {
        assert_eq!(repository_name_of(url).as_deref(), name);
    }

    #[rstest]
    #[case::transport_and_user("git@GitHub.com:team/app.git", "https://github.com/team/app")]
    #[case::ssh_scheme("ssh://git@github.com/team/app", "https://github.com/team/app.git/")]
    #[case::scp_like_leading_slash("git@github.com:/team/app", "github.com:team/app")]
    #[case::port_kept("https://host:8443/app", "https://host:8443/app.git")]
    #[case::file_address("file:///work/app.git", "/work/app")]
    #[case::folded_path("/work/x/../app", "/work/app/")]
    // A drive path is local where the system has drive letters, and an scp-like address elsewhere.
    #[case::drive_path(
        r"C:\work\app",
        if PathRules::NATIVE.has_drive_letters() { r"C:\work\x\..\app" } else { r"c:\work\app" }
    )]
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

    #[rstest]
    #[case::digit_drive_on_windows(PathRules::Windows, "1:repo", None)]
    #[case::accented_drive_on_windows(PathRules::Windows, "ä:repo", None)]
    #[case::two_letter_host_on_windows(PathRules::Windows, "ab:repo", Some(("ab", "repo")))]
    #[case::digit_host_on_posix(PathRules::Posix, "1:repo", Some(("1", "repo")))]
    fn reads_one_character_before_a_colon_as_a_drive_only_where_drives_exist(
        #[case] rules: PathRules,
        #[case] address: &str,
        #[case] parts: Option<(&str, &str)>,
    ) {
        assert_eq!(scp_like_parts_of(address, rules), parts);
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

        // A destination whose parent is gone answers the rename's own error and keeps the clone.
        let staged = make_staged_clone(&destination)
            .await
            .expect("the folder is made");
        let orphaned = scratch.path().join("gone").join("app");
        let refusal = move_staged_clone_into_place(&staged, &orphaned)
            .await
            .expect_err("the move fails");
        assert_eq!(refusal.kind(), ErrorKind::NotFound);
        assert!(staged.path.is_dir());

        // An absent destination takes the clone.
        let placed = move_staged_clone_into_place(&staged, &destination)
            .await
            .expect("the move answers")
            .expect("the clone moves into place");
        assert_eq!(placed.path, destination);

        // A staged clone already gone is removed without error.
        fs::remove_dir(&placed.path).expect("the folder goes");
        remove_staged_clone(&placed)
            .await
            .expect("the removal runs");

        // A staged clone whose parent became a file answers the read's error.
        let staged = make_staged_clone(&destination)
            .await
            .expect("the folder is made");
        let parent = destination.parent().expect("the destination has a parent");
        fs::rename(parent, scratch.path().join("projects-moved")).expect("the parent moves away");
        fs::write(parent, "a file").expect("a file takes the parent's path");
        let refusal = remove_staged_clone(&staged)
            .await
            .expect_err("the removal fails");
        assert!(
            matches!(&refusal, StagedCloneError::Io(error) if error.kind() == ErrorKind::NotADirectory),
            "{refusal:?}"
        );
    }

    #[tokio::test]
    async fn a_staged_clone_whose_removal_is_refused_fails_and_keeps_its_files() {
        // Root's override would let the removal through and prove nothing.
        if is_superuser() {
            return;
        }
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let staged = make_staged_clone(&scratch.path().join("app"))
            .await
            .expect("the folder is made");
        let locked = staged.path.join("objects");
        fs::create_dir(&locked).expect("a folder is made inside");
        let held = UnremovableFile::create_in(&locked, "pack").expect("a held file is made");
        fs::remove_file(held.path()).expect_err("the system refuses the file's removal");

        let refusal = remove_staged_clone(&staged)
            .await
            .expect_err("the removal fails");

        assert!(matches!(&refusal, StagedCloneError::Io(_)), "{refusal:?}");
        assert!(held.path().is_file());
    }
}
