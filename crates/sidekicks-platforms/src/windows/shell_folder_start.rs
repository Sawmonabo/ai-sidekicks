//! A shell's folder start on Windows, by the shell's program. Windows keeps a handle on a process's
//! current folder; the console host keeps the daemon's, and a shell keeps the one it starts in
//! until it moves its own. cmd, Nushell and every other shell move it on `cd`, and the MSYS bash
//! shares it for removal, so they start in the folder, as every terminal starts them. Only
//! PowerShell never lets go of the folder it started in, so it starts in the system folder and is
//! told its folder by its own switch; WSL is told its folder as Windows Terminal tells it.

use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use windows_sys::Win32::UI::Shell::FOLDERID_System;

use crate::shell_folder_start::ShellFolderStart;
use crate::system_folder::read_known_folder;

/// Where the system folder usually is, used when the system cannot report it.
const SYSTEM_FOLDER_USUAL_PATH: &str = r"C:\Windows\System32";

/// The variable that keeps an MSYS bash login in the folder it starts in, not the home folder.
const STAY_IN_FOLDER_ENVIRONMENT_NAME: &str = "CHERE_INVOKING";

/// How `program` with `arguments` starts in `folder`: PowerShell, `wsl.exe`, and `cmd.exe` on a
/// share (which it refuses as its start folder) spawn in the system folder, where Windows Terminal
/// keeps itself, and are told the folder by their own switch; every other shell spawns in `folder`.
/// `_stable_folder` is the macOS and Linux spawn folder, which Windows does not use. Reads the
/// system folder, its usual path where that read fails (logged); never fails.
pub fn shell_folder_start(
    program: &str,
    arguments: &[String],
    folder: &str,
    _stable_folder: &Path,
) -> ShellFolderStart {
    let system_folder = read_known_folder(&FOLDERID_System, SYSTEM_FOLDER_USUAL_PATH);
    compose_shell_folder_start(program, arguments, folder, &system_folder)
}

// The start of `program` in `folder`, `system_folder` the folder a shell that must not hold
// `folder` spawns in.
fn compose_shell_folder_start(
    program: &str,
    arguments: &[String],
    folder: &str,
    system_folder: &Path,
) -> ShellFolderStart {
    let in_folder = |arguments: Vec<String>, added_environment| ShellFolderStart {
        program: program.to_owned(),
        arguments,
        spawn_folder: folder.into(),
        added_environment,
    };
    let in_system_folder = |arguments: Vec<String>| ShellFolderStart {
        program: program.to_owned(),
        arguments,
        spawn_folder: system_folder.to_path_buf(),
        added_environment: Vec::new(),
    };
    let leading = |first: Vec<String>| first.into_iter().chain(arguments.iter().cloned()).collect();
    let trailing = |last: Vec<String>| arguments.iter().cloned().chain(last).collect();
    match program_name(program).as_str() {
        // Its switch runs before the profile scripts, as a `Set-Location`, so the process's own
        // folder stays the system folder.
        "pwsh" => in_system_folder(leading(vec![
            "-NoLogo".to_owned(),
            "-WorkingDirectory".to_owned(),
            strip_trailing_separators(folder).to_owned(),
        ])),
        // It has no folder switch; the encoded command carries the path with no quoting hazard.
        "powershell" => in_system_folder(trailing(vec![
            "-NoLogo".to_owned(),
            "-NoExit".to_owned(),
            "-EncodedCommand".to_owned(),
            encode_set_location(folder),
        ])),
        "cmd" if is_share_path(folder) => in_system_folder(trailing(vec![
            "/K".to_owned(),
            "pushd".to_owned(),
            strip_trailing_separators(folder).to_owned(),
        ])),
        "wsl" => in_system_folder(leading(vec!["--cd".to_owned(), folder.to_owned()])),
        "bash" => in_folder(
            arguments.to_vec(),
            vec![(STAY_IN_FOLDER_ENVIRONMENT_NAME.to_owned(), "1".to_owned())],
        ),
        _ => in_folder(arguments.to_vec(), Vec::new()),
    }
}

