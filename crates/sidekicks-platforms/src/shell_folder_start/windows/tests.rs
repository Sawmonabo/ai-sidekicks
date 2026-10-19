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

    let start =
        compose_shell_folder_start(program, &owned(arguments), folder, Path::new(SYSTEM_FOLDER));

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
