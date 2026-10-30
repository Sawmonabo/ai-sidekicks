//! How a shell starts in its folder on Windows, by the shell's program, composed on every host.
//! Windows keeps a handle on a process's current folder; the console host keeps the daemon's, and
//! the `shell` mode, spawned in the system folder, keeps that one for its whole wait. A shell keeps
//! the folder it starts in until it moves its own: cmd, Nushell and every other shell move it on
//! `cd`, and the MSYS bash shares it for removal, so they start in the folder, as every terminal
//! starts them. Only PowerShell never lets go of the folder it started in, so where its arguments
//! leave room it starts in the system folder and is told its folder by a switch or a command; WSL
//! is told its folder by its `--cd` switch.

use std::path::{Path, PathBuf};

use crate::path::rules::PathRules;
use crate::path::rules::windows::command_line::{COMMAND_LINE_UNITS, compose_command_line};
use crate::powershell_literal::quote_powershell_literal;
use crate::shell_folder_start::ShellFolderStart;

/// The variable that keeps an MSYS bash login in the folder it starts in, not the home folder.
const STAY_IN_FOLDER_ENVIRONMENT_NAME: &str = "CHERE_INVOKING";

/// The characters PowerShell reads as a dash before a switch's name.
const POWERSHELL_DASHES: [char; 4] = ['-', '\u{2013}', '\u{2014}', '\u{2015}'];

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

/// Which PowerShell reads a command line.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PowerShell {
    /// PowerShell 7, `pwsh.exe`.
    Pwsh,
    /// Windows PowerShell 5.1, `powershell.exe`.
    WindowsPowerShell,
}

/// A switch PowerShell reads at start: its name, the shortest prefix of it each PowerShell takes
/// (`None` where that PowerShell has no such switch), what follows it, and which PowerShell takes
/// its folder start beside it. pwsh takes it beside every switch but a script's, which its operand
/// decides.
struct PowerShellSwitch {
    name: &'static str,
    pwsh_shortest: Option<&'static str>,
    windows_powershell_shortest: Option<&'static str>,
    operand: SwitchOperand,
    allowed_by: AllowingPowerShells,
}

impl PowerShellSwitch {
    // The shortest prefix `powershell` takes, `None` where it has no such switch.
    fn shortest(&self, powershell: PowerShell) -> Option<&'static str> {
        match powershell {
            PowerShell::Pwsh => self.pwsh_shortest,
            PowerShell::WindowsPowerShell => self.windows_powershell_shortest,
        }
    }
}

// A switch both PowerShells take from the same shortest prefix.
const fn powershell_switch(
    name: &'static str,
    shortest: &'static str,
    operand: SwitchOperand,
    allowed_by: AllowingPowerShells,
) -> PowerShellSwitch {
    PowerShellSwitch {
        name,
        pwsh_shortest: Some(shortest),
        windows_powershell_shortest: Some(shortest),
        operand,
        allowed_by,
    }
}

