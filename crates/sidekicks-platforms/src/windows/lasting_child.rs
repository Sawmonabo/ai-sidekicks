//! A child that outlives the daemon on Windows, started with `CreateProcessW` itself, since std's
//! process attributes are not stable: it breaks away from any job the daemon runs in, joins a new
//! job of its own whose random name its record keeps, so a later daemon can end its whole tree,
//! and inherits no handle but the standard ones it is given.

use std::ffi::{OsStr, c_void};
use std::fs::OpenOptions;
use std::io::{self, ErrorKind};
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
use std::os::windows::process::ExitStatusExt as _;
use std::process::ExitStatus;
use std::sync::Arc;

use tokio::sync::Notify;
use windows_sys::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ALREADY_EXISTS, FALSE, GetLastError, HANDLE,
    INVALID_HANDLE_VALUE, LocalFree, SetLastError, TRUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    TokenUser,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DETACHED_PROCESS,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
    GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    OpenProcessToken, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    PROCESS_INFORMATION, RegisterWaitForSingleObject, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    UnregisterWaitEx, UpdateProcThreadAttribute, WT_EXECUTEONLYONCE,
};

use crate::lasting_child::{LastingChild, LastingCommand};
use crate::windows::pinned_process::{KILLED_EXIT_CODE, PinnedProcess};

// The start of every lasting child's job name; random bytes follow it.
const JOB_NAME_PREFIX: &str = "ai-sidekicks-lasting-";

// The random bytes in a job name.
const JOB_NAME_RANDOM_BYTES: usize = 16;

/// Starts `command` as a child that outlives the daemon, then pins it and reads its record: it
/// breaks away from any job the daemon runs in and joins a new job of its own, named at random in
/// its record and open only to this user, with no kill on its handle's close, so a later daemon
/// opens it by name and ends the whole tree; it has no console and inherits only its standard
/// handles, so it never holds a pipe the daemon's starter waits on. Runs on the daemon's spawner
/// thread. Fails with the system's error from the start, a refused breakaway among them, never
/// retried inside the daemon's job; with `AlreadyExists` when a job of the drawn name exists; or
/// from the pin, which ends the job first.
pub fn spawn_lasting_child(command: LastingCommand) -> io::Result<LastingChild> {
    let (job, job_name) = create_named_job()?;
    let null_device = OpenOptions::new().read(true).write(true).open("NUL")?;
    let standard_stream = duplicate_inheritable(null_device.as_raw_handle())?;
    let error_output = duplicate_inheritable(command.error_output.as_raw_handle())?;
    let mut program = wide_text(command.program.as_os_str())?;
    program.push(0);
    let mut command_line = compose_command_line(command.program.as_os_str(), &command.arguments)?;
    let environment = compose_environment_block(&command.environment)?;
    let mut working_folder = wide_text(command.working_folder.as_os_str())?;
    working_folder.push(0);

    let jobs = [job.as_raw_handle()];
    let inherited = [
        standard_stream.as_raw_handle(),
        error_output.as_raw_handle(),
    ];
    let attributes = AttributeList::new(2)?;
    attributes.update(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    attributes.update(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &inherited)?;

    // SAFETY: `STARTUPINFOEXW` is a C struct of integers and pointers, for which all zero bytes
    // are valid.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb =
        u32::try_from(size_of::<STARTUPINFOEXW>()).expect("the startup record's size fits a u32");
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = standard_stream.as_raw_handle();
    startup.StartupInfo.hStdOutput = standard_stream.as_raw_handle();
    startup.StartupInfo.hStdError = error_output.as_raw_handle();
    startup.lpAttributeList = attributes.list;
    let mut flags = CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS;
    if is_in_job()? {
        flags |= CREATE_BREAKAWAY_FROM_JOB;
    }
    // SAFETY: `PROCESS_INFORMATION` is a C struct of integers and handles, for which all zero
    // bytes are valid.
    let mut information: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: every string is NUL-ended UTF-16 that lives past the call, the command line
    // writable as the call asks; the environment block is double-NUL-ended UTF-16; the startup
    // record, its attribute list and the handles both name stay alive past the call, which
    // writes the process information.
    let created = unsafe {
        CreateProcessW(
            program.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            TRUE,
            flags,
            environment.as_ptr().cast(),
            working_folder.as_ptr(),
            (&raw const startup).cast(),
            &raw mut information,
        )
    };
    if created == FALSE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call succeeded, so both handles are new and owned by nothing else.
    let (process_handle, _thread) = unsafe {
        (
            OwnedHandle::from_raw_handle(information.hProcess),
            OwnedHandle::from_raw_handle(information.hThread),
        )
    };
    let process = PinnedProcess {
        id: information.dwProcessId,
        process: Some(Arc::new(process_handle)),
        job: Some(job_name),
    };
    let record = match process.record() {
        Ok(Some(record)) => record,
        read => {
            // Nothing unrecorded outlives the start.
            // SAFETY: the job's handle is open with every right, as it was made.
            if unsafe { TerminateJobObject(job.as_raw_handle(), KILLED_EXIT_CODE) } == FALSE {
                tracing::warn!(
                    error = &io::Error::last_os_error() as &(dyn std::error::Error + 'static),
                    "the unrecorded lasting child's job could not be ended"
                );
            }
            return Err(read
                .err()
                .unwrap_or_else(|| io::Error::other("the child ended as it started")));
        }
    };
    let waited = Arc::clone(
        process
            .process
            .as_ref()
            .expect("a started child is held by its handle"),
    );
    Ok(LastingChild {
        process,
        record,
        exit: Box::pin(wait_for_exit(waited)),
    })
}

// Makes a new job named at random, open only to this user; refuses a name that already exists,
// which a job of another owner could hold.
fn create_named_job() -> io::Result<(OwnedHandle, String)> {
    let mut random = [0_u8; JOB_NAME_RANDOM_BYTES];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let mut name = JOB_NAME_PREFIX.to_owned();
    for byte in random {
        name.push_str(&format!("{byte:02x}"));
    }
    let descriptor = UserOnlyDescriptor::new()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .expect("the attributes' size fits a u32"),
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: FALSE,
    };
    let mut wide_name = wide_text(OsStr::new(&name))?;
    wide_name.push(0);
    // SAFETY: the call takes nothing and sets the thread's last error, which the creation below
    // leaves alone for a new job.
    unsafe { SetLastError(0) };
    // SAFETY: the attributes and the name are live past the call, which answers a new handle or
    // null.
    let raw_job = unsafe { CreateJobObjectW(&raw const attributes, wide_name.as_ptr()) };
    // SAFETY: the call takes nothing and reads the thread's last error, set by the creation.
    let created_error = unsafe { GetLastError() };
    if raw_job.is_null() {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(created_error).unwrap_or(i32::MAX),
        ));
    }
    // SAFETY: the handle was just opened and is owned by nothing else.
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
    if created_error == ERROR_ALREADY_EXISTS {
        return Err(io::Error::new(
            ErrorKind::AlreadyExists,
            "a job of the drawn name already exists",
        ));
    }
    Ok((job, name))
}

