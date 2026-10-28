//! What Linux alone supplies: the machine's pretty host name, inside a WSL distribution the folders
//! the Windows drives are mounted at, reads at an offset rather than through a memory map, a
//! process's files under `/proc` and the fields of its stat file, a local connection's caller
//! pinned, the bound on a program's argument, a process's memory and the machine's available
//! memory, one user's processes and the arguments and environment a process started with, an open
//! descriptor's path, the wakes of a folder's and a file's watch, whether a terminal's program
//! waits for input, the daemon's process containment and its shell start's writer check, a session
//! child's start, whether the machine runs on AC power, the machine's wakes from sleep, a
//! wall-clock timer and the shells the live test opens on a folder.

pub(crate) mod caller_process;
pub(crate) mod descriptor_path;
pub(crate) mod input_wait;
pub(crate) mod memory;
pub(crate) mod pinned_process;
pub(crate) mod power_source;
pub(crate) mod process_containment;
pub(crate) mod process_start;
pub(crate) mod processes;
pub(crate) mod session_child;
pub(crate) mod shell_start_confirmation;
pub(crate) mod user_namespace;
pub(crate) mod user_scope;
pub(crate) mod wake_watch;
pub(crate) mod wall_clock_timer;
pub(crate) mod watch;

use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;

use crate::machine_name::{MachineNameError, require_machine_name};
use crate::posix::memory::page_bytes;
#[cfg(any(test, feature = "test-support"))]
use crate::posix::shell_folder_start::BASH_SHELL_FOLDER_PROBE;
#[cfg(any(test, feature = "test-support"))]
use crate::shell_folder_start::ShellFolderProbe;
use crate::spawner::Spawner;

// The environment-style file systemd keeps the pretty host name in.
const MACHINE_INFO_PATH: &str = "/etc/machine-info";

// What the fallback name is read from.
const HOST_NAME_SOURCE: &str = "gethostname";

// The key of the pretty host name in the machine-info file.
const PRETTY_HOSTNAME_KEY: &str = "PRETTY_HOSTNAME=";

// The kernel's release, which names Microsoft on WSL's own kernels.
const KERNEL_RELEASE_PATH: &str = "/proc/sys/kernel/osrelease";

// The mount table, one mount per line.
const MOUNT_TABLE_PATH: &str = "/proc/self/mounts";

// The first field of a process's stat file after its name, which proc(5) numbers 3.
const FIRST_FIELD_AFTER_NAME: usize = 3;

// The pages one argument string, its NUL included, may fill (`MAX_ARG_STRLEN`, execve(2)).
const ARGUMENT_PAGES: usize = 32;

/// The machine's pretty host name, from `PRETTY_HOSTNAME` in `/etc/machine-info`, or, when the file
/// or the value is missing or empty, its host name. Fails with [`MachineNameError::Read`] when the
/// file exists but cannot be read or the host name cannot be, and with
/// [`MachineNameError::Empty`] when the host name is empty.
pub async fn machine_name(_spawner: &Spawner) -> Result<String, MachineNameError> {
    // Read as bytes, so a file that is not UTF-8 reads lossily as the host name does.
    let pretty_hostname = match tokio::fs::read(MACHINE_INFO_PATH).await {
        Ok(machine_info) => pretty_hostname_in(&String::from_utf8_lossy(&machine_info)),
        Err(failure) if failure.kind() == ErrorKind::NotFound => None,
        Err(source) => {
            return Err(MachineNameError::Read {
                source_name: MACHINE_INFO_PATH,
                source,
            });
        }
    };
    if let Some(name) = pretty_hostname.filter(|name| !name.is_empty()) {
        return Ok(name);
    }
    let host_name = nix::unistd::gethostname().map_err(|errno| MachineNameError::Read {
        source_name: HOST_NAME_SOURCE,
        source: errno.into(),
    })?;
    require_machine_name(host_name.to_string_lossy().into_owned(), HOST_NAME_SOURCE)
}

/// The folders the Windows drives are mounted at inside a WSL distribution, where a Windows
/// program found under them fails, read from the kernel release and the mount table; empty outside
/// one. Fails with the system's error when either file cannot be read.
pub fn windows_drive_mounts() -> io::Result<Vec<PathBuf>> {
    // Read as bytes, since a mount point need not be UTF-8.
    let kernel_release = std::fs::read(KERNEL_RELEASE_PATH)?;
    let mount_table = std::fs::read(MOUNT_TABLE_PATH)?;
    Ok(drive_mounts_in(&kernel_release, &mount_table))
}