// The program's file name without case and without its `.exe`: `C:\…\PwSh.EXE` reads `pwsh`.
fn program_name(program: &str) -> String {
    let name = program
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(program)
        .to_lowercase();
    name.strip_suffix(".exe").map(str::to_owned).unwrap_or(name)
}

// Whether `folder` is on a network share (`\\server\share\…`).
fn is_share_path(folder: &str) -> bool {
    folder.starts_with(r"\\") || folder.starts_with("//")
}

// `folder` without its trailing separators, which a quoted argument would read as an escaped
// quote; a drive's root keeps its own, since `C:` alone names the drive's current folder.
fn strip_trailing_separators(folder: &str) -> &str {
    let stripped = folder.trim_end_matches(['\\', '/']);
    if stripped.ends_with(':') || stripped.is_empty() {
        folder
    } else {
        stripped
    }
}

// The base64 of the UTF-16LE command `Set-Location -LiteralPath '<folder>'`, each `'` doubled.
fn encode_set_location(folder: &str) -> String {
    let command = format!("Set-Location -LiteralPath '{}'", folder.replace('\'', "''"));
    let bytes: Vec<u8> = command.encode_utf16().flat_map(u16::to_le_bytes).collect();
    STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rstest::rstest;

    use super::compose_shell_folder_start;
    use crate::shell_folder_start::ShellFolderStart;

    const SYSTEM_FOLDER: &str = r"C:\Windows\System32";

    // Mutations killed: PowerShell spawned in the worktree holds it for its life; a trailing `\`
    // kept breaks pwsh's quoted switch; cmd spawned on a share starts in the Windows folder;
    // MSYS bash without its variable opens in the home folder.
    #[rstest]
    #[case::pwsh_with_a_trailing_separator(
        r"C:\Program Files\PowerShell\7\pwsh.exe",
        r"C:\wt\it's\",
        SYSTEM_FOLDER,
        &["-NoLogo", "-WorkingDirectory", r"C:\wt\it's", "-Login"],
        &[]
    )]
    #[case::windows_powershell(
        "POWERSHELL.EXE",
        r"C:\wt\it's",
        SYSTEM_FOLDER,
        &[
            "-Login",
            "-NoLogo",
            "-NoExit",
            "-EncodedCommand",
            "UwBlAHQALQBMAG8AYwBhAHQAaQBvAG4AIAAtAEwAaQB0AGUAcgBhAGwAUABhAHQA\
             aAAgACcAQwA6AFwAdwB0AFwAaQB0ACcAJwBzACcA",
        ],
        &[]
    )]
    #[case::cmd_on_a_local_folder(
        r"C:\Windows\System32\cmd.exe",
        r"C:\wt",
        r"C:\wt",
        &["-Login"],
        &[]
    )]
    #[case::cmd_on_a_share(
        "cmd.exe",
        r"\\server\share\wt\",
        SYSTEM_FOLDER,
        &["-Login", "/K", "pushd", r"\\server\share\wt"],
        &[]
    )]
    #[case::msys_bash(
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\wt",
        r"C:\wt",
        &["-Login"],
        &[("CHERE_INVOKING", "1")]
    )]
    #[case::wsl("wsl", r"C:\wt", SYSTEM_FOLDER, &["--cd", r"C:\wt", "-Login"], &[])]
    #[case::nushell("nu.exe", r"C:\wt", r"C:\wt", &["-Login"], &[])]
    fn a_windows_shell_is_told_its_folder_by_its_own_means(
        #[case] program: &str,
        #[case] folder: &str,
        #[case] spawn_folder: &str,
        #[case] arguments: &[&str],
        #[case] added_environment: &[(&str, &str)],
    ) {
        let start = compose_shell_folder_start(
            program,
            &["-Login".to_owned()],
            folder,
            Path::new(SYSTEM_FOLDER),
        );

        assert_eq!(
            start,
            ShellFolderStart {
                program: program.to_owned(),
                arguments: arguments
                    .iter()
                    .map(|&argument| argument.to_owned())
                    .collect(),
                spawn_folder: spawn_folder.into(),
                added_environment: added_environment
                    .iter()
                    .map(|&(name, value)| (name.to_owned(), value.to_owned()))
                    .collect(),
            }
        );
    }
}
