//! Opening an address on Linux through the freedesktop.org tools: `xdg-mime` names the application
//! registered for the address's scheme, and `xdg-open` hands the address to it; and whether a
//! browser opened from this process reaches its person, by a display named in its environment or,
//! inside a WSL distribution, by its interop with Windows.

use std::io::{self, ErrorKind};
use std::process::{Command, Stdio};

use crate::address_opening::no_handler_error;
use crate::linux::{KERNEL_RELEASE_PATH, is_wsl_kernel};

/// The variables a graphical session names its display in.
const DISPLAY_VARIABLES: [&str; 3] = ["DISPLAY", "WAYLAND_DISPLAY", "MIR_SOCKET"];

/// The entry WSL registers to run Windows programs from a distribution; its first line says
/// whether that interop is on.
const WSL_INTEROP_ENTRY_PATH: &str = "/proc/sys/fs/binfmt_misc/WSLInterop";

/// Opens `address` in the application registered for its scheme, `xdg-open` started and not waited
/// on. Fails with `NotFound` when `xdg-mime` names no application for the scheme, with
/// `InvalidInput` when the address has no scheme, and with `Other` when either tool cannot start
/// or `xdg-mime` fails.
pub fn open_address(address: &str) -> io::Result<()> {
    let (scheme, _) = address.split_once(':').ok_or_else(|| {
        io::Error::new(ErrorKind::InvalidInput, "the address to open has no scheme")
    })?;
    let handler_query = Command::new("xdg-mime")
        .args(["query", "default", &format!("x-scheme-handler/{scheme}")])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| tool_start_error("xdg-mime", &error))?;
    if !handler_query.status.success() {
        return Err(io::Error::other(format!(
            "xdg-mime could not name the address's application ({})",
            handler_query.status
        )));
    }
    if handler_query.stdout.trim_ascii().is_empty() {
        return Err(no_handler_error());
    }
    // Not waited on: the application the tool starts outlives this call, and the tool's ended
    // process is reaped once the command line exits.
    Command::new("xdg-open")
        .arg(address)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| tool_start_error("xdg-open", &error))?;
    Ok(())
}

// A tool that cannot start, kept apart from `NotFound` so a missing `xdg-utils` never reads as an
// address no application claims.
fn tool_start_error(tool: &str, error: &io::Error) -> io::Error {
    io::Error::other(format!("{tool} could not start: {error}"))
}

/// Whether a browser opened from this process reaches its person on Linux: one of `DISPLAY`,
/// `WAYLAND_DISPLAY` and `MIR_SOCKET` set and not empty in `environment`; inside a WSL
/// distribution, whatever the display, its interop with Windows on, which opens the Windows
/// browser. An unreadable kernel release answers no.
pub(crate) fn can_reach_display(environment: &[(String, String)]) -> bool {
    let Ok(kernel_release) = std::fs::read(KERNEL_RELEASE_PATH) else {
        return false;
    };
    // The entry is read only inside WSL; a missing or unreadable one is interop off.
    let interop_entry = is_wsl_kernel(&kernel_release)
        .then(|| std::fs::read(WSL_INTEROP_ENTRY_PATH).ok())
        .flatten();
    can_show_browser(environment, &kernel_release, interop_entry.as_deref())
}

// The rule over what was read: inside WSL the interop entry's first line `enabled`, elsewhere a
// display variable with a value.
fn can_show_browser(
    environment: &[(String, String)],
    kernel_release: &[u8],
    interop_entry: Option<&[u8]>,
) -> bool {
    if is_wsl_kernel(kernel_release) {
        return interop_entry
            .and_then(|entry| entry.split(|byte| *byte == b'\n').next())
            .is_some_and(|first_line| first_line == b"enabled");
    }
    environment
        .iter()
        .any(|(name, value)| DISPLAY_VARIABLES.contains(&name.as_str()) && !value.is_empty())
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::can_show_browser;

    const LINUX_KERNEL: &[u8] = b"6.8.0-48-generic\n";
    const WSL_KERNEL: &[u8] = b"5.15.167.4-microsoft-standard-WSL2\n";
    const INTEROP_ON: &[u8] = b"enabled\ninterpreter /init\nflags: PF\noffset 0\nmagic 4d5a\n";
    const INTEROP_OFF: &[u8] = b"disabled\ninterpreter /init\nflags: PF\noffset 0\nmagic 4d5a\n";

    fn environment(variables: &[(&str, &str)]) -> Vec<(String, String)> {
        variables
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    // Killed by an empty value read as set, and by any one of the three variables dropped.
    #[rstest]
    #[case::none(&[("PATH", "/usr/bin")], false)]
    #[case::empty_display(&[("DISPLAY", "")], false)]
    #[case::display(&[("DISPLAY", ":0")], true)]
    #[case::wayland(&[("WAYLAND_DISPLAY", "wayland-0")], true)]
    #[case::mir(&[("MIR_SOCKET", "/run/user/1000/mir_socket")], true)]
    fn a_linux_browser_opens_only_with_a_display(
        #[case] variables: &[(&str, &str)],
        #[case] opens: bool,
    ) {
        assert_eq!(
            can_show_browser(&environment(variables), LINUX_KERNEL, None),
            opens
        );
    }

    // Killed by the display rule applied inside WSL, and by the interop entry read outside it.
    #[rstest]
    #[case::interop_on(WSL_KERNEL, Some(INTEROP_ON), true)]
    #[case::interop_off(WSL_KERNEL, Some(INTEROP_OFF), false)]
    #[case::no_interop_entry(WSL_KERNEL, None, false)]
    #[case::outside_wsl(LINUX_KERNEL, Some(INTEROP_ON), false)]
    fn wsl_opens_the_windows_browser_only_while_interop_is_on(
        #[case] kernel_release: &[u8],
        #[case] interop_entry: Option<&[u8]>,
        #[case] opens: bool,
    ) {
        assert_eq!(
            can_show_browser(&environment(&[]), kernel_release, interop_entry),
            opens
        );
    }
}