/// A security descriptor granting this user, and no one else, every right; freed on drop.
struct UserOnlyDescriptor(PSECURITY_DESCRIPTOR);

impl UserOnlyDescriptor {
    // Reads this user's id from the process token and builds the descriptor from its SDDL.
    fn new() -> io::Result<Self> {
        let user = read_user_sid_text()?;
        let mut sddl = wide_text(OsStr::new(&format!("D:P(A;;GA;;;{user})")))?;
        sddl.push(0);
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: the SDDL is a live NUL-ended UTF-16 string, and the call writes a descriptor
        // it allocates, which `Drop` frees.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &raw mut descriptor,
                std::ptr::null_mut(),
            )
        } == FALSE
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }
}

impl Drop for UserOnlyDescriptor {
    fn drop(&mut self) {
        // SAFETY: the descriptor came from the conversion, which allocated it with `LocalAlloc`.
        unsafe { LocalFree(self.0) };
    }
}

// This process's user's id as SDDL text (`S-1-5-21-…`).
fn read_user_sid_text() -> io::Result<String> {
    let mut raw_token: HANDLE = std::ptr::null_mut();
    // SAFETY: the pseudo-handle names this process, and the call writes a new token handle.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut raw_token) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the handle was just opened and is owned by nothing else.
    let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };
    let mut length = 0_u32;
    // SAFETY: a null buffer of length 0 asks only for the length, which the call writes.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &raw mut length,
        )
    };
    // Eight-byte words keep the record aligned for its pointer.
    let mut buffer = vec![
        0_u64;
        usize::try_from(length)
            .map_err(io::Error::other)?
            .div_ceil(8)
    ];
    // SAFETY: the buffer is live, writable and at least `length` bytes long.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &raw mut length,
        )
    } == FALSE
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call filled the aligned buffer with a `TOKEN_USER` and the id it points at.
    let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut text: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: the id lives in the buffer, and the call writes a string it allocates, freed below.
    if unsafe { ConvertSidToStringSidW(sid, &raw mut text) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call answered a NUL-ended UTF-16 string, read up to its NUL.
    let units = unsafe {
        let length = (0..).take_while(|&i| *text.add(i) != 0).count();
        std::slice::from_raw_parts(text, length)
    };
    let read =
        String::from_utf16(units).map_err(|error| io::Error::new(ErrorKind::InvalidData, error));
    // SAFETY: the string came from the conversion, which allocated it with `LocalAlloc`.
    unsafe { LocalFree(text.cast()) };
    read
}

