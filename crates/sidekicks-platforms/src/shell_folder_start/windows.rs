//! How a shell starts in its folder on Windows, by the shell's program, composed on every host.
//! Windows keeps a handle on a process's current folder; the console host keeps the daemon's, and
//! the `shell` mode, spawned in the system folder, keeps that one for its whole wait. A shell keeps
//! the folder it starts in until it moves its own: cmd, Nushell and every other shell move it on
//! `cd`, and the MSYS bash shares it for removal, so they start in the folder, as every terminal
//! starts them. Only PowerShell never lets go of the folder it started in, so where its arguments
//! leave room it starts in the system folder and is told its folder by a switch or a command; WSL
//! is told its folder as Windows Terminal tells it.

use std::path::{Path, PathBuf};

use crate::path::rules::PathRules;
use crate::shell_folder_start::ShellFolderStart;

/// The variable that keeps an MSYS bash login in the folder it starts in, not the home folder.
const STAY_IN_FOLDER_ENVIRONMENT_NAME: &str = "CHERE_INVOKING";

/// The characters PowerShell reads as a dash before a switch's name.
const POWERSHELL_DASHES: [char; 4] = ['-', '\u{2013}', '\u{2014}', '\u{2015}'];

/// The characters PowerShell reads as a single quote, each doubled inside a single-quoted string.
const POWERSHELL_SINGLE_QUOTES: [char; 5] = ['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];

/// What follows a PowerShell switch on its command line.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SwitchOperand {
    /// Nothing: the next argument is read on its own.
    Nothing,
    /// The next argument, the switch's value.
    One,
    /// The rest of the line, a script path and its arguments.
    Script,
    /// The rest of the line, a command.
    Command,
}

/// Which PowerShell takes its folder start beside a switch.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AllowingPowerShells {
    /// Both: pwsh's folder switch and Windows PowerShell's folder command.
    Both,
    /// Only pwsh: Windows PowerShell has no such switch, or the switch leaves no room for its
    /// folder command.
    PwshOnly,
}

/// A switch PowerShell reads at start: its name, the shortest prefix of it PowerShell takes, what
/// follows it, and which PowerShell takes its folder start beside it. pwsh takes it beside every
/// switch but a script's, which its operand decides.
struct PowerShellSwitch {
    name: &'static str,
    shortest: &'static str,
    operand: SwitchOperand,
    allowed_by: AllowingPowerShells,
}

const fn powershell_switch(
    name: &'static str,
    shortest: &'static str,
    operand: SwitchOperand,
    allowed_by: AllowingPowerShells,
) -> PowerShellSwitch {
    PowerShellSwitch {
        name,
        shortest,
        operand,
        allowed_by,
    }
}

