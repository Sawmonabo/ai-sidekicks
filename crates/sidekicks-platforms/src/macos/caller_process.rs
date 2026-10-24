//! The process at the other end of a local connection on macOS, read from the socket's audit token
//! and pinned by its unique id, which the system never gives another process; a pinned process's
//! parent, the process responsible for it and the program it runs, each read through the pinned
//! process's id-checked reads, so a reused process id is never read.

use std::ffi::OsString;
use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::ffi::OsStringExt as _;
use std::path::PathBuf;
use std::sync::OnceLock;

use interprocess::local_socket::tokio::Stream;

use crate::caller_process::{PARENT_READ_ATTEMPTS, ParentProcess, ResponsibleProcess};
use crate::macos::pinned_process::{
    AuditToken, COMPARE_ID_VERSION, COMPARE_NOTHING, COMPARE_UNIQUE_ID, PinnedProcess,
    TOKEN_ID_VERSION, TOKEN_PROCESS_ID, is_running, read_checked, read_unique_identifiers,
};
use crate::macos::responsibility::{read_responsible_id, read_responsible_unique_id};
use crate::posix::process::id::system_process_id;

/// The process that last used the other end of `stream` (the connecting one until it hands the
/// socket on), pinned. `None` once that end has closed or that process has ended; fails with the
/// system's error otherwise.
pub fn read_peer_process(stream: &Stream) -> io::Result<Option<PinnedProcess>> {
    let Stream::UdSocket(socket) = stream;
    let mut token = AuditToken { val: [0; 8] };
    let token_length = libc::socklen_t::try_from(size_of::<AuditToken>())
        .expect("the token's size fits in a socklen_t");
    let mut length = token_length;
    // SAFETY: the socket is open for the call, and the buffer is a live `AuditToken` of the length
    // given, which the call fills.
    let status = unsafe {
        libc::getsockopt(
            socket.inner().as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERTOKEN,
            (&raw mut token).cast(),
            &raw mut length,
        )
    };
    if status != 0 {
        let error = io::Error::last_os_error();
        // `EINVAL` is the answer for a peer whose process has ended.
        if error.kind() == io::ErrorKind::NotConnected || error.raw_os_error() == Some(libc::EINVAL)
        {
            return Ok(None);
        }
        return Err(error);
    }
    if length != token_length {
        return Err(io::Error::other(format!(
            "the socket's audit token came back {length} of {token_length} bytes"
        )));
    }
    pin_token(&token)
}

/// The process `token` names, pinned by a read the kernel answers only while the token's id
/// version still names it; `None` once that process has ended.
fn pin_token(token: &AuditToken) -> io::Result<Option<PinnedProcess>> {
    let id = token.val[TOKEN_PROCESS_ID];
    let Some(identifiers) = read_unique_identifiers(
        id,
        COMPARE_ID_VERSION,
        u64::from(token.val[TOKEN_ID_VERSION]),
    )?
    else {
        return Ok(None);
    };
    Ok(Some(PinnedProcess {
        id,
        unique_id: identifiers.unique_id,
        audit_token: Some(*token),
    }))
}

/// `process`'s parent, pinned: its id is read, the parent's unique id read, then the process's
/// parent read again, and only an unchanged id is taken, since a parent's exit moves its children
/// to another parent before its id can be reused. Fails with the system's error, and with `Other`
/// when the parent kept changing.
pub fn read_parent_process(process: &PinnedProcess) -> io::Result<ParentProcess> {
    for _ in 0..PARENT_READ_ATTEMPTS {
        let Some(parent_id) = read_parent_id(process)? else {
            return Ok(ParentProcess::Ended);
        };
        if parent_id == 0 {
            return Ok(ParentProcess::Root);
        }
        // The parent ended between the reads when it has no record; the process has a new one.
        let Some(parent) = read_unique_identifiers(parent_id, COMPARE_NOTHING, 0)? else {
            continue;
        };
        match read_parent_id(process)? {
            None => return Ok(ParentProcess::Ended),
            Some(again) if again == parent_id => {
                return Ok(ParentProcess::Pinned(PinnedProcess {
                    id: parent_id,
                    unique_id: parent.unique_id,
                    audit_token: None,
                }));
            }
            Some(_) => {}
        }
    }
    Err(io::Error::other(
        "the process's parent kept changing while it was read",
    ))
}

/// The process the system holds responsible for `process`, its answer taken only once `process`
/// is read still running after it, since a reused id would make it another process's answer. Fails
/// with the system's error, with `Unsupported` on a macOS without the calls, and with `Other` when
/// the responsible process kept ending while it was read.
pub fn read_responsible_process(process: &PinnedProcess) -> io::Result<ResponsibleProcess> {
    let own_unique_id = own_unique_id()?;
    for _ in 0..RESPONSIBLE_READ_ATTEMPTS {
        let Some(responsible_unique_id) = read_responsible_unique_id(process.id)? else {
            return Ok(ResponsibleProcess::Ended);
        };
        let Some(responsible_id) = read_responsible_id(process.id)? else {
            return Ok(ResponsibleProcess::Ended);
        };
        if !is_running(process)? {
            return Ok(ResponsibleProcess::Ended);
        }
        if responsible_unique_id == own_unique_id {
            return Ok(ResponsibleProcess::ThisProcess);
        }
        if responsible_unique_id == process.unique_id {
            return Ok(ResponsibleProcess::Itself);
        }
        // Pinned only while its id still names the process the unique id read named; once the
        // responsible process ends, the system holds the process responsible for itself.
        if read_unique_identifiers(responsible_id, COMPARE_UNIQUE_ID, responsible_unique_id)?
            .is_some()
        {
            return Ok(ResponsibleProcess::Another(PinnedProcess {
                id: responsible_id,
                unique_id: responsible_unique_id,
                audit_token: None,
            }));
        }
    }
    Err(io::Error::other(
        "the process's responsible process kept ending while it was read",
    ))
}

