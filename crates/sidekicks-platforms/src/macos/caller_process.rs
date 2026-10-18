//! The process at the other end of a local connection on macOS, read from the socket's audit token
//! and pinned by its unique id, which the system never gives another process; a pinned process's
//! parent, and the process responsible for it, pinned the same way. Every read of a pinned process
//! asks the system to answer only while the id still names that process, so a reused process id is
//! never read.

use std::ffi::OsString;
use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::ffi::OsStringExt as _;
use std::path::PathBuf;
use std::sync::OnceLock;

use interprocess::local_socket::tokio::Stream;

use crate::caller_process::{PARENT_READ_ATTEMPTS, ParentProcess, ResponsibleProcess};
use crate::macos::responsibility::{read_responsible_id, read_responsible_unique_id};

// The record of a process's unique ids, which the SDK's headers leave out; its layout is fixed.
const UNIQUE_IDENTIFIERS_FLAVOR: libc::c_int = 17;

// The process-information call a checked read makes.
const PROCESS_INFORMATION_CALL: i32 = 2;

// A checked read answers only while the id names the process with this id version (`exec`
// changes it) or this unique id (fixed for the process's life).
const COMPARE_ID_VERSION: u32 = 0x1;
const COMPARE_UNIQUE_ID: u32 = 0x2;
const COMPARE_NOTHING: u32 = 0;

// The audit token's slots holding the process's id and its id version.
const TOKEN_PROCESS_ID: usize = 5;
const TOKEN_ID_VERSION: usize = 7;

/// A socket's audit token: who last used its other end.
#[derive(Clone, Copy, Debug)]
#[repr(C)]
pub(crate) struct AuditToken {
    val: [u32; 8],
}

impl AuditToken {
    /// The token's bytes, as the system lays them out.
    pub(crate) fn to_bytes(self) -> [u8; size_of::<Self>()] {
        let mut bytes = [0; size_of::<Self>()];
        for (chunk, word) in bytes
            .as_chunks_mut::<{ size_of::<u32>() }>()
            .0
            .iter_mut()
            .zip(self.val)
        {
            *chunk = word.to_ne_bytes();
        }
        bytes
    }
}

/// A process's unique ids, the system's `proc_uniqidentifierinfo`.
#[repr(C)]
struct UniqueIdentifiers {
    uuid: [u8; 16],
    unique_id: u64,
    parent_unique_id: u64,
    id_version: i32,
    original_parent_id_version: i32,
    reserved: [u64; 2],
}

const _: () = assert!(size_of::<UniqueIdentifiers>() == 56);

/// `__proc_info_extended_id(callnum, pid, flavor, flags, ext_id, arg, buffer, buffersize)`: a
/// process-information read that the kernel answers only while `pid` names the process `flags`
/// and `ext_id` pin, failing with `ESRCH` otherwise.
type CheckedProcessRead =
    unsafe extern "C" fn(i32, i32, u32, u32, u64, u64, u64, i32) -> libc::c_int;

/// A private `libsystem_kernel` call no SDK header declares; used because it is the one process
/// read the kernel refuses atomically when the id names any process but the pinned one, where a
/// public `sysctl` start-time read is a read-then-compare race. Looked up once at run time, so a
/// macOS without it refuses callers instead of failing to load the daemon; `None` there.
fn checked_process_read() -> Option<CheckedProcessRead> {
    static READ: OnceLock<Option<CheckedProcessRead>> = OnceLock::new();
    *READ.get_or_init(|| {
        // SAFETY: `RTLD_DEFAULT` searches every loaded image, and the name is a C string.
        let symbol =
            unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"__proc_info_extended_id".as_ptr()) };
        (!symbol.is_null()).then(|| {
            // SAFETY: the symbol is libsystem_kernel's function of exactly this signature.
            unsafe { std::mem::transmute::<*mut libc::c_void, CheckedProcessRead>(symbol) }
        })
    })
}

/// A process held by its unique id, so a read made through it names that process or finds it
/// ended, never another process given its id.
#[derive(Clone, Debug)]
pub struct PinnedProcess {
    id: u32,
    unique_id: u64,
    /// The connection's audit token for a peer, which also names the program the process runs at
    /// the connect; `None` for a process pinned by its id alone.
    audit_token: Option<AuditToken>,
}