// Whether this process runs in a job.
fn is_in_job() -> io::Result<bool> {
    let mut is_in_job = FALSE;
    // SAFETY: the pseudo-handle names this process, a null job asks about any job, and the result
    // points at a live `BOOL`.
    if unsafe {
        IsProcessInJob(
            GetCurrentProcess(),
            std::ptr::null_mut(),
            &raw mut is_in_job,
        )
    } == FALSE
    {
        return Err(io::Error::last_os_error());
    }
    Ok(is_in_job != FALSE)
}

// A new handle to what `handle` opens, inheritable, so the attribute list can name it.
fn duplicate_inheritable(handle: HANDLE) -> io::Result<OwnedHandle> {
    let mut duplicate: HANDLE = std::ptr::null_mut();
    // SAFETY: `handle` is open while its owner lives through the call, both process handles are
    // this process's pseudo-handle, and the call writes the new handle.
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle,
            GetCurrentProcess(),
            &raw mut duplicate,
            0,
            TRUE,
            DUPLICATE_SAME_ACCESS,
        )
    } == FALSE
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call succeeded, so the handle is new and owned by nothing else.
    Ok(unsafe { OwnedHandle::from_raw_handle(duplicate) })
}

/// A process start's attribute list, deleted on drop.
struct AttributeList {
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
    // The list's storage, in eight-byte words for its alignment.
    _storage: Vec<u64>,
}

impl AttributeList {
    // A list with room for `count` attributes.
    fn new(count: u32) -> io::Result<Self> {
        let mut size = 0_usize;
        // SAFETY: a null list asks only for the size, which the call writes; it then fails with
        // `ERROR_INSUFFICIENT_BUFFER`, as it should.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), count, 0, &raw mut size) };
        let mut storage = vec![0_u64; size.div_ceil(8)];
        let list: LPPROC_THREAD_ATTRIBUTE_LIST = storage.as_mut_ptr().cast();
        // SAFETY: the storage is live, writable, aligned and at least `size` bytes long.
        if unsafe { InitializeProcThreadAttributeList(list, count, 0, &raw mut size) } == FALSE {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            list,
            _storage: storage,
        })
    }

    // Sets `attribute` to `handles`, which must outlive the start that reads the list.
    fn update(&self, attribute: u32, handles: &[HANDLE]) -> io::Result<()> {
        // SAFETY: the list is initialized, and `handles` is a live array of the size given.
        if unsafe {
            UpdateProcThreadAttribute(
                self.list,
                0,
                usize::try_from(attribute).expect("an attribute fits a usize"),
                handles.as_ptr().cast(),
                size_of_val(handles),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == FALSE
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: the list was initialized and its storage still lives.
        unsafe { DeleteProcThreadAttributeList(self.list) };
    }
}

// `text` as UTF-16; fails with `InvalidInput` for text holding NUL, which ends a string here.
fn wide_text(text: &OsStr) -> io::Result<Vec<u16>> {
    let units: Vec<u16> = text.encode_wide().collect();
    if units.contains(&0) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "a start's text holds a NUL",
        ));
    }
    Ok(units)
}

// The NUL-ended command line: the program quoted, then each argument as a C program's standard
// argument parsing reads it back, the rule std's `Command` writes by.
fn compose_command_line(program: &OsStr, arguments: &[String]) -> io::Result<Vec<u16>> {
    let program = wide_text(program)?;
    if program.contains(&u16::from(b'"')) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "a program path holds a quote",
        ));
    }
    let mut line = vec![u16::from(b'"')];
    line.extend(program);
    line.push(u16::from(b'"'));
    for argument in arguments {
        line.push(u16::from(b' '));
        append_argument(&mut line, &wide_text(OsStr::new(argument))?);
    }
    line.push(0);
    Ok(line)
}

// Appends `argument`, quoted when it is empty or holds a space or a tab, its backslashes doubled
// where a quote follows them.
fn append_argument(line: &mut Vec<u16>, argument: &[u16]) {
    let quote = u16::from(b'"');
    let backslash = u16::from(b'\\');
    let is_quoted = argument.is_empty()
        || argument
            .iter()
            .any(|&unit| unit == u16::from(b' ') || unit == u16::from(b'\t'));
    if is_quoted {
        line.push(quote);
    }
    let mut backslashes = 0_usize;
    for &unit in argument {
        if unit == backslash {
            backslashes += 1;
        } else {
            if unit == quote {
                line.extend(std::iter::repeat_n(backslash, backslashes + 1));
            }
            backslashes = 0;
        }
        line.push(unit);
    }
    if is_quoted {
        line.extend(std::iter::repeat_n(backslash, backslashes));
        line.push(quote);
    }
}

