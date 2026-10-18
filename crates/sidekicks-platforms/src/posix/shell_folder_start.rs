//! A shell's folder start on macOS and Linux: `sh` enters the folder and then runs the shell.

use std::path::Path;

use crate::path::rules::PathRules;
use crate::shell_folder_start::ShellFolderStart;

/// How `program` with `arguments` starts in `folder`: `/bin/sh -c "cd <folder> && exec <program>
/// <arguments…>"` spawned in `stable_folder`; `exec` replaces `sh`, so a signal sent to the child
/// reaches the shell itself.
pub fn shell_folder_start(
    program: &str,
    arguments: &[String],
    folder: &str,
    stable_folder: &Path,
) -> ShellFolderStart {
    let quote = |word: &str| {
        PathRules::Posix
            .quote_shell_word(word)
            .expect("sh takes every word")
    };
    let mut script = format!("cd {} && exec {}", quote(folder), quote(program));
    for argument in arguments {
        script.push(' ');
        script.push_str(&quote(argument));
    }
    ShellFolderStart {
        program: "/bin/sh".to_owned(),
        arguments: vec!["-c".to_owned(), script],
        spawn_folder: stable_folder.to_path_buf(),
        added_environment: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::shell_folder_start;
    use crate::shell_folder_start::ShellFolderStart;

    // Fails when the shell spawns in its folder, or a word goes unquoted.
    #[test]
    fn a_shell_enters_its_folder_through_sh_from_the_stable_folder() {
        let start = shell_folder_start(
            "/bin/zsh",
            &["-l".to_owned()],
            "/work/it's 100%",
            Path::new("/stable"),
        );

        assert_eq!(
            start,
            ShellFolderStart {
                program: "/bin/sh".to_owned(),
                arguments: vec![
                    "-c".to_owned(),
                    r"cd '/work/it'\''s 100%' && exec '/bin/zsh' '-l'".to_owned(),
                ],
                spawn_folder: "/stable".into(),
                added_environment: Vec::new(),
            }
        );
    }
}
