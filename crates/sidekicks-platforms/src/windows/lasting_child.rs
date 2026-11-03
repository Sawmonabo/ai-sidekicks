//! A child that outlives its starter on Windows, started with `CreateProcessW` itself, since std's
//! process attributes are not stable: it breaks away from any job its starter runs in, joins a new
//! job of its own whose random name its record keeps, so a later daemon can end its whole tree,
//! and inherits no handle but the standard ones it is given. That job lets a child leave it, since
//! the daemon the `sidekicks` command starts is itself a lasting child and starts lasting children
//! of its own with `CREATE_BREAKAWAY_FROM_JOB`, which a job without that allowance refuses.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::{self, ErrorKind};
use std::marker::PhantomData;
use std::os::windows::io::{
    AsHandle as _, AsRawHandle as _, BorrowedHandle, FromRawHandle as _, OwnedHandle,
};
use std::os::windows::process::ExitStatusExt as _;
use std::process::ExitStatus;
use std::sync::Arc;

use windows_sys::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ALREADY_EXISTS, FALSE, GetLastError, HANDLE,
    SetLastError, TRUE,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::JobObjects::{CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK};
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    UpdateProcThreadAttribute,
};

use crate::lasting_child::{LastingChild, LastingCommand};
use crate::path::rules::PathRules;
use crate::path::rules::windows::command_line::compose_command_line;
use crate::windows::handle_wait::HandleWait;
use crate::windows::null_device::NULL_DEVICE_PATH;
use crate::windows::pinned_process::{
    PinnedProcess, current_process, is_process_in_job, read_exit_code,
};
use crate::windows::process_containment::set_job_limits;
use crate::windows::process_user::UserOnlyDescriptor;
use crate::windows::wide_text::{refuse_nul, wide_text};

// The start of every lasting child's job name; random bytes follow it.
const JOB_NAME_PREFIX: &str = "ai-sidekicks-lasting-";

// The random bytes in a job name.
const JOB_NAME_RANDOM_BYTES: usize = 16;