// The environment block: each `NAME=value`, NUL-ended, sorted by name without case as Windows
// keeps it, then one more NUL. Fails with `InvalidInput` for a name holding `=` or a NUL.
fn compose_environment_block(environment: &[(String, String)]) -> io::Result<Vec<u16>> {
    let mut pairs: Vec<&(String, String)> = environment.iter().collect();
    pairs.sort_by_cached_key(|(name, _)| name.to_uppercase());
    let mut block = Vec::new();
    for (name, value) in pairs {
        if name.is_empty() || name.contains('=') {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "an environment name is empty or holds `=`",
            ));
        }
        block.extend(wide_text(OsStr::new(name))?);
        block.push(u16::from(b'='));
        block.extend(wide_text(OsStr::new(value))?);
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

// Waits for `process` to exit on the system's wait thread, then reads its exit code.
async fn wait_for_exit(process: Arc<OwnedHandle>) -> io::Result<ExitStatus> {
    let exited = Arc::new(Notify::new());
    let registration = ExitRegistration::register(&process, Arc::clone(&exited))?;
    exited.notified().await;
    drop(registration);
    let mut code = 0_u32;
    // SAFETY: the handle is open while `process` lives and carries the right to read its exit.
    if unsafe { GetExitCodeProcess(process.as_raw_handle(), &raw mut code) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    Ok(ExitStatus::from_raw(code))
}

/// A one-shot wait the system's thread pool runs on a process handle, which notifies once the
/// process exits; unregistered on drop.
struct ExitRegistration {
    wait: HANDLE,
    exited: *const Notify,
}

// SAFETY: the wait handle and the notification are used only through calls the system allows
// from any thread, and `Notify` is `Sync`.
unsafe impl Send for ExitRegistration {}

impl ExitRegistration {
    // Registers the wait on `process`, which outlives the registration.
    fn register(process: &OwnedHandle, exited: Arc<Notify>) -> io::Result<Self> {
        let exited = Arc::into_raw(exited);
        let mut wait: HANDLE = std::ptr::null_mut();
        // SAFETY: the handle is open, the callback reads the context as the `Notify` it is, and
        // the context lives until `Drop` has unregistered the wait.
        if unsafe {
            RegisterWaitForSingleObject(
                &raw mut wait,
                process.as_raw_handle(),
                Some(notify_exit),
                exited.cast(),
                INFINITE,
                WT_EXECUTEONLYONCE,
            )
        } == FALSE
        {
            let error = io::Error::last_os_error();
            // SAFETY: the pointer came from `Arc::into_raw` and the failed registration holds none.
            drop(unsafe { Arc::from_raw(exited) });
            return Err(error);
        }
        Ok(Self { wait, exited })
    }
}

impl Drop for ExitRegistration {
    fn drop(&mut self) {
        // SAFETY: the wait is registered; `INVALID_HANDLE_VALUE` makes the call wait for a running
        // callback to return, so the notification is freed only after its last use.
        if unsafe { UnregisterWaitEx(self.wait, INVALID_HANDLE_VALUE) } == FALSE {
            tracing::warn!(
                error = &io::Error::last_os_error() as &(dyn std::error::Error + 'static),
                "a lasting child's exit wait could not be unregistered"
            );
        }
        // SAFETY: the pointer came from `Arc::into_raw`, and no callback runs any more.
        drop(unsafe { Arc::from_raw(self.exited) });
    }
}

// The wait's callback: notifies the waiting task that the process exited.
unsafe extern "system" fn notify_exit(context: *mut c_void, _timed_out: bool) {
    // SAFETY: the context is the registration's `Notify`, alive until the wait is unregistered.
    unsafe { (*context.cast::<Notify>()).notify_one() };
}

#[cfg(test)]
mod tests {
    use super::append_argument;

    // Mutation killed: dropping the doubled backslashes before a quote changes what the child
    // reads back.
    #[test]
    fn a_lasting_child_argument_reads_back_as_written() {
        for (argument, expected) in [
            ("plain", "plain"),
            ("", r#""""#),
            ("two words", r#""two words""#),
            (r#"say "hi""#, r#""say \"hi\"""#),
            (r"C:\folder\", r"C:\folder\"),
            (r"C:\my folder\", r#""C:\my folder\\""#),
        ] {
            let mut line = Vec::new();
            append_argument(&mut line, &argument.encode_utf16().collect::<Vec<_>>());
            assert_eq!(String::from_utf16_lossy(&line), expected, "{argument}");
        }
    }
}