/// Whether a reader that keeps a file open reads it through a memory map rather than by reads at
/// an offset: no, since only macOS's footprint measures a mapped file smaller.
pub const SHOULD_MEMORY_MAP_READS: bool = false;

/// A bound in bytes that no single argument a program can start with reaches: 32 pages, the
/// kernel's limit on one argument string, which counts its NUL. Fails with the system's error when
/// the page size cannot be read, and with `Other` when the system reports none or the bound passes
/// `usize`.
pub fn read_command_argument_limit() -> io::Result<usize> {
    usize::try_from(page_bytes()?)
        .map_err(io::Error::other)?
        .checked_mul(ARGUMENT_PAGES)
        .ok_or_else(|| io::Error::other("32 pages pass the largest size"))
}

/// Fields `fields` of `/proc/<process_id>/stat`, in their order, numbered from 1 as proc(5)
/// numbers them and counted after the last `)`, since the name before it may hold spaces and
/// parentheses; `None` when no process has the id, its file gone before the open or ending during
/// the read (`ESRCH`). Fails with `InvalidInput` for a field before the third, `InvalidData` when
/// the file lacks a field, and with the read's error otherwise.
pub(crate) fn read_process_stat_fields<const COUNT: usize>(
    process_id: u32,
    fields: [usize; COUNT],
) -> io::Result<Option<[String; COUNT]>> {
    let Some(stat) = read_process_file(process_id, "stat")? else {
        return Ok(None);
    };
    let missing = |what: String| {
        io::Error::new(
            ErrorKind::InvalidData,
            format!("/proc/{process_id}/stat has no {what}"),
        )
    };
    let name_end = stat
        .iter()
        .rposition(|byte| *byte == b')')
        .ok_or_else(|| missing("name's end".to_owned()))?;
    let values: Vec<&[u8]> = stat[name_end + 1..]
        .split(u8::is_ascii_whitespace)
        .filter(|value| !value.is_empty())
        .collect();
    let read = fields
        .iter()
        .map(|&field| {
            let index = field.checked_sub(FIRST_FIELD_AFTER_NAME).ok_or_else(|| {
                io::Error::new(
                    ErrorKind::InvalidInput,
                    format!("field {field} of a stat file comes before the name's end"),
                )
            })?;
            let value = values
                .get(index)
                .ok_or_else(|| missing(format!("field {field}")))?;
            String::from_utf8(value.to_vec())
                .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
        })
        .collect::<io::Result<Vec<String>>>()?;
    Ok(Some(
        read.try_into()
            .expect("one value is read for each field asked"),
    ))
}

/// The bytes of `/proc/<process_id>/<file>`; `None` when no process has the id, its folder gone
/// before the open or the process ending during the read (`ESRCH`). Fails with the read's error
/// otherwise.
pub(crate) fn read_process_file(process_id: u32, file: &str) -> io::Result<Option<Vec<u8>>> {
    match std::fs::read(format!("/proc/{process_id}/{file}")) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if is_gone(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Whether `error` is a read under `/proc` of a process or thread that ended: its folder gone
/// before the open, or the process ending during the read (`ESRCH`).
pub(crate) fn is_gone(error: &io::Error) -> bool {
    error.kind() == ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH)
}

/// The shells the live test opens here, with no startup files and a prompt of its folder: Linux
/// removes a folder a process sits in, so none leaves it first.
#[cfg(any(test, feature = "test-support"))]
pub const SHELL_FOLDER_PROBES: &[ShellFolderProbe] = &[BASH_SHELL_FOLDER_PROBE];

// The value of the first `PRETTY_HOSTNAME=` line in an environment-style file: `KEY=VALUE` lines,
// `#` comments, and values that may be quoted, with backslash escapes inside double quotes.
fn pretty_hostname_in(machine_info: &str) -> Option<String> {
    let value = machine_info
        .split('\n')
        .find_map(|line| line.trim().strip_prefix(PRETTY_HOSTNAME_KEY))?;
    if let Some(quoted) = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    {
        return Some(unescape(quoted));
    }
    if let Some(quoted) = value
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
    {
        return Some(quoted.to_owned());
    }
    Some(value.to_owned())
}

// Each backslash and the character after it read as that character; a backslash before a line
// break, or at the end, stays as written.
fn unescape(quoted: &str) -> String {
    let mut unescaped = String::with_capacity(quoted.len());
    let mut characters = quoted.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\\'
            && let Some(escaped) =
                characters.next_if(|next| !matches!(*next, '\r' | '\u{2028}' | '\u{2029}'))
        {
            unescaped.push(escaped);
        } else {
            unescaped.push(character);
        }
    }
    unescaped
}

