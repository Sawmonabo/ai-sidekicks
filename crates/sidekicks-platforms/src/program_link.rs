//! A link in a folder of the daemon's own that runs the daemon's program under another name: a hard
//! link, a symbolic link where the folder's file system refuses a hard link or the program sits on
//! another volume, and on Windows a copy where it refuses a symbolic link too.

use std::fs::{self, File};
use std::io;
use std::path::Path;

use crate::{is_hard_link_unsupported, open_file_identity};

/// Why a link could not be made to run the program.
#[derive(Debug, thiserror::Error)]
pub enum ProgramLinkError {
    /// No link was there and none could be made, so its mode cannot run.
    #[error("the missing link could not be made")]
    Missing(#[source] io::Error),
    /// A link that opens another build, or cannot be read, is there and could not be made again,
    /// as on Windows a copy a running command holds open; it stays as it is.
    #[error("the stale link could not be made again")]
    Stale(#[source] io::Error),
}

// What stands at a link's name.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LinkState {
    // A link that opens the program itself.
    Current,
    // A file that opens another build, or one that cannot be read.
    Stale,
    // Nothing, or a dangling link.
    Missing,
}

/// Makes `link` run `program`, left alone where it already opens that same file and made again
/// where it is missing, dangling or names another file, as an old build's link does after an
/// update. Any half-made link an earlier start left is removed first; the new link is made beside
/// it and renamed over it, so a command never finds the name missing. Fails with
/// [`ProgramLinkError::Missing`] when no link was there to run, else [`ProgramLinkError::Stale`].
pub fn link_program(program: &Path, link: &Path) -> Result<(), ProgramLinkError> {
    let program_identity = File::open(program)
        .and_then(|program| open_file_identity(&program))
        .map_err(ProgramLinkError::Missing)?;
    let state = match File::open(link).and_then(|linked| open_file_identity(&linked)) {
        Ok(identity) if identity == program_identity => LinkState::Current,
        Ok(_) => LinkState::Stale,
        Err(error) if error.kind() == io::ErrorKind::NotFound => LinkState::Missing,
        Err(error) => return Err(ProgramLinkError::Stale(error)),
    };
    let linked = remove_half_made_links(link).and_then(|()| match state {
        LinkState::Current => Ok(()),
        LinkState::Stale | LinkState::Missing => replace_link(program, link),
    });
    linked.map_err(|error| match state {
        LinkState::Missing => ProgramLinkError::Missing(error),
        LinkState::Current | LinkState::Stale => ProgramLinkError::Stale(error),
    })
}

// Removes every `<link>.new-*` beside `link`, which a start that ended between its make and its
// rename left behind; one daemon holds the data folder, so no other start is making one now.
fn remove_half_made_links(link: &Path) -> io::Result<()> {
    let (Some(folder), Some(name)) = (link.parent(), link.file_name()) else {
        return Ok(());
    };
    let mut prefix = name.to_owned();
    prefix.push(".new-");
    let prefix = prefix.as_encoded_bytes();
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        if !entry.file_name().as_encoded_bytes().starts_with(prefix) {
            continue;
        }
        if let Err(error) = fs::remove_file(entry.path())
            && error.kind() != io::ErrorKind::NotFound
        {
            return Err(error);
        }
    }
    Ok(())
}

// Makes a new link at `<link>.new-<pid>` and renames it over `link`.
fn replace_link(program: &Path, link: &Path) -> io::Result<()> {
    let mut made_name = link.as_os_str().to_owned();
    made_name.push(format!(".new-{}", std::process::id()));
    let made = Path::new(&made_name);
    make_link(program, made)?;
    fs::rename(made, link)
}

