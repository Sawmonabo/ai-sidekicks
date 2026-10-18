//! A shell's folder start on Windows, by the shell's program. Windows keeps a handle on a process's
//! current folder; the console host keeps the daemon's, and the `shell` mode, spawned in the system
//! folder, keeps that one for its whole wait. A shell keeps the folder it starts in until it moves
//! its own: cmd, Nushell and every other shell move it on `cd`, and the MSYS bash shares it for
//! removal, so they start in the folder, as every terminal starts them. Only PowerShell never lets
//! go of the folder it started in, so it starts in the system folder and is told its folder by its
//! own switch; WSL is told its folder as Windows Terminal tells it.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use windows_sys::Win32::UI::Shell::FOLDERID_System;

use crate::path::rules::PathRules;
use crate::shell_folder_start::ShellFolderStart;
use crate::system_folder::read_known_folder;

/// Where the system folder usually is, used when the system cannot report it.
const SYSTEM_FOLDER_USUAL_PATH: &str = r"C:\Windows\System32";

/// The variable that keeps an MSYS bash login in the folder it starts in, not the home folder.
const STAY_IN_FOLDER_ENVIRONMENT_NAME: &str = "CHERE_INVOKING";

/// The PowerShell switches after which the rest of the line is the user's command or script,
/// compared without case, as PowerShell reads them.
const POWERSHELL_COMMAND_SWITCHES: [&str; 4] = ["-Command", "-c", "-File", "-f"];

/// How `program` with `arguments` starts in `folder`: the `shell` mode is spawned in the system
/// folder, where Windows Terminal keeps itself; PowerShell, `wsl.exe` and `cmd.exe` on a share
/// (which it refuses as its start folder) start there too and are told the folder by their own
/// switch, and every other shell starts in `folder`. `_stable_folder` is the macOS and Linux spawn
/// folder, which Windows does not use. Reads the system folder, its usual path where that read
/// fails (logged); never fails.
pub fn shell_folder_start(
    program: &str,
    arguments: &[String],
    folder: &str,
    _stable_folder: &Path,
) -> ShellFolderStart {
    let system_folder = read_known_folder(&FOLDERID_System, SYSTEM_FOLDER_USUAL_PATH);
    compose_shell_folder_start(program, arguments, folder, &system_folder)
}