/// The switches whose operand or effect decides the folder start, each at the shortest spelling
/// each PowerShell takes. No spelling names two switches of one PowerShell, so the first match is
/// that PowerShell's reading. A switch missing here is one pwsh reads with no operand, or one it
/// does not know, which it reads as a script path and then fails to start on; beside a switch
/// missing here, Windows PowerShell's folder start is refused.
const POWERSHELL_SWITCHES: [PowerShellSwitch; 33] = [
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
    // pwsh reads it with no operand and stops reading; Windows PowerShell's native entry reads its
    // own `-Version` only at the line's front, apart from this table.
    powershell_switch(
        "version",
        "v",
        SwitchOperand::Nothing,
        AllowingPowerShells::PwshOnly,
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
    // Windows PowerShell's folder start is refused beside it, since it fills the command's `$args`.
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
        AllowingPowerShells::Both,
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
    // pwsh reads `-i` and `-in` as `-Interactive`, Windows PowerShell as `-InputFormat`.
    PowerShellSwitch {
        name: "interactive",
        pwsh_shortest: Some("i"),
        windows_powershell_shortest: None,
        operand: SwitchOperand::Nothing,
        allowed_by: AllowingPowerShells::PwshOnly,
    },
    PowerShellSwitch {
        name: "inputformat",
        pwsh_shortest: Some("inp"),
        windows_powershell_shortest: Some("i"),
        operand: SwitchOperand::One,
        allowed_by: AllowingPowerShells::Both,
    },
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

/// How `program` with `arguments` starts in `folder`, `system_folder` being the folder the `shell`
/// mode spawns in: Windows locks a process's current folder while it runs, and PowerShell never
/// moves its process folder on `Set-Location`, so it, `wsl.exe` and `cmd.exe` on a share (which it
/// refuses as its start folder) start in the system folder and are told the folder by their own
/// means, while every other shell starts in `folder` and its lock moves with its own `cd`. A shell
/// whose own means would pass Windows' command line starts in `folder` too.
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
    let folder_start = match program_name(program).as_str() {
        // Its switch runs before the profile scripts, as a `Set-Location`, so the process's own
        // folder stays the system folder. A script, which pwsh resolves against its process folder,
        // starts in the folder with the user's arguments, as every terminal starts it.
        "pwsh" if can_pwsh_take_folder_switch(arguments) => told_by_switch(vec![
            "-NoLogo".to_owned(),
            "-WorkingDirectory".to_owned(),
            strip_trailing_separators(folder).to_owned(),
        ]),
        // It has no folder switch, so a `Set-Location` moves it: in front of the user's own
        // command, which `Invoke-Expression` runs, or as a start command after their arguments;
        // any argument not known to leave room for it starts the shell in the folder with the
        // user's arguments, as every terminal starts it.
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
    };
    if fits_command_line(&folder_start) {
        folder_start
    } else {
        in_folder()
    }
}

// Whether `start`'s program, arguments and raw tail, as the `shell` mode hands them to Windows (the
// tail after one space, exactly as given), fit one command line.
fn fits_command_line(start: &ShellFolderStart) -> bool {
    let line = compose_command_line(start.program.encode_utf16(), &start.arguments);
    let tail_units = start
        .raw_command_tail
        .as_ref()
        .map_or(0, |tail| 1 + tail.encode_utf16().count());
    line.len() + tail_units <= COMMAND_LINE_UNITS
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
        match find_powershell_switch(key, PowerShell::Pwsh).map(|switch| switch.operand) {
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
// its value, `-Version` and `-PSConsoleFile` only at the front. A command given as text, after
// `-Command` or as a bare word, becomes one argument, the `Set-Location` in front of an
// `Invoke-Expression` of the text, or the `Set-Location` alone where the text is blank; with no
// command the `Set-Location` follows the arguments as its start command. Both cmdlets are named
// with their modules, so a profile's alias or function of the same name cannot take the call.
fn windows_powershell_folder_arguments(arguments: &[String], folder: &str) -> Option<Vec<String>> {
    let set_location = format!(
        "Microsoft.PowerShell.Management\\Set-Location -LiteralPath {}",
        quote_powershell_literal(folder)
    );
    // Windows PowerShell joins every argument from the command's first value on into one command,
    // with one space between. `Invoke-Expression` parses the joined text as a script of its own,
    // so it may open with `using` or a param block, and runs it in the session's scope; the text
    // is a quoted literal, so nothing in it can end the statement around it. It refuses an empty
    // text, where a plain `-Command` runs nothing, so a blank text is left out.
    let put_before_command = |first: usize| {
        let mut started = arguments[..first].to_vec();
        let text = arguments[first..].join(" ");
        // `trim()` removes the Unicode `White_Space` set, the characters PowerShell's tokenizer
        // skips as whitespace and line ends, so a text of only those runs nothing on both sides.
        started.push(if text.trim().is_empty() {
            set_location.clone()
        } else {
            format!(
                "{set_location}; Microsoft.PowerShell.Utility\\Invoke-Expression {}",
                quote_powershell_literal(&text)
            )
        });
        started
    };
    let mut index = windows_powershell_native_front_end(arguments)?;
    while let Some(argument) = arguments.get(index) {
        let Some(key) = powershell_switch_key(argument) else {
            // A bare word begins the command; an empty or whitespace argument is refused.
            if argument.trim().is_empty() {
                return None;
            }
            return Some(put_before_command(index));
        };
        let switch = find_powershell_switch(key, PowerShell::WindowsPowerShell)?;
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
                return Some(put_before_command(index + 1));
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

// Where the switches Windows PowerShell's native entry reads at the line's front end, `None` when
// one of them lacks its value: `-Version <n>` at the first argument, then `-PSConsoleFile <file>`
// at the next; or `-PSConsoleFile <file>` at the first. The entry also reads `-ServerMode` and
// `-RuntimeVersion` there, which the managed table does not take, so beside them the folder start
// is refused.
fn windows_powershell_native_front_end(arguments: &[String]) -> Option<usize> {
    let mut index = 0;
    for name in ["version", "psconsolefile"] {
        if arguments
            .get(index)
            .is_some_and(|argument| is_native_switch(argument, name))
        {
            arguments.get(index + 1)?;
            index += 2;
        }
    }
    Some(index)
}

// Whether `argument` names the switch `name` as Windows PowerShell's native entry reads it: one
// dash, then a prefix of the name from its first letter, compared without case. The compare folds
// ASCII case only, where the entry folds case by the invariant locale, so a spelling the two read
// apart is refused, which leaves the shell in its folder: the safe direction.
fn is_native_switch(argument: &str, name: &str) -> bool {
    let mut characters = argument.chars();
    let rest = match characters.next() {
        Some(first) if POWERSHELL_DASHES.contains(&first) => characters.as_str(),
        _ => return false,
    };
    !rest.is_empty()
        && name
            .get(..rest.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(rest))
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

// The switch `key` names to `powershell`: a prefix of its name, no shorter than the shortest
// spelling that PowerShell takes, compared without case.
fn find_powershell_switch(key: &str, powershell: PowerShell) -> Option<&'static PowerShellSwitch> {
    let length = key.chars().count();
    POWERSHELL_SWITCHES.iter().find(|switch| {
        switch
            .shortest(powershell)
            .is_some_and(|shortest| (shortest.len()..=switch.name.len()).contains(&length))
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

#[cfg(test)]
mod tests;