/// How many times a responsible read starts over when the responsible process ended between its
/// reads; the next read finds the process responsible for itself.
const RESPONSIBLE_READ_ATTEMPTS: usize = 4;

/// This process's unique id, which never changes and an exec keeps: read once, at the start's
/// first responsible read, then held.
fn own_unique_id() -> io::Result<u64> {
    static OWN_UNIQUE_ID: OnceLock<u64> = OnceLock::new();
    if let Some(&unique_id) = OWN_UNIQUE_ID.get() {
        return Ok(unique_id);
    }
    let identifiers = read_unique_identifiers(std::process::id(), COMPARE_NOTHING, 0)?
        .ok_or_else(|| io::Error::other("this process has no record of its own"))?;
    Ok(*OWN_UNIQUE_ID.get_or_init(|| identifiers.unique_id))
}

/// The path of the program `process` runs, as the system names it, taken only once `process` is
/// read still running after it, since a reused id would name another process's program; `None`
/// once `process` has ended. Fails with the system's error, `ENOENT` when the program's file is
/// gone, so a start whose responsible process runs a deleted program fails.
pub(crate) fn read_program_path(process: &PinnedProcess) -> io::Result<Option<PathBuf>> {
    let Ok(pid) = system_process_id(process.id) else {
        return Ok(None);
    };
    let maximum =
        usize::try_from(libc::PROC_PIDPATHINFO_MAXSIZE).expect("the longest path is positive");
    let mut path = vec![0_u8; maximum];
    let path_length = u32::try_from(path.len()).expect("the path buffer's length fits a u32");
    // SAFETY: `path` is a live, writable buffer of the length given, which the call fills.
    let written = unsafe { libc::proc_pidpath(pid.get(), path.as_mut_ptr().cast(), path_length) };
    let Ok(written) = usize::try_from(written) else {
        return failed_path_read();
    };
    if written == 0 {
        return failed_path_read();
    }
    path.truncate(written);
    if !is_running(process)? {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(OsString::from_vec(path))))
}

/// What a program-path read that failed means: `None` when the process is gone, the system's
/// error otherwise.
fn failed_path_read() -> io::Result<Option<PathBuf>> {
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(None);
    }
    Err(error)
}

/// `process`'s parent's id, `None` once it has ended.
fn read_parent_id(process: &PinnedProcess) -> io::Result<Option<u32>> {
    // SAFETY: `proc_bsdshortinfo` is a C struct of integers, for which all zero bytes are valid.
    let mut record: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
    let is_read = read_checked(
        process.id,
        libc::PROC_PIDT_SHORTBSDINFO,
        COMPARE_UNIQUE_ID,
        process.unique_id,
        &mut record,
    )?;
    Ok(is_read.then_some(record.pbsi_ppid))
}

#[cfg(test)]
mod tests {
    use interprocess::local_socket::tokio::Stream;
    use interprocess::os::unix::uds_local_socket::tokio::Stream as UnixSocketStream;

    use super::{pin_token, read_parent_process, read_peer_process};
    use crate::caller_process::ParentProcess;
    use crate::macos::pinned_process::{
        AuditToken, COMPARE_NOTHING, PinnedProcess, TOKEN_ID_VERSION, TOKEN_PROCESS_ID,
        pin_running_process, read_unique_identifiers,
    };

    #[test]
    fn pins_this_process_as_its_own_peer_and_its_parent_until_each_ends() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .expect("a runtime");
        let _entered = runtime.enter();
        let (near, far) = tokio::net::UnixStream::pair().expect("a connected socket pair");
        let stream = Stream::from(UnixSocketStream::from(near));

        let peer = read_peer_process(&stream)
            .expect("the peer reads")
            .expect("the peer runs");
        assert_eq!(peer.id(), std::process::id());
        match read_parent_process(&peer).expect("the parent reads") {
            ParentProcess::Pinned(parent) => {
                assert_eq!(parent.id(), std::os::unix::process::parent_id());
            }
            other @ (ParentProcess::Root | ParentProcess::Ended) => {
                panic!("expected the parent, got {other:?}")
            }
        }
        // A token naming this process under another id version, or a pin to another unique id,
        // finds nothing.
        let own = read_unique_identifiers(peer.id(), COMPARE_NOTHING, 0)
            .expect("this process reads its own record")
            .expect("this process runs");
        let mut token = AuditToken { val: [0; 8] };
        token.val[TOKEN_PROCESS_ID] = peer.id();
        token.val[TOKEN_ID_VERSION] = own.id_version.cast_unsigned().wrapping_add(1);
        assert!(pin_token(&token).expect("a pinned read answers").is_none());
        let wrong_unique_id = PinnedProcess {
            id: peer.id(),
            unique_id: own.unique_id + 1,
            audit_token: None,
        };
        assert!(matches!(
            read_parent_process(&wrong_unique_id).expect("a pinned read answers"),
            ParentProcess::Ended
        ));
        // macOS names no peer once the other end has closed.
        drop(far);
        assert!(
            read_peer_process(&stream)
                .expect("a closed peer reads")
                .is_none()
        );

        // A pinned process that ended has no parent to read, even once its id is free again.
        let mut child = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("the child starts");
        let ended = pin_running_process(child.id())
            .expect("the child reads")
            .expect("the child has not been reaped");
        child.wait().expect("the child is reaped");
        assert!(matches!(
            read_parent_process(&ended).expect("an ended process reads"),
            ParentProcess::Ended
        ));
    }
}