// The start of `program` in `folder`, `system_folder` the folder the mode spawns in and a shell
// that must not hold `folder` starts in.
fn compose_shell_folder_start(
    program: &str,
    arguments: &[String],
    folder: &str,
    system_folder: &Path,
) -> ShellFolderStart {
    let start = |arguments: Vec<String>, shell_folder: PathBuf| ShellFolderStart {
        program: program.to_owned(),
        arguments,
        spawn_folder: system_folder.to_path_buf(),
        shell_folder,
        added_environment: Vec::new(),
        raw_command_tail: None,
    };
    let in_folder = || start(arguments.to_vec(), PathBuf::from(folder));
    let told_by_switch = |switches: Vec<String>| {
        start(
            switches
                .into_iter()
                .chain(arguments.iter().cloned())
                .collect(),
            system_folder.to_path_buf(),
        )
    };
    match program_name(program).as_str() {
        // A folder switch cannot share a line with the user's own command, so the shell starts in
        // the folder with the user's arguments, as every terminal starts it.
        "pwsh" | "powershell" if has_powershell_command_switch(arguments) => in_folder(),
        // Its switch runs before the profile scripts, as a `Set-Location`, so the process's own
        // folder stays the system folder.
        "pwsh" => told_by_switch(vec![
            "-NoLogo".to_owned(),
            "-WorkingDirectory".to_owned(),
            strip_trailing_separators(folder).to_owned(),
        ]),
        // It has no folder switch; the encoded command carries the path with no quoting hazard.
        "powershell" => told_by_switch(vec![
            "-NoLogo".to_owned(),
            "-NoExit".to_owned(),
            "-EncodedCommand".to_owned(),
            encode_set_location(folder),
        ]),
        // cmd parses the text after `/K` itself, so the folder is written in its own quoting and
        // reaches it unchanged.
        "cmd" if is_share_path(folder) => ShellFolderStart {
            raw_command_tail: Some(format!(
                "/K pushd {}",
                PathRules::Windows
                    .quote_shell_word(strip_trailing_separators(folder))
                    .expect("a Windows path holds no line break")
            )),
            ..start(arguments.to_vec(), system_folder.to_path_buf())
        },
        // The user's own `--cd` or `~` names the folder WSL opens in.
        "wsl"
            if arguments
                .iter()
                .any(|argument| argument == "--cd" || argument == "~") =>
        {
            start(arguments.to_vec(), system_folder.to_path_buf())
        }
        "wsl" => told_by_switch(vec!["--cd".to_owned(), folder.to_owned()]),
        // The system folder's `bash.exe` is WSL's own launcher, which starts as any other program.
        "bash" if !is_in_folder(program, system_folder) => ShellFolderStart {
            added_environment: vec![(STAY_IN_FOLDER_ENVIRONMENT_NAME.to_owned(), "1".to_owned())],
            ..in_folder()
        },
        _ => in_folder(),
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

// Whether `program` names a file directly inside `folder`, compared without case; a bare name
// names none.
fn is_in_folder(program: &str, folder: &Path) -> bool {
    let Some((parent, _name)) = program.rsplit_once(['\\', '/']) else {
        return false;
    };
    let folder = folder.to_string_lossy();
    parent
        .replace('/', "\\")
        .trim_end_matches('\\')
        .eq_ignore_ascii_case(folder.replace('/', "\\").trim_end_matches('\\'))
}

// Whether the user's arguments carry a switch whose rest is their own command or script.
fn has_powershell_command_switch(arguments: &[String]) -> bool {
    arguments.iter().any(|argument| {
        POWERSHELL_COMMAND_SWITCHES
            .iter()
            .any(|switch| argument.eq_ignore_ascii_case(switch))
    })
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

    // Mutations killed: PowerShell started in the worktree holds it for its life; a trailing `\`
    // kept breaks pwsh's quoted switch; a folder switch put before the user's own command; cmd
    // started on a share starts in the Windows folder, and a share path with `&` or `%` left bare
    // runs a command; MSYS bash without its variable opens in the home folder, and WSL's launcher
    // given it goes through the MSYS arm; `--cd` added over the user's own `~`.
    #[rstest]
    #[case::pwsh_with_a_trailing_separator(
        r"C:\Program Files\PowerShell\7\pwsh.exe",
        &["-Login"],
        r"C:\wt\it's\",
        &["-NoLogo", "-WorkingDirectory", r"C:\wt\it's", "-Login"],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::pwsh_with_the_user_s_command(
        "pwsh",
        &["-COMMAND", "Get-Date"],
        r"C:\wt",
        &["-COMMAND", "Get-Date"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::windows_powershell(
        "POWERSHELL.EXE",
        &["-Login"],
        r"C:\wt\it's",
        &[
            "-NoLogo",
            "-NoExit",
            "-EncodedCommand",
            "UwBlAHQALQBMAG8AYwBhAHQAaQBvAG4AIAAtAEwAaQB0AGUAcgBhAGwAUABhAHQA\
             aAAgACcAQwA6AFwAdwB0AFwAaQB0ACcAJwBzACcA",
            "-Login",
        ],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::windows_powershell_with_the_user_s_script(
        "powershell.exe",
        &["-f", "start.ps1"],
        r"C:\wt",
        &["-f", "start.ps1"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::cmd_on_a_local_folder(
        r"C:\Windows\System32\cmd.exe",
        &["-Login"],
        r"C:\wt",
        &["-Login"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::cmd_on_a_share(
        "cmd.exe",
        &["-Login"],
        r"\\server\share\a&b 100%\",
        &["-Login"],
        SYSTEM_FOLDER,
        &[],
        Some(r#"/K pushd "\\server\share\a&b 100%%cd:~,%""#)
    )]
    #[case::msys_bash(
        r"C:\Program Files\Git\bin\bash.exe",
        &["-Login"],
        r"C:\wt",
        &["-Login"],
        r"C:\wt",
        &[("CHERE_INVOKING", "1")],
        None
    )]
    #[case::wsl_launcher_bash(
        r"c:\windows\system32\BASH.EXE",
        &["-Login"],
        r"C:\wt",
        &["-Login"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::wsl("wsl", &["-Login"], r"C:\wt", &["--cd", r"C:\wt", "-Login"], SYSTEM_FOLDER, &[], None)]
    #[case::wsl_in_the_home_folder("wsl.exe", &["~"], r"C:\wt", &["~"], SYSTEM_FOLDER, &[], None)]
    #[case::nushell("nu.exe", &["-Login"], r"C:\wt", &["-Login"], r"C:\wt", &[], None)]
    fn a_windows_shell_is_told_its_folder_by_its_own_means(
        #[case] program: &str,
        #[case] arguments: &[&str],
        #[case] folder: &str,
        #[case] started_arguments: &[&str],
        #[case] shell_folder: &str,
        #[case] added_environment: &[(&str, &str)],
        #[case] raw_command_tail: Option<&str>,
    ) {
        fn owned(words: &[&str]) -> Vec<String> {
            words.iter().map(|&word| word.to_owned()).collect()
        }

        let start = compose_shell_folder_start(
            program,
            &owned(arguments),
            folder,
            Path::new(SYSTEM_FOLDER),
        );

        assert_eq!(
            start,
            ShellFolderStart {
                program: program.to_owned(),
                arguments: owned(started_arguments),
                spawn_folder: SYSTEM_FOLDER.into(),
                shell_folder: shell_folder.into(),
                added_environment: added_environment
                    .iter()
                    .map(|&(name, value)| (name.to_owned(), value.to_owned()))
                    .collect(),
                raw_command_tail: raw_command_tail.map(str::to_owned),
            }
        );
    }
}
