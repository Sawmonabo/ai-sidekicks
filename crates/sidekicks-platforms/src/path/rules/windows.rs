//! How Windows spells paths: `\` or `/` between components, a drive or share as the root, names
//! compared without case as NTFS compares them, and a program's line ended by `\r\n`; and how
//! `cmd.exe` reads a word on its `/c` line.

use std::iter;

use typed_path::{Utf8WindowsPath, Utf8WindowsPrefix};

use super::{FolderCommand, ShellWordRefused};

/// The separator Windows writes between a path's components.
pub(super) const SEPARATOR: char = '\\';

/// Whether `character` separates components; Windows reads `/` as `\`.
pub(super) fn is_separator(character: char) -> bool {
    character == SEPARATOR || character == '/'
}

/// Whether `path` is rooted, by Windows' own reading: `\repos`, `C:\repos` and `\\server\share`
/// are, `C:repos` is not.
pub(super) fn is_absolute(path: &str) -> bool {
    Utf8WindowsPath::new(path).has_root()
}

/// Whether `path` names one location with no help from the program's current drive: it has a
/// volume (a drive, a share or a device) and a root under it.
pub(super) fn names_complete_location(path: &str) -> bool {
    let path = Utf8WindowsPath::new(path);
    path.components().has_prefix() && path.has_root()
}

/// The drive letter `path` starts with, upper-cased (`c:\x` gives `C`), or `None` when it starts
/// with no drive.
pub(super) fn drive_of(path: &str) -> Option<char> {
    match Utf8WindowsPath::new(path).components().prefix_kind()? {
        Utf8WindowsPrefix::Disk(letter) => Some(letter),
        Utf8WindowsPrefix::Verbatim(_)
        | Utf8WindowsPrefix::VerbatimUNC(..)
        | Utf8WindowsPrefix::VerbatimDisk(_)
        | Utf8WindowsPrefix::DeviceNS(_)
        | Utf8WindowsPrefix::UNC(..) => None,
    }
}

/// Whether `path` is a drive alone (`C:`, two bytes) naming the drive `base` starts with.
pub(super) fn is_drive_of(path: &str, base: &str) -> bool {
    path.len() == 2 && drive_of(path).is_some_and(|letter| drive_of(base) == Some(letter))
}

/// `path` joined onto `base`. A drive-relative `path` (`D:foo`) takes its own drive, then `base`
/// without its drive, then the rest of itself, so on the same drive it joins onto `base`; a bare
/// drive (`D:`) is that drive's root.
pub(super) fn join(base: &str, path: &str) -> String {
    let components = Utf8WindowsPath::new(path).components();
    let Some(Utf8WindowsPrefix::Disk(_)) = components
        .prefix_kind()
        .filter(|_| !components.has_physical_root())
    else {
        return Utf8WindowsPath::new(base).join(path).into_string();
    };
    // A disk prefix is an ASCII letter and a colon, two bytes.
    let (drive, rest) = path.split_at(2);
    if rest.is_empty() {
        return format!("{drive}\\");
    }
    let base_prefix_len = Utf8WindowsPath::new(base)
        .components()
        .prefix()
        .map_or(0, |prefix| prefix.len());
    let anchor = format!("{drive}{}", &base[base_prefix_len..]);
    Utf8WindowsPath::new(&anchor).join(rest).into_string()
}

/// `word` written for a `cmd.exe /c` line whose program reads it by the C runtime's argument rules,
/// as std quotes a batch file's argument: double-quoted, a `"` doubled with the backslashes before
/// it doubled, the backslashes before the closing quote doubled, and each `%` written `%%cd:~,%`,
/// an empty substring of the always-set `cd` variable, so cmd expands no `%NAME%` (it needs the
/// command extensions `/e:on` turns on). Inside quotes that stay paired, `^ & | < >` are literal,
/// and `!` is under `/v:off`. Refuses a `\r` or `\n`, where cmd ends the line.
pub(super) fn quote_shell_word(word: &str) -> Result<String, ShellWordRefused> {
    if word.contains(['\r', '\n']) {
        return Err(ShellWordRefused);
    }
    let mut quoted = String::with_capacity(word.len() + 2);
    quoted.push('"');
    let mut backslashes = 0;
    for character in word.chars() {
        if character == '\\' {
            backslashes += 1;
        } else {
            if character == '"' {
                quoted.extend(iter::repeat_n('\\', backslashes));
                quoted.push('"');
            } else if character == '%' {
                quoted.push_str("%%cd:~,");
            }
            backslashes = 0;
        }
        quoted.push(character);
    }
    quoted.extend(iter::repeat_n('\\', backslashes));
    quoted.push('"');
    Ok(quoted)
}

/// `cmd.exe /d /s /v:off /e:on /c "cd /d <folder> && <program> <arguments…>"`: `/d` skips
/// `AutoRun`, `/s` strips exactly the outer pair of quotes, `/v:off` keeps `!` literal, `/e:on`
/// turns on the extensions the `%` escape needs, `/c` comes last and `cd /d` changes the drive too.
pub(super) fn run_in_folder(
    folder: &str,
    program: &str,
    arguments: &[String],
) -> Result<FolderCommand, ShellWordRefused> {
    let mut line = format!(
        "\"cd /d {} && {}",
        quote_shell_word(folder)?,
        quote_shell_word(program)?
    );
    for argument in arguments {
        line.push(' ');
        line.push_str(&quote_shell_word(argument)?);
    }
    line.push('"');
    let mut command_arguments: Vec<String> = ["/d", "/s", "/v:off", "/e:on", "/c"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    command_arguments.push(line);
    Ok(FolderCommand {
        program: "cmd.exe",
        arguments: command_arguments,
    })
}