impl PinnedProcess {
    /// The process's id.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// The audit token a peer was read from; `None` for a process pinned by its id alone.
    pub(crate) fn audit_token(&self) -> Option<AuditToken> {
        self.audit_token
    }
}

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
        if error.kind() == io::ErrorKind::NotConnected {
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
    let Ok(pid) = libc::pid_t::try_from(process.id) else {
        return Ok(None);
    };
    let maximum =
        usize::try_from(libc::PROC_PIDPATHINFO_MAXSIZE).expect("the longest path is positive");
    let mut path = vec![0_u8; maximum];
    let path_length = u32::try_from(path.len()).expect("the path buffer's length fits a u32");
    // SAFETY: `path` is a live, writable buffer of the length given, which the call fills.
    let written = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path_length) };
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

/// Whether `process` still runs under its id. Fails with the system's error.
pub(crate) fn is_running(process: &PinnedProcess) -> io::Result<bool> {
    Ok(read_unique_identifiers(process.id, COMPARE_UNIQUE_ID, process.unique_id)?.is_some())
}

/// This process, pinned.
#[cfg(any(test, feature = "test-support"))]
pub fn this_process() -> PinnedProcess {
    pinned(std::process::id())
        .expect("this process reads its own record")
        .expect("this process runs")
}

/// Process `id`, pinned as it runs now; `None` when no process has the id.
pub(crate) fn pinned(id: u32) -> io::Result<Option<PinnedProcess>> {
    Ok(
        read_unique_identifiers(id, COMPARE_NOTHING, 0)?.map(|identifiers| PinnedProcess {
            id,
            unique_id: identifiers.unique_id,
            audit_token: None,
        }),
    )
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

/// Process `id`'s unique ids, while `flags` and `pin` still name it; `None` otherwise.
fn read_unique_identifiers(id: u32, flags: u32, pin: u64) -> io::Result<Option<UniqueIdentifiers>> {
    // SAFETY: `UniqueIdentifiers` is a C struct of integers, for which all zero bytes are valid.
    let mut identifiers: UniqueIdentifiers = unsafe { std::mem::zeroed() };
    let is_read = read_checked(id, UNIQUE_IDENTIFIERS_FLAVOR, flags, pin, &mut identifiers)?;
    Ok(is_read.then_some(identifiers))
}

/// Fills `record` with process `id`'s `flavor` record, answering `false` when `id` names no
/// process `flags` and `pin` accept. `Record` must be the C struct of integers `flavor` writes.
/// Fails with the system's error, with `Other` when the record comes back short, and with
/// `Unsupported` on a macOS without the checked read.
fn read_checked<Record>(
    id: u32,
    flavor: libc::c_int,
    flags: u32,
    pin: u64,
    record: &mut Record,
) -> io::Result<bool> {
    let Some(read) = checked_process_read() else {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "this macOS has no id-checked process read",
        ));
    };
    // No process id passes `i32::MAX`, the largest the call takes.
    let Ok(pid) = i32::try_from(id) else {
        return Ok(false);
    };
    let record_length =
        i32::try_from(size_of::<Record>()).expect("a process record's size fits in an i32");
    let flavor = u32::try_from(flavor).expect("a flavor is positive");
    // SAFETY: `record` is a live, writable `Record` of the length given, the struct `flavor` asks
    // the call to fill, and nothing else reads it until the call returns.
    let written = unsafe {
        read(
            PROCESS_INFORMATION_CALL,
            pid,
            flavor,
            flags,
            pin,
            0,
            (&raw mut *record).addr() as u64,
            record_length,
        )
    };
    if written == record_length {
        return Ok(true);
    }
    if written > 0 {
        return Err(io::Error::other(format!(
            "process {id}'s record came back {written} of {record_length} bytes"
        )));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(error)
}

#[cfg(test)]
mod tests {
    use interprocess::local_socket::tokio::Stream;
    use interprocess::os::unix::uds_local_socket::tokio::Stream as UnixSocketStream;

    use super::{
        AuditToken, COMPARE_NOTHING, PinnedProcess, TOKEN_ID_VERSION, TOKEN_PROCESS_ID, pin_token,
        pinned, read_parent_process, read_peer_process, read_unique_identifiers,
    };
    use crate::caller_process::ParentProcess;

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
        let ended = pinned(child.id())
            .expect("the child reads")
            .expect("the child has not been reaped");
        child.wait().expect("the child is reaped");
        assert!(matches!(
            read_parent_process(&ended).expect("an ended process reads"),
            ParentProcess::Ended
        ));
    }
}