/// Starts `command` as a child that outlives its starter, then pins it and reads its record: it
/// breaks away from any job its starter runs in and joins a new job of its own, named at random in
/// its record and open only to this user, with no kill on its handle's close, so a later daemon
/// opens it by name and ends the whole tree; it has a console of its own with no window, which a
/// console program it starts inherits, and inherits only its standard handles, so it never holds a
/// pipe the daemon's starter waits on. Runs on the caller's one blocking thread for starts: the
/// daemon's spawner thread, the `spawner` module's [`crate::Spawner`], or the `sidekicks`
/// command's; the two inheritable copies of those handles live in the starter until this returns,
/// and a start on another thread meanwhile would inherit them. Fails with the system's error from
/// the start, a refused breakaway among them, never retried inside the daemon's job; with
/// `AlreadyExists` when a job of the drawn name exists; or from the pin, which ends the job first.
#[expect(
    clippy::needless_pass_by_value,
    reason = "every system takes the command by value, and the macOS and Linux start consumes it"
)]
pub fn spawn_lasting_child(command: LastingCommand) -> io::Result<LastingChild> {
    let (job, job_name) = create_named_job()?;
    let null_device = OpenOptions::new()
        .read(true)
        .write(true)
        .open(NULL_DEVICE_PATH)?;
    let standard_stream = duplicate_inheritable(null_device.as_handle())?;
    let error_output = duplicate_inheritable(command.error_output.as_handle())?;
    let mut program = wide_text(command.program.as_os_str())?;
    let mut command_line = compose_checked_command_line(&program, &command.arguments)?;
    program.push(0);
    let environment = compose_environment_block(&command.environment)?;
    let mut working_folder = wide_text(command.working_folder.as_os_str())?;
    working_folder.push(0);

    let jobs = [job.as_handle()];
    let inherited = [standard_stream.as_handle(), error_output.as_handle()];
    let mut attributes = AttributeList::new(2)?;
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
    let mut flags = CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
    if is_process_in_job(current_process(), None)? {
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
    // Deleted here, since `job`, whose handle it borrows, moves into the pinned process below.
    drop(attributes);
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
        job_handle: Some(Arc::new(job)),
    };
    let record = match process.record() {
        Ok(Some(record)) => record,
        read => {
            // Nothing unrecorded outlives the start.
            if let Err(error) = process.terminate_job() {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
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

/// Whether `name` has the shape every lasting child's job name has: the prefix, then the random
/// bytes as lowercase hex.
pub(crate) fn is_lasting_job_name(name: &str) -> bool {
    name.strip_prefix(JOB_NAME_PREFIX).is_some_and(|random| {
        random.len() == 2 * JOB_NAME_RANDOM_BYTES
            && random
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

// Makes a new job named at random, open only to this user, that lets a child started with
// `CREATE_BREAKAWAY_FROM_JOB` leave it, so a lasting daemon in it can start lasting children of its
// own; refuses a name that already exists, which a job of another owner could hold.
fn create_named_job() -> io::Result<(OwnedHandle, String)> {
    let mut random = [0_u8; JOB_NAME_RANDOM_BYTES];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let mut name = JOB_NAME_PREFIX.to_owned();
    for byte in random {
        write!(name, "{byte:02x}").expect("a string takes any text written to it");
    }
    let descriptor = UserOnlyDescriptor::new()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .expect("the attributes' size fits a u32"),
        lpSecurityDescriptor: descriptor.as_raw(),
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
    set_job_limits(job.as_handle(), JOB_OBJECT_LIMIT_BREAKAWAY_OK)?;
    Ok((job, name))
}

// A new handle to what `handle` opens, inheritable, so the attribute list can name it.
fn duplicate_inheritable(handle: BorrowedHandle<'_>) -> io::Result<OwnedHandle> {
    let mut duplicate: HANDLE = std::ptr::null_mut();
    // SAFETY: the call writes the new handle, the one thing it writes.
    if unsafe {
        DuplicateHandle(
            current_process().as_raw_handle(),
            handle.as_raw_handle(),
            current_process().as_raw_handle(),
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

/// A process start's attribute list, deleted on drop; the arrays of borrowed handles it points at,
/// and the handles' owners, live for `'handles`, which outlasts the list.
struct AttributeList<'handles> {
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
    // The list's storage, in eight-byte words for its alignment.
    _storage: Vec<u64>,
    handles: PhantomData<&'handles [BorrowedHandle<'handles>]>,
}

impl<'handles> AttributeList<'handles> {
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
            handles: PhantomData,
        })
    }

    // Sets `attribute` to the borrowed `handles`, which the lifetime keeps open until the list is
    // deleted.
    fn update(
        &mut self,
        attribute: u32,
        handles: &'handles [BorrowedHandle<'handles>],
    ) -> io::Result<()> {
        // SAFETY: the list is initialized, and `handles` is a live array of the size given, laid
        // out as the `HANDLE` array the call reads, since `BorrowedHandle` is one `HANDLE`.
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

impl Drop for AttributeList<'_> {
    fn drop(&mut self) {
        // SAFETY: the list was initialized and its storage still lives.
        unsafe { DeleteProcThreadAttributeList(self.list) };
    }
}

// The NUL-ended command line from the program's UTF-16 units, checked for a NUL and not yet
// NUL-ended, the program quoted and each argument as a C program reads it back; fails with
// `InvalidInput` for a program path holding a quote, or an argument holding a NUL.
fn compose_checked_command_line(program: &[u16], arguments: &[String]) -> io::Result<Vec<u16>> {
    if program.contains(&u16::from(b'"')) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "a program path holds a quote",
        ));
    }
    for argument in arguments {
        refuse_nul(OsStr::new(argument))?;
    }
    Ok(compose_command_line(program.iter().copied(), arguments))
}

// The environment block: each `NAME=value`, NUL-ended, sorted by name without case as Windows
// keeps it, then one more NUL. Names that share their environment key are one variable, as std's
// `Command` folds them: the first spelling with the last value. Fails with `InvalidInput` for a
// name that is empty or holds `=`, or text holding a NUL.
fn compose_environment_block(environment: &[(OsString, OsString)]) -> io::Result<Vec<u16>> {
    let mut variables: BTreeMap<OsString, (&OsStr, &OsStr)> = BTreeMap::new();
    for (name, value) in environment {
        // In the WTF-8 bytes Windows text is kept in, a `=` byte is only ever `=`.
        if name.is_empty() || name.as_encoded_bytes().contains(&b'=') {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "an environment name is empty or holds `=`",
            ));
        }
        // A name that is not UTF-8 is keyed as it stands, as a path component is compared.
        let key = name.to_str().map_or_else(
            || name.clone(),
            |text| {
                PathRules::Windows
                    .environment_name_key(text)
                    .into_owned()
                    .into()
            },
        );
        variables
            .entry(key)
            .and_modify(|(_, kept_value)| *kept_value = value)
            .or_insert((name, value));
    }
    let mut block = Vec::new();
    for (name, value) in variables.into_values() {
        block.extend(wide_text(name)?);
        block.push(u16::from(b'='));
        block.extend(wide_text(value)?);
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

// Waits for `process` to exit on the system's thread pool, then reads its exit code.
async fn wait_for_exit(process: Arc<OwnedHandle>) -> io::Result<ExitStatus> {
    let exit_wait = HandleWait::new(Arc::clone(&process))?;
    exit_wait.notified().await;
    drop(exit_wait);
    Ok(ExitStatus::from_raw(read_exit_code(process.as_handle())?))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::io::ErrorKind;

    use super::{compose_checked_command_line, compose_environment_block};
    use crate::windows::wide_text::wide_text;

    // Fails when the program's text or an argument passes with a NUL, which cuts the child's
    // command line short there, so it starts with fewer arguments and no error.
    #[test]
    fn a_lasting_child_start_refuses_text_holding_a_nul() {
        let text = wide_text(OsStr::new("a\0b")).map(|_| ());
        let command_line = compose_checked_command_line(&[], &["a\0b".to_owned()]).map(|_| ());

        assert_eq!(
            text.map_err(|error| error.kind()),
            Err(ErrorKind::InvalidInput)
        );
        assert_eq!(
            command_line.map_err(|error| error.kind()),
            Err(ErrorKind::InvalidInput)
        );
    }

    // Fails when the block keeps both spellings, which lets the child read the first value, where
    // every other start reads the last.
    #[test]
    fn a_lasting_child_environment_keeps_one_variable_per_name_without_case() {
        let environment = [("Path", "first"), ("ONE", "1"), ("PATH", "last")]
            .map(|(name, value)| (name.into(), value.into()));

        let block = compose_environment_block(&environment).expect("the block is composed");

        assert_eq!(String::from_utf16_lossy(&block), "ONE=1\0Path=last\0\0");
    }
}
