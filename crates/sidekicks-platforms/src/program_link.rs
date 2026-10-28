//! A name beside a program that runs that program: a hard link, a symbolic link where the folder's
//! file system refuses a hard link, and on Windows a copy where it refuses a symbolic link too.

use std::fs::{self, File};
use std::io;
use std::path::Path;

use crate::{is_hard_link_unsupported, open_file_identity};

/// Makes `link` run `program`, left alone where it already opens that same file and made again
/// where it is missing, dangling or names another file, as an old build's link does after an
/// update. The new link is made beside it and renamed over it, so a command never finds the name
/// missing. Fails with the system's error when `program` cannot be read or no link can be made.
pub fn link_program(program: &Path, link: &Path) -> io::Result<()> {
    let program_identity = open_file_identity(&File::open(program)?)?;
    match File::open(link) {
        Ok(linked) if open_file_identity(&linked)? == program_identity => return Ok(()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut made_name = link.as_os_str().to_owned();
    made_name.push(format!(".new-{}", std::process::id()));
    let made = Path::new(&made_name);
    // A start that ended between the make and the rename left this name behind.
    if let Err(error) = fs::remove_file(made)
        && error.kind() != io::ErrorKind::NotFound
    {
        return Err(error);
    }
    make_link(program, made)?;
    fs::rename(made, link)
}

// Makes `made` a hard link to `program`, else a symbolic link, else on Windows a copy.
fn make_link(program: &Path, made: &Path) -> io::Result<()> {
    match fs::hard_link(program, made) {
        Err(error) if is_hard_link_unsupported(&error) => {}
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

    use super::link_program;
    use crate::open_file_identity;

    fn opens_program(link: &Path, program: &Path) -> bool {
        let identity = |path: &Path| {
            open_file_identity(&File::open(path).expect("the file opens")).expect("its identity")
        };
        identity(link) == identity(program)
    }

    // Fails when a start remakes a link that already runs the program, or leaves one that runs an
    // older build. Mutations: the same-file check dropped; any link that opens kept as it is; the
    // make skipped.
    #[test]
    fn a_start_makes_a_missing_link_keeps_a_current_one_and_remakes_a_stale_one() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let program = scratch.path().join("program");
        let link = scratch.path().join("program-link");
        fs::write(&program, b"first build").expect("the program is written");

        link_program(&program, &link).expect("the missing link is made");
        assert!(opens_program(&link, &program));

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
}