// The mount points of the Windows drives in `mount_table`, when `kernel_release` names a WSL
// kernel: WSL 1 mounts a drive as `drvfs`, WSL 2 over `9p` with `aname=drvfs` among its options,
// and every `virtiofs` mount is a drive, since WSL mounts nothing else that way.
fn drive_mounts_in(kernel_release: &[u8], mount_table: &[u8]) -> Vec<PathBuf> {
    // `5.15.167.4-microsoft-standard-WSL2` on WSL 2, `4.4.0-19041-Microsoft` on WSL 1.
    let microsoft = b"microsoft";
    let is_wsl = kernel_release
        .windows(microsoft.len())
        .any(|word| word.eq_ignore_ascii_case(microsoft));
    if !is_wsl {
        return Vec::new();
    }
    let mut mounts = Vec::new();
    for line in mount_table.split(|byte| *byte == b'\n') {
        let mut fields = line.split(|byte| *byte == b' ').skip(1);
        let (Some(mount_point), Some(file_system), Some(options)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let is_drive = file_system == b"drvfs"
            || file_system == b"virtiofs"
            || (file_system == b"9p"
                && options
                    .split(|byte| *byte == b',' || *byte == b';')
                    .any(|option| option == b"aname=drvfs"));
        if is_drive {
            mounts.push(PathBuf::from(OsString::from_vec(unescape_mount_point(
                mount_point,
            ))));
        }
    }
    mounts
}

/// A mount table's path decoded: the table writes a space, tab, newline or backslash in a path as
/// `\` and three octal digits; each decodes to its byte, and one above `\377`, which names no byte,
/// stays as written.
pub(crate) fn unescape_mount_point(escaped: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(escaped.len());
    let mut rest = escaped;
    while let Some((&byte, after)) = rest.split_first() {
        if byte == b'\\'
            && let [
                high @ b'0'..=b'3',
                middle @ b'0'..=b'7',
                low @ b'0'..=b'7',
                ..,
            ] = after
        {
            bytes.push(((high - b'0') << 6) | ((middle - b'0') << 3) | (low - b'0'));
            rest = &after[3..];
        } else {
            bytes.push(byte);
            rest = after;
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rstest::rstest;

    use super::drive_mounts_in;

    #[rstest]
    #[case::wsl_1_drvfs(
        "4.4.0-19041-Microsoft",
        "rootfs / lxfs rw,noatime 0 0\nC:\\134 /mnt/c drvfs rw,noatime,uid=1000,gid=1000 0 0\n",
        vec!["/mnt/c"]
    )]
    #[case::wsl_2_plan9_between_comma_and_semicolon(
        "5.15.167.4-microsoft-standard-WSL2",
        "drivers /usr/lib/wsl/drivers 9p ro,dirsync,aname=drivers;fmask=222,trans=fd 0 0\n\
         C:\\134 /mnt/c 9p rw,dirsync,aname=drvfs;path=C:\\134;uid=1000,trans=fd 0 0\n",
        vec!["/mnt/c"]
    )]
    #[case::wsl_2_plan9_between_semicolons(
        "5.15.167.4-microsoft-standard-WSL2",
        "D:\\134 /mnt/d 9p rw;aname=drvfs;path=D:\\134 0 0\n\
         E:\\134 /mnt/e 9p rw,aname=drvfsx;path=E:\\134 0 0\n",
        vec!["/mnt/d"]
    )]
    #[case::virtiofs(
        "6.6.36.6-microsoft-standard-WSL2",
        "drvfsC /mnt/c virtiofs rw,relatime 0 0\n",
        vec!["/mnt/c"]
    )]
    #[case::octal_escapes(
        "5.15.167.4-microsoft-standard-WSL2",
        "C:\\134 /mnt/my\\040drive drvfs rw 0 0\nD:\\134 /mnt/odd\\400name drvfs rw 0 0\n",
        vec!["/mnt/my drive", "/mnt/odd\\400name"]
    )]
    #[case::not_wsl(
        "6.8.0-45-generic",
        "C:\\134 /mnt/c drvfs rw 0 0\nshare /mnt/s virtiofs rw 0 0\n",
        vec![]
    )]
    fn finds_the_windows_drive_mounts(
        #[case] kernel_release: &str,
        #[case] mount_table: &str,
        #[case] expected: Vec<&str>,
    ) {
        assert_eq!(
            drive_mounts_in(kernel_release.as_bytes(), mount_table.as_bytes()),
            expected.into_iter().map(PathBuf::from).collect::<Vec<_>>()
        );
    }
}