/// The switches whose operand or effect decides the folder start, each at its shortest spelling
/// PowerShell takes. No spelling names two different switches, so the first match is PowerShell's
/// reading. A switch missing here is one pwsh reads with no operand, or one it does not know, which
/// it reads as a script path and then fails to start on; beside a switch missing here, Windows
/// PowerShell's folder start is refused.
const POWERSHELL_SWITCHES: [PowerShellSwitch; 32] = [
    powershell_switch(
        "nologo",
        "nol",
        SwitchOperand::Nothing,
        AllowingPowerShells::Both,
    ),
    powershell_switch(
        "noprofile",
        "nop",
        SwitchOperand::Nothing,
        AllowingPowerShells::Both,
    ),
    powershell_switch(
        "noexit",
        "noe",
        SwitchOperand::Nothing,
        AllowingPowerShells::Both,
    ),
    powershell_switch(
        "login",
        "l",
        SwitchOperand::Nothing,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "mta",
        "mta",
        SwitchOperand::Nothing,
        AllowingPowerShells::Both,
    ),
    powershell_switch(
        "sta",
        "sta",
        SwitchOperand::Nothing,
        AllowingPowerShells::Both,
    ),
    powershell_switch(
        "noninteractive",
        "noni",
        SwitchOperand::Nothing,
        AllowingPowerShells::Both,
    ),
    powershell_switch(
        "noprofileloadtime",
        "noprofileloadtime",
        SwitchOperand::Nothing,
        AllowingPowerShells::PwshOnly,
    ),
    // pwsh reads it with no operand and stops reading; Windows PowerShell takes the version to
    // start. Only its whole name is matched, since no source shows Windows PowerShell taking less.
    powershell_switch(
        "version",
        "version",
        SwitchOperand::One,
        AllowingPowerShells::Both,
    ),
    powershell_switch(
        "executionpolicy",
        "ex",
        SwitchOperand::One,
        AllowingPowerShells::Both,
    ),
    powershell_switch("ep", "ep", SwitchOperand::One, AllowingPowerShells::Both),
    powershell_switch(
        "windowstyle",
        "w",
        SwitchOperand::One,
        AllowingPowerShells::Both,
    ),
    powershell_switch(
        "file",
        "f",
        SwitchOperand::Script,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "command",
        "c",
        SwitchOperand::Command,
        AllowingPowerShells::Both,
    ),
    powershell_switch(
        "commandwithargs",
        "commandwithargs",
        SwitchOperand::Command,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "cwa",
        "cwa",
        SwitchOperand::Command,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "encodedcommand",
        "e",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch("ec", "e", SwitchOperand::One, AllowingPowerShells::PwshOnly),
    powershell_switch(
        "encodedarguments",
        "encodeda",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "ea",
        "ea",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "workingdirectory",
        "wo",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "wd",
        "wd",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "configurationname",
        "config",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "configurationfile",
        "configurationfile",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "custompipename",
        "cus",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "settingsfile",
        "settings",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "inputformat",
        "inp",
        SwitchOperand::One,
        AllowingPowerShells::Both,
    ),
    powershell_switch("if", "if", SwitchOperand::One, AllowingPowerShells::Both),
    powershell_switch(
        "outputformat",
        "o",
        SwitchOperand::One,
        AllowingPowerShells::Both,
    ),
    powershell_switch("of", "o", SwitchOperand::One, AllowingPowerShells::Both),
    powershell_switch(
        "token",
        "to",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
    powershell_switch(
        "utctimestamp",
        "utc",
        SwitchOperand::One,
        AllowingPowerShells::PwshOnly,
    ),
];

/// How `program` with `arguments` starts in `folder`: `system_folder` is the folder the `shell`
/// mode spawns in, and PowerShell, `wsl.exe` and `cmd.exe` on a share (which it refuses as its
/// start folder) start there too and are told the folder by their own means; every other shell
/// starts in `folder`.
pub(crate) fn compose_shell_folder_start(
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
        // Its switch runs before the profile scripts, as a `Set-Location`, so the process's own
        // folder stays the system folder. A script, which pwsh resolves against its process folder,
        // starts in the folder with the user's arguments, as every terminal starts it.
        "pwsh" if can_pwsh_take_folder_switch(arguments) => told_by_switch(vec![
            "-NoLogo".to_owned(),
            "-WorkingDirectory".to_owned(),
            strip_trailing_separators(folder).to_owned(),
        ]),
        // It has no folder switch, so a `Set-Location` moves it: in front of the user's own
        // command, or as a start command after their arguments; any argument not known to leave
        // room for it starts the shell in the folder with the user's arguments, as every terminal
        // starts it.
        "powershell" => match windows_powershell_folder_arguments(arguments, folder) {
            Some(arguments) => start(arguments, system_folder.to_path_buf()),
            None => in_folder(),
        },
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

// Whether pwsh can take `-WorkingDirectory` ahead of the user's arguments, read as pwsh reads its
// command line: always, unless they run a script by a relative path, given by a `-File` form or as
// a bare word, which pwsh resolves against its process folder.
fn can_pwsh_take_folder_switch(arguments: &[String]) -> bool {
    let mut arguments = arguments.iter();
    while let Some(argument) = arguments.next() {
        let Some(key) = powershell_switch_key(argument) else {
            return is_resolved_without_folder(argument);
        };
        match find_powershell_switch(key).map(|switch| switch.operand) {
            Some(SwitchOperand::Script) => {
                return arguments
                    .next()
                    .is_none_or(|script| is_resolved_without_folder(script));
            }
            Some(SwitchOperand::Command) => return true,
            Some(SwitchOperand::One) => {
                arguments.next();
            }
            Some(SwitchOperand::Nothing) | None => {}
        }
    }
    true
}

// Whether pwsh reads the script `script` names without its process folder: `-`, standard input,
// or a path naming one complete location.
fn is_resolved_without_folder(script: &str) -> bool {
    script == "-" || PathRules::Windows.names_complete_location(script)
}

// Windows PowerShell's arguments that move it to `folder`, `None` where an argument leaves no room:
// every user argument before its command must be a switch it takes the folder start beside, with
// its value. A command given as text, after `-Command` or as a bare word, gets the `Set-Location`
// in front of its first value, unless the command must open the script; with no command the
// `Set-Location` follows the arguments as its start command.
fn windows_powershell_folder_arguments(arguments: &[String], folder: &str) -> Option<Vec<String>> {
    let set_location = format!(
        "Set-Location -LiteralPath {}",
        quote_powershell_literal(folder)
    );
    // Windows PowerShell joins every argument from the command's first value on into one command.
    let put_before_command = |first: usize| {
        if must_open_the_script(&arguments[first..].join(" ")) {
            return None;
        }
        let mut started = arguments.to_vec();
        started[first] = format!("{set_location}; {}", arguments[first]);
        Some(started)
    };
    let mut index = 0;
    while let Some(argument) = arguments.get(index) {
        let Some(key) = powershell_switch_key(argument) else {
            // A bare word begins the command; an empty argument is refused.
            if argument.trim().is_empty() {
                return None;
            }
            return put_before_command(index);
        };
        let switch = find_powershell_switch(key)?;
        if switch.allowed_by != AllowingPowerShells::Both {
            return None;
        }
        match switch.operand {
            SwitchOperand::Nothing => index += 1,
            SwitchOperand::One => {
                arguments.get(index + 1)?;
                index += 2;
            }
            // `-` reads the commands from standard input, which no text can go in front of.
            SwitchOperand::Command => {
                arguments.get(index + 1).filter(|command| *command != "-")?;
                return put_before_command(index + 1);
            }
            SwitchOperand::Script => return None,
        }
    }
    Some(
        arguments
            .iter()
            .cloned()
            .chain([
                "-NoLogo".to_owned(),
                "-NoExit".to_owned(),
                "-Command".to_owned(),
                set_location,
            ])
            .collect(),
    )
}

// Whether `command` opens with what PowerShell takes only at a script's start (`using`, `param`,
// an attribute's `[`, or a comment, which `#requires` is), compared without case, so no statement
// can go in front of it.
fn must_open_the_script(command: &str) -> bool {
    let command = command.trim_start();
    ["using", "param", "[", "#", "<#"].iter().any(|opener| {
        command
            .get(..opener.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(opener))
    })
}

// The name an argument gives after its switch character (`/`, a dash, or a dash doubled), trimmed
// as PowerShell trims it; `None` for an empty argument or a bare word.
fn powershell_switch_key(argument: &str) -> Option<&str> {
    let mut characters = argument.trim().chars();
    let first = characters.next()?;
    let rest = characters.as_str();
    if first == '/' {
        Some(rest)
    } else if POWERSHELL_DASHES.contains(&first) {
        Some(rest.strip_prefix(first).unwrap_or(rest))
    } else {
        None
    }
}

// The switch `key` names: a prefix of its name, no shorter than its shortest spelling, compared
// without case.
fn find_powershell_switch(key: &str) -> Option<&'static PowerShellSwitch> {
    let length = key.chars().count();
    POWERSHELL_SWITCHES.iter().find(|switch| {
        (switch.shortest.len()..=switch.name.len()).contains(&length)
            && key
                .chars()
                .zip(switch.name.chars())
                .all(|(typed, named)| typed.to_uppercase().eq(named.to_uppercase()))
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

// `text` as a PowerShell single-quoted string: every character PowerShell reads as a single quote
// doubled, so none ends the string.
fn quote_powershell_literal(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('\'');
    for character in text.chars() {
        if POWERSHELL_SINGLE_QUOTES.contains(&character) {
            quoted.push(character);
        }
        quoted.push(character);
    }
    quoted.push('\'');
    quoted
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rstest::rstest;

    use super::compose_shell_folder_start;
    use crate::shell_folder_start::ShellFolderStart;

    const SYSTEM_FOLDER: &str = r"C:\Windows\System32";

    // Fails when PowerShell starts in the worktree, which it holds for its life; a trailing `\` is
    // kept, which breaks pwsh's quoted switch; a switch's value is read as pwsh's script, or a
    // relative script given by a prefix, another switch character or a bare path starts in the
    // system folder; a complete script path or standard input's `-` drops pwsh's folder switch, as
    // a user command would; a folder quote other than `'` is left single, which ends the string
    // and runs the rest of the name; Windows PowerShell gets its folder statement beside an
    // argument not known to leave it free, a switch only pwsh has (`-cwa` among them) or a switch
    // missing its value, or loses it beside one of its own format, version or quiet switches; the
    // statement goes anywhere but in front of the command's first value, in front of standard
    // input's `-`, or in front of a command opening with `using`, `param`, `[`, `#` or `<#`; a bare
    // word is not read as the command; cmd started on a share starts in the Windows folder, and a
    // share path with `&` or `%` left bare runs a command; a horizontal bar is not read as a dash;
    // a drive root is quoted without its `\`; MSYS bash without its variable opens in the home
    // folder, and WSL's launcher given it goes through the MSYS arm; or `--cd` is added over the
    // user's own `~`.
    #[rstest]
    #[case::pwsh_with_a_trailing_separator(
        r"C:\Program Files\PowerShell\7\pwsh.exe",
        &["-Login", "-ep", "Bypass"],
        r"C:\wt\it's\",
        &["-NoLogo", "-WorkingDirectory", r"C:\wt\it's", "-Login", "-ep", "Bypass"],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::pwsh_with_the_user_s_command(
        "pwsh",
        &["-COMMAND", "Get-Date"],
        r"C:\wt",
        &["-NoLogo", "-WorkingDirectory", r"C:\wt", "-COMMAND", "Get-Date"],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::pwsh_as_the_developer_shell(
        "pwsh.exe",
        &["-NoExit", "-Command", r#"&{Import-Module "C:\VS\DevShell.dll"; Enter-VsDevShell 1a2b}"#],
        r"C:\wt",
        &[
            "-NoLogo",
            "-WorkingDirectory",
            r"C:\wt",
            "-NoExit",
            "-Command",
            r#"&{Import-Module "C:\VS\DevShell.dll"; Enter-VsDevShell 1a2b}"#,
        ],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::pwsh_with_the_user_s_script_by_a_prefix(
        "pwsh",
        &["-WindowStyle", "Hidden", "\u{2013}FI", "start.ps1"],
        r"C:\wt",
        &["-WindowStyle", "Hidden", "\u{2013}FI", "start.ps1"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::pwsh_with_the_user_s_bare_script(
        "pwsh",
        &["/nop", "start.ps1"],
        r"C:\wt",
        &["/nop", "start.ps1"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::pwsh_with_the_user_s_script_by_its_complete_path(
        "pwsh",
        &["-File", r"D:\scripts\start.ps1"],
        r"C:\wt",
        &["-NoLogo", "-WorkingDirectory", r"C:\wt", "-File", r"D:\scripts\start.ps1"],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::pwsh_reading_its_script_from_standard_input(
        "pwsh",
        &["-nop", "-f", "-"],
        r"C:\wt",
        &["-NoLogo", "-WorkingDirectory", r"C:\wt", "-nop", "-f", "-"],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::windows_powershell_on_a_folder_named_to_break_its_quotes(
        "POWERSHELL.EXE",
        &["/nop", "--ExecutionPolicy", "Bypass", "\u{2014}noe"],
        "C:\\wt\\it's \u{2018}\u{201A}\u{201B}\\a\u{2019};calc;\u{2019}",
        &[
            "/nop",
            "--ExecutionPolicy",
            "Bypass",
            "\u{2014}noe",
            "-NoLogo",
            "-NoExit",
            "-Command",
            "Set-Location -LiteralPath \
             'C:\\wt\\it''s \u{2018}\u{2018}\u{201A}\u{201A}\u{201B}\u{201B}\\a\u{2019}\u{2019};calc;\u{2019}\u{2019}'",
        ],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::windows_powershell_as_the_developer_shell_on_a_folder_named_to_break_its_quotes(
        "powershell.exe",
        &["-NoExit", "-Command", r#"&{Import-Module "C:\VS\DevShell.dll"; Enter-VsDevShell 1a2b}"#],
        "C:\\wt\\it's \u{2018}\u{201A}\u{201B}\\a\u{2019};calc;\u{2019}",
        &[
            "-NoExit",
            "-Command",
            "Set-Location -LiteralPath \
             'C:\\wt\\it''s \u{2018}\u{2018}\u{201A}\u{201A}\u{201B}\u{201B}\\a\u{2019}\u{2019};calc;\u{2019}\u{2019}'; \
             &{Import-Module \"C:\\VS\\DevShell.dll\"; Enter-VsDevShell 1a2b}",
        ],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::windows_powershell_with_a_bare_command(
        "powershell.exe",
        &["-nop", "Get-Date"],
        r"C:\wt",
        &["-nop", r"Set-Location -LiteralPath 'C:\wt'; Get-Date"],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::windows_powershell_with_a_command_opening_with_using(
        "powershell.exe",
        &["-NoExit", "-Command", "USING namespace System.Text; [StringBuilder]::new()"],
        r"C:\wt",
        &["-NoExit", "-Command", "USING namespace System.Text; [StringBuilder]::new()"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::windows_powershell_with_a_command_opening_with_param(
        "powershell.exe",
        &["-Command", "  Param($x) $x"],
        r"C:\wt",
        &["-Command", "  Param($x) $x"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::windows_powershell_with_a_command_opening_with_an_attribute(
        "powershell.exe",
        &["-Command", "[CmdletBinding()] param()"],
        r"C:\wt",
        &["-Command", "[CmdletBinding()] param()"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::windows_powershell_with_a_command_opening_with_a_comment(
        "powershell.exe",
        &["-Command", "#Requires -Version 5.1", "Get-Date"],
        r"C:\wt",
        &["-Command", "#Requires -Version 5.1", "Get-Date"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::windows_powershell_with_a_command_opening_with_a_block_comment(
        "powershell.exe",
        &["-Command", "<# a note #> Get-Date"],
        r"C:\wt",
        &["-Command", "<# a note #> Get-Date"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::windows_powershell_with_a_command_of_several_arguments(
        "powershell.exe",
        &["-NonInteractive", "-Version", "2.0", "-NoExit", "-Command", "Get-ChildItem", "-Force"],
        r"C:\wt",
        &[
            "-NonInteractive",
            "-Version",
            "2.0",
            "-NoExit",
            "-Command",
            r"Set-Location -LiteralPath 'C:\wt'; Get-ChildItem",
            "-Force",
        ],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::windows_powershell_with_pwsh_s_command_with_arguments(
        "powershell.exe",
        &["-nop", "-cwa", "Get-Date"],
        r"C:\wt",
        &["-nop", "-cwa", "Get-Date"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::windows_powershell_reading_its_commands_from_standard_input(
        "powershell.exe",
        &["-nop", "-Command", "-"],
        r"C:\wt",
        &["-nop", "-Command", "-"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::windows_powershell_with_a_switch_missing_its_value(
        "powershell",
        &["-nol", "-WindowStyle"],
        r"C:\wt",
        &["-nol", "-WindowStyle"],
        r"C:\wt",
        &[],
        None
    )]
    #[case::windows_powershell_with_a_horizontal_bar_before_a_switch(
        "powershell",
        &["\u{2015}NoProfile"],
        r"C:\wt",
        &[
            "\u{2015}NoProfile",
            "-NoLogo",
            "-NoExit",
            "-Command",
            r"Set-Location -LiteralPath 'C:\wt'",
        ],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::windows_powershell_on_a_drive_root(
        "powershell.exe",
        &[],
        r"C:\",
        &["-NoLogo", "-NoExit", "-Command", r"Set-Location -LiteralPath 'C:\'"],
        SYSTEM_FOLDER,
        &[],
        None
    )]
    #[case::windows_powershell_with_a_switch_only_pwsh_has(
        "powershell.exe",
        &["-Login", "-WindowStyle", "a'b"],
        r"C:\wt",
        &["-Login", "-WindowStyle", "a'b"],
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