// Makes `made` a hard link to `program`, else a symbolic link, else on Windows a copy.
fn make_link(program: &Path, made: &Path) -> io::Result<()> {
    match fs::hard_link(program, made) {
        Err(error)
            if is_hard_link_unsupported(&error)
                || error.kind() == io::ErrorKind::CrossesDevices => {}
        made_or_refused => return made_or_refused,
    }
    #[cfg(unix)]
    return std::os::unix::fs::symlink(program, made);
    // A symbolic link needs a privilege or developer mode on Windows; a copy needs neither.
    #[cfg(windows)]
    match std::os::windows::fs::symlink_file(program, made) {
        Ok(()) => Ok(()),
        Err(_) => fs::copy(program, made).map(drop),
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::path::Path;

    use super::{ProgramLinkError, link_program};
    use crate::open_file_identity;

    fn opens_program(link: &Path, program: &Path) -> bool {
        let identity = |path: &Path| {
            open_file_identity(&File::open(path).expect("the file opens")).expect("its identity")
        };
        identity(link) == identity(program)
    }

    // Fails when a start remakes a link that already runs the program, leaves one that runs an
    // older build, or keeps a half-made link a crashed start left. Mutations: the same-file check
    // dropped; any link that opens kept as it is; the make skipped; the sweep skipped.
    #[test]
    fn a_start_makes_a_missing_link_keeps_a_current_one_and_remakes_a_stale_one() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let program = scratch.path().join("program");
        let links = scratch.path().join("bin");
        fs::create_dir(&links).expect("the link folder is made");
        let link = links.join("program-link");
        let half_made = links.join("program-link.new-1");
        fs::write(&program, b"first build").expect("the program is written");
        fs::write(&half_made, b"left by a crashed start").expect("a half-made link is left");

        link_program(&program, &link).expect("the missing link is made");
        assert!(opens_program(&link, &program));
        assert!(
            !half_made.exists(),
            "a crashed start's half-made link is removed"
        );

        fs::remove_file(&program).expect("the old build goes");
        fs::write(&program, b"second build").expect("the new build is written");
        link_program(&program, &link).expect("the stale link is made again");
        assert!(opens_program(&link, &program));
        assert_eq!(fs::read(&link).expect("the link reads"), b"second build");

        // A link the symbolic fallback made stays one, where a remade link would be a hard link.
        #[cfg(unix)]
        {
            fs::remove_file(&link).expect("the hard link goes");
            std::os::unix::fs::symlink(&program, &link).expect("a symbolic link is made");
            link_program(&program, &link).expect("a second start passes");
            assert_eq!(
                fs::read_link(&link).expect("the link stays symbolic"),
                program
            );
        }
    }

    // Fails when a folder that takes no new link fails a start that still has a link to run, or
    // lets a start go on with no link at all. Mutations: every failure read as missing; every
    // failure read as stale.
    #[cfg(unix)]
    #[test]
    fn a_folder_that_takes_no_link_fails_a_missing_link_and_keeps_a_stale_one() {
        use std::os::unix::fs::PermissionsExt as _;

        let scratch = tempfile::tempdir().expect("a scratch folder");
        let program = scratch.path().join("program");
        let links = scratch.path().join("bin");
        fs::create_dir(&links).expect("the link folder is made");
        let stale = links.join("stale-link");
        fs::write(&program, b"this build").expect("the program is written");
        fs::write(&stale, b"an older build").expect("a stale link is there");
        fs::set_permissions(&links, fs::Permissions::from_mode(0o555))
            .expect("the link folder is made read-only");

        let missing = link_program(&program, &links.join("missing-link"));
        let kept = link_program(&program, &stale);
        fs::set_permissions(&links, fs::Permissions::from_mode(0o755))
            .expect("the link folder is made writable again");

        assert!(
            matches!(missing, Err(ProgramLinkError::Missing(_))),
            "{missing:?}"
        );
        assert!(matches!(kept, Err(ProgramLinkError::Stale(_))), "{kept:?}");
        assert_eq!(
            fs::read(&stale).expect("the stale link reads"),
            b"an older build"
        );
    }
}
