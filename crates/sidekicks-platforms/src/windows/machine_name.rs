//! The machine's name on Windows: its DNS host name without the domain, the name the person gave
//! it, never `%COMPUTERNAME%`, the 15-byte uppercase NetBIOS name.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::sync::OnceLock;

use windows_sys::Win32::Networking::WinSock::{GetHostNameW, WSADATA, WSAGetLastError, WSAStartup};

use crate::machine_name::{MachineNameError, require_machine_name};
use crate::spawner::Spawner;

// What the name is read from.
const HOST_NAME_SOURCE: &str = "GetHostNameW";

// The host name's room in UTF-16 units, its NUL included: a DNS name holds at most 255 bytes.
const HOST_NAME_CAPACITY: usize = 256;

// Winsock 2.2, the newest version, which every supported Windows has.
const WINSOCK_VERSION: u16 = 0x0202;

// What starting Winsock answered: zero, or the error that refused it. Winsock starts once for the
// process, since `GetHostNameW` needs it, and is never cleaned up, since a later call needs it too.
static WINSOCK_START: OnceLock<i32> = OnceLock::new();

/// The machine's DNS host name without its domain, read on a blocking thread once Winsock has
/// started. Fails with [`MachineNameError::Read`] when Winsock cannot start or the read fails, and
/// with [`MachineNameError::Empty`] when the name is empty.
pub async fn machine_name(_spawner: &Spawner) -> Result<String, MachineNameError> {
    let read_failure = |source: io::Error| MachineNameError::Read {
        source_name: HOST_NAME_SOURCE,
        source,
    };
    let name = tokio::task::spawn_blocking(host_name)
        .await
        .map_err(|join_failure| read_failure(io::Error::from(join_failure)))?
        .map_err(read_failure)?;
    require_machine_name(name, HOST_NAME_SOURCE)
}

// The host name, its UTF-16 decoded lossily, an unpaired surrogate read as U+FFFD, as the desktop
// reads it.
fn host_name() -> io::Result<String> {
    start_winsock()?;
    let mut buffer = [0_u16; HOST_NAME_CAPACITY];
    let capacity = i32::try_from(buffer.len()).expect("the host name's room fits in an i32");
    // SAFETY: the pointer and capacity describe `buffer`, which the call writes at most `capacity`
    // units into, its NUL included.
    if unsafe { GetHostNameW(buffer.as_mut_ptr(), capacity) } != 0 {
        // SAFETY: the call takes no arguments and reads this thread's last Winsock error.
        let code = unsafe { WSAGetLastError() };
        return Err(io::Error::from_raw_os_error(code));
    }
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    Ok(OsString::from_wide(&buffer[..length])
        .to_string_lossy()
        .into_owned())
}

// Starts Winsock for the process on the first call; a refusal is answered to every call, as
// `WSAStartup` gives it.
fn start_winsock() -> io::Result<()> {
    let code = *WINSOCK_START.get_or_init(|| {
        let mut data = WSADATA::default();
        // SAFETY: the data pointer names a live local the call writes one `WSADATA` into.
        unsafe { WSAStartup(WINSOCK_VERSION, &raw mut data) }
    });
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}
