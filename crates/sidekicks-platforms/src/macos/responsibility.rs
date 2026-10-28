//! Which process macOS holds responsible for another, and starting a program as its own
//! responsible process. macOS charges a process's privacy prompts to its responsible process, which
//! every process it starts inherits; a start can disclaim it, making the new program its own. The
//! daemon re-runs itself that way at start, unless another running instance of it is responsible
//! for it, so every process it starts reads the daemon as responsible, and starts each terminal the
//! person opens the same way, so a terminal's programs do not.
//!
//! The three calls are `libquarantine`'s, which `libSystem` re-exports and no SDK header declares.
//! Each is looked up once at run time, so a macOS without one refuses instead of failing to load
//! the daemon.

use std::ffi::{CString, OsStr, OsString, c_char, c_int};
use std::io;
use std::sync::OnceLock;

use crate::ResponsibleProcess;
use crate::c_string_array::null_terminated_pointers;
use crate::macos::caller_process::{read_program_path, read_responsible_process};
use crate::macos::loaded_images::look_up_symbol;
use crate::macos::pinned_process::pin_running_process;
use crate::own_root::OwnRootError;
use crate::posix::c_string::c_string;
use crate::posix::process::id::system_process_id;
use crate::posix::spawn::{SpawnAttributes, check_spawn_status};

/// The environment variable a program re-run as its own responsible process starts with, holding
/// the id of the process that set it, which the re-run keeps, so the re-run never repeats; removed
/// as soon as the start reads it.
const OWN_ROOT_MARKER: &str = "SIDEKICKS_OWN_ROOT";

/// `uint64_t responsibility_get_uniqueid_responsible_for_pid(pid_t)`: the unique id of the process
/// responsible for `pid`, `UINT64_MAX` with `errno` set on failure.
type ResponsibleUniqueIdCall = unsafe extern "C" fn(libc::pid_t) -> u64;

/// `pid_t responsibility_get_pid_responsible_for_pid(pid_t)`: the id of the process responsible
/// for `pid`, -1 with `errno` set on failure.
type ResponsibleIdCall = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

/// `errno_t responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *, bool)`: whether a start
/// made with the attributes disclaims the starting process's responsibility; an error code on
/// failure.
type DisclaimCall = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, c_int) -> c_int;

/// The three private calls, each found in the loaded system libraries.
#[derive(Clone, Copy)]
struct ResponsibilityCalls {
    responsible_unique_id: ResponsibleUniqueIdCall,
    responsible_id: ResponsibleIdCall,
    disclaim: DisclaimCall,
}

/// Which process is responsible for the starting program, as the start decides by it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartResponsibility {
    /// The program is its own responsible process.
    Itself,
    /// Another running instance of this same program is, as when a daemon an agent's command runs
    /// is started under the daemon running that agent.
    ThisProgram,
    /// Another program is, or the process that was has just ended.
    Another,
}

/// What the start does about being its own responsible process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OwnRootStep {
    /// It already is: start.
    Start,
    /// Another instance of this program is responsible for it: start without re-running, so it and
    /// everything it starts stay that instance's descendants, which that instance refuses as its
    /// own.
    StayUnder,
    /// It is not and has not re-run itself yet: re-run as its own responsible process.
    ReRun,
    /// It re-ran itself and still is not: refuse to start, since another re-run would repeat.
    StillNotRoot,
}

/// The three calls, looked up together the first time; `Unsupported` on a macOS that lacks any of
/// them, so every caller refuses.
fn responsibility_calls() -> io::Result<ResponsibilityCalls> {
    static CALLS: OnceLock<Option<ResponsibilityCalls>> = OnceLock::new();
    CALLS
        .get_or_init(|| {
            let responsible_unique_id =
                look_up_symbol(c"responsibility_get_uniqueid_responsible_for_pid")?;
            let responsible_id = look_up_symbol(c"responsibility_get_pid_responsible_for_pid")?;
            let disclaim = look_up_symbol(c"responsibility_spawnattrs_setdisclaim")?;
            // SAFETY: each symbol is libquarantine's function of exactly the signature it is cast
            // to.
            unsafe {
                Some(ResponsibilityCalls {
                    responsible_unique_id: std::mem::transmute::<
                        *mut libc::c_void,
                        ResponsibleUniqueIdCall,
                    >(responsible_unique_id),
                    responsible_id: std::mem::transmute::<*mut libc::c_void, ResponsibleIdCall>(
                        responsible_id,
                    ),
                    disclaim: std::mem::transmute::<*mut libc::c_void, DisclaimCall>(disclaim),
                })
            }
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "this macOS has no call naming a process's responsible process",
            )
        })
}

/// The unique id of the process responsible for process `id`; `None` for an id of 0 or past
/// `i32::MAX`, or once no process has the id. Fails with the system's error, and with
/// `Unsupported` on a macOS without the call.
pub(crate) fn read_responsible_unique_id(id: u32) -> io::Result<Option<u64>> {
    let calls = responsibility_calls()?;
    let Ok(pid) = system_process_id(id) else {
        return Ok(None);
    };
    clear_errno();
    // SAFETY: the call takes any process id and only reads the kernel's records.
    let unique_id = unsafe { (calls.responsible_unique_id)(pid.get()) };
    if unique_id != u64::MAX {
        return Ok(Some(unique_id));
    }
    failure_reading(id)
}

/// The id of the process responsible for process `id`; `None` for an id of 0 or past `i32::MAX`,
/// or once no process has the id. Fails with the system's error, and with `Unsupported` on a
/// macOS without the call.
pub(crate) fn read_responsible_id(id: u32) -> io::Result<Option<u32>> {
    let calls = responsibility_calls()?;
    let Ok(pid) = system_process_id(id) else {
        return Ok(None);
    };
    clear_errno();
    // SAFETY: the call takes any process id and only reads the kernel's records.
    let responsible = unsafe { (calls.responsible_id)(pid.get()) };
    if let Ok(responsible) = u32::try_from(responsible) {
        return Ok(Some(responsible));
    }
    failure_reading(id)
}

/// What a responsibility read that answered its failure value means: `None` when process `id` is
/// gone, the system's error otherwise.
fn failure_reading<T>(id: u32) -> io::Result<Option<T>> {
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(None),
        Some(0) | None => Err(io::Error::other(format!(
            "process {id}'s responsible process could not be read, and the system gave no reason"
        ))),
        Some(_) => Err(error),
    }
}

/// Sets `errno` to zero, so a call that answers its failure value without setting it is told
/// apart from one that failed for a reason.
fn clear_errno() {
    // SAFETY: `__error` returns this thread's `errno`, which only this thread writes.
    unsafe { *libc::__error() = 0 };
}

/// A program prepared to replace this process as its own responsible process: every array built
/// and every call found beforehand, so [`OwnRootStart::exec`] makes the one system call.
pub(crate) struct OwnRootStart {
    /// `POSIX_SPAWN_SETEXEC` with the disclaim attribute.
    attributes: SpawnAttributes,
    /// The program's path.
    program: CString,
    /// The strings `argument_pointers` points into, kept alive with them.
    _arguments: Vec<CString>,
    /// The arguments, `NULL`-terminated.
    argument_pointers: Vec<*mut c_char>,
    /// The strings `environment_pointers` points into, kept alive with them.
    _environment: Vec<CString>,
    /// The environment as `NAME=value` entries, `NULL`-terminated.
    environment_pointers: Vec<*mut c_char>,
}

impl OwnRootStart {
    /// Prepares `program` to replace this process with exactly `arguments` and `environment`
    /// (`NAME=value` entries), as its own responsible process. Fails with the error code the
    /// system answers, and with `Unsupported` on a macOS without the disclaim call.
    pub(crate) fn new(
        program: CString,
        arguments: Vec<CString>,
        environment: Vec<CString>,
    ) -> io::Result<Self> {
        let attributes = disclaiming_attributes(libc::POSIX_SPAWN_SETEXEC)?;
        let argument_pointers = null_terminated_pointers(&arguments);
        let environment_pointers = null_terminated_pointers(&environment);
        Ok(Self {
            attributes,
            program,
            _arguments: arguments,
            argument_pointers,
            _environment: environment,
            environment_pointers,
        })
    }

    /// Replaces this process with the program, keeping its id, its descriptors not marked
    /// close-on-exec and its ignored signals as an exec does; returns only on failure, with the
    /// error the system answers. `posix_spawn`, never `posix_spawnp`, which runs a file the kernel
    /// refuses through `/bin/sh`.
    pub(crate) fn exec(&self) -> io::Error {
        // SAFETY: the path and both arrays are NUL- and NULL-terminated and live as long as `self`,
        // and the attributes were set up by `new`.
        let status = unsafe {
            libc::posix_spawn(
                std::ptr::null_mut(),
                self.program.as_ptr(),
                std::ptr::null(),
                self.attributes.as_ptr(),
                self.argument_pointers.as_ptr(),
                self.environment_pointers.as_ptr(),
            )
        };
        io::Error::from_raw_os_error(status)
    }
}

/// Spawn attributes with `flags` and the disclaim attribute, so the program started with them is
/// its own responsible process. Fails with the error code the system answers, and with
/// `Unsupported` on a macOS without the disclaim call.
fn disclaiming_attributes(flags: c_int) -> io::Result<SpawnAttributes> {
    let calls = responsibility_calls()?;
    let mut attributes = SpawnAttributes::new()?;
    attributes.set_flags(flags)?;
    // SAFETY: the attributes were set up above and live across the call.
    check_spawn_status(unsafe { (calls.disclaim)(attributes.as_mut_ptr(), 1) })?;
    Ok(attributes)
}

/// Starts `program` with exactly `arguments` and `environment` (`NAME=value` entries) as its own
/// responsible process, a child of this one, its standard output `output` when one is given, and
/// answers its id once it runs the program; the caller reaps it. Fails with the error code the
/// system answers, and with `Unsupported` on a macOS without the disclaim call.
#[cfg(any(test, feature = "test-support"))]
fn spawn_own_root_child(
    program: &std::ffi::CStr,
    arguments: &[CString],
    environment: &[CString],
    output: Option<std::os::fd::BorrowedFd<'_>>,
) -> io::Result<u32> {
    use std::os::fd::AsRawFd as _;

    use crate::posix::spawn::SpawnFileActions;

    let attributes = disclaiming_attributes(0)?;
    let mut file_actions = SpawnFileActions::new()?;
    if let Some(output) = output {
        // SAFETY: the file actions were set up above, and the descriptor is borrowed for the
        // call's life, which outlives the spawn.
        check_spawn_status(unsafe {
            libc::posix_spawn_file_actions_adddup2(
                file_actions.as_mut_ptr(),
                output.as_raw_fd(),
                libc::STDOUT_FILENO,
            )
        })?;
    }
    let argument_pointers = null_terminated_pointers(arguments);
    let environment_pointers = null_terminated_pointers(environment);
    let mut pid: libc::pid_t = 0;
    // SAFETY: the path and both arrays are NUL- and NULL-terminated and outlive the call, and the
    // file actions and the attributes were set up above. `posix_spawn`, never `posix_spawnp`,
    // which runs a file the kernel refuses through `/bin/sh`.
    check_spawn_status(unsafe {
        libc::posix_spawn(
            &raw mut pid,
            program.as_ptr(),
            file_actions.as_ptr(),
            attributes.as_ptr(),
            argument_pointers.as_ptr(),
            environment_pointers.as_ptr(),
        )
    })?;
    Ok(u32::try_from(pid).expect("a started process's id is positive"))
}

/// Makes this program its own responsible process: when it is not yet, and no other instance of
/// this program is responsible for it, it re-runs itself in place with the same id, arguments and
/// environment and the start begins again from the first line of `main`. Called first, while only
/// the main thread runs and before any folder change. Fails with [`OwnRootError::ThreadsRunning`]
/// when other threads run, [`OwnRootError::StillNotRoot`] when a re-run did not take,
/// [`OwnRootError::Read`] when a read fails, a responsible process whose program file is gone
/// among them, and [`OwnRootError::Exec`] when the re-run cannot start.
pub fn become_own_root() -> Result<(), OwnRootError> {
    let count = read_thread_count().map_err(OwnRootError::Read)?;
    if count > 1 {
        return Err(OwnRootError::ThreadsRunning { count });
    }
    let id = std::process::id();
    let marker = std::env::var_os(OWN_ROOT_MARKER);
    let has_re_run = is_own_marker(marker.as_deref(), id);
    if marker.is_some() {
        // SAFETY: only this thread runs, checked above, so nothing reads the environment while it
        // changes.
        unsafe { std::env::remove_var(OWN_ROOT_MARKER) };
    }
    match read_own_root_step(id, has_re_run).map_err(OwnRootError::Read)? {
        OwnRootStep::Start | OwnRootStep::StayUnder => Ok(()),
        OwnRootStep::StillNotRoot => Err(OwnRootError::StillNotRoot),
        OwnRootStep::ReRun => {
            let start = this_program_as_own_root(id).map_err(OwnRootError::Exec)?;
            Err(OwnRootError::Exec(start.exec()))
        }
    }
}

/// Whether `marker` is the one this process set before re-running itself: the marker names the
/// process that set it, and the re-run keeps its id, so one inherited from another process is not.
fn is_own_marker(marker: Option<&OsStr>, id: u32) -> bool {
    marker.is_some_and(|marker| marker.to_str() == Some(id.to_string().as_str()))
}

/// What the start of process `id`, this one, does, read from its responsible process. Fails with
/// the system's error.
fn read_own_root_step(id: u32, has_re_run: bool) -> io::Result<OwnRootStep> {
    Ok(own_root_step(read_start_responsibility(id)?, has_re_run))
}

/// Which process is responsible for process `id`, this one: a responsible process is this same
/// program when the system names the same program path for both, each read while its process is
/// pinned. Fails with the system's error.
fn read_start_responsibility(id: u32) -> io::Result<StartResponsibility> {
    let this_process =
        pin_running_process(id)?.ok_or_else(|| io::Error::other("this process has no record"))?;
    match read_responsible_process(&this_process)? {
        ResponsibleProcess::ThisProcess | ResponsibleProcess::Itself => {
            Ok(StartResponsibility::Itself)
        }
        ResponsibleProcess::Another(responsible) => {
            let own_program = read_program_path(&this_process)?
                .ok_or_else(|| io::Error::other("this process has no program path"))?;
            if read_program_path(&responsible)?.is_some_and(|program| program == own_program) {
                Ok(StartResponsibility::ThisProgram)
            } else {
                Ok(StartResponsibility::Another)
            }
        }
        ResponsibleProcess::Untracked | ResponsibleProcess::Ended => Err(io::Error::other(
            "this process's responsible process could not be read",
        )),
    }
}

/// What the start does, from which process is responsible for it and whether it has already
/// re-run itself; a re-run is never repeated, so the start cannot loop.
fn own_root_step(responsibility: StartResponsibility, has_re_run: bool) -> OwnRootStep {
    match (responsibility, has_re_run) {
        (StartResponsibility::Itself, _) => OwnRootStep::Start,
        (StartResponsibility::ThisProgram, _) => OwnRootStep::StayUnder,
        (StartResponsibility::Another, false) => OwnRootStep::ReRun,
        (StartResponsibility::Another, true) => OwnRootStep::StillNotRoot,
    }
}

/// This program, prepared to re-run with its own arguments and environment plus the marker
/// naming process `id`. Fails when the system cannot name the program, and with `InvalidInput` for
/// a NUL in it.
fn this_program_as_own_root(id: u32) -> io::Result<OwnRootStart> {
    let program = c_string(std::env::current_exe()?.as_os_str())?;
    let arguments = std::env::args_os()
        .map(|argument| c_string(&argument))
        .collect::<io::Result<Vec<_>>>()?;
    let mut marker = OsString::from(OWN_ROOT_MARKER);
    marker.push(format!("={id}"));
    let environment = std::env::vars_os()
        .map(|(name, value)| {
            let mut entry = name;
            entry.push("=");
            entry.push(value);
            entry
        })
        .chain(std::iter::once(marker))
        .map(|entry| c_string(&entry))
        .collect::<io::Result<Vec<_>>>()?;
    OwnRootStart::new(program, arguments, environment)
}

/// How many threads this process runs. Fails with the system's error.
fn read_thread_count() -> io::Result<i32> {
    let pid = nix::unistd::getpid().as_raw();
    // SAFETY: `proc_taskinfo` is a C struct of integers, for which all zero bytes are valid.
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let length = c_int::try_from(size_of::<libc::proc_taskinfo>())
        .expect("the task record's size fits an int");
    // SAFETY: `info` is a live, writable `proc_taskinfo` of the length given, the record
    // `PROC_PIDTASKINFO` asks the call to fill.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTASKINFO,
            0,
            (&raw mut info).cast(),
            length,
        )
    };
    if written == length {
        return Ok(info.pti_threadnum);
    }
    if written > 0 {
        return Err(io::Error::other(format!(
            "this process's task record came back {written} of {length} bytes"
        )));
    }
    Err(io::Error::last_os_error())
}

/// Runs this test program's test `name` as its own responsible process, a child of this one, and
/// answers whether it passed and what it wrote to its output.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn rerun_test_as_own_root(name: &str) -> (bool, String) {
    use std::io::Read as _;
    use std::os::fd::AsFd as _;

    use crate::posix::spawn::reap_spawned_child;

    let program = std::env::current_exe().expect("the test program names itself");
    let arguments: Vec<CString> = std::iter::once(program.clone().into_os_string())
        .chain(
            crate::test_program::this_test_arguments(name)
                .into_iter()
                .map(OsString::from),
        )
        .map(|argument| c_string(&argument).expect("no NUL"))
        .collect();
    let environment: Vec<CString> = std::env::vars_os()
        .map(|(mut name, value)| {
            name.push("=");
            name.push(value);
            c_string(&name).expect("no NUL")
        })
        .collect();
    // Both ends close on exec, so the child holds only the copy made its standard output.
    let (mut read_end, write_end) = std::io::pipe().expect("the pipe opens");
    let child = spawn_own_root_child(
        &c_string(program.as_os_str()).expect("no NUL"),
        &arguments,
        &environment,
        Some(write_end.as_fd()),
    )
    .expect("the test starts as its own responsible process");
    drop(write_end);
    let mut output = String::new();
    read_end
        .read_to_string(&mut output)
        .expect("the child's output reads");
    let status = reap_spawned_child(child).expect("the child is reaped");
    (status.success(), output)
}

#[cfg(test)]
mod tests {
    use std::ffi::{CString, OsStr};
    use std::io::Write as _;

    use rstest::rstest;

    use super::{
        OwnRootStep, StartResponsibility, is_own_marker, own_root_step, read_own_root_step,
        read_responsible_id, rerun_test_as_own_root, spawn_own_root_child,
    };
    use crate::ResponsibleProcess;
    use crate::macos::caller_process::read_responsible_process;
    use crate::macos::pinned_process::pin_running_process;
    use crate::posix::spawn::end_spawned_child;
    use crate::test_program::this_test_program;

    /// What the stand-in started under an own-root instance of this program prints once it found
    /// it stays under that instance.
    const STAYS_UNDER: &str = "the start stays under this program";

    /// What the own-root instance of this program prints once its child's start went as expected.
    const INSTANCE_CHECKED: &str = "the own-root instance's child stayed under it";

    #[rstest]
    #[case::own_root(StartResponsibility::Itself, false, OwnRootStep::Start)]
    #[case::own_root_after_its_re_run(StartResponsibility::Itself, true, OwnRootStep::Start)]
    #[case::under_this_program(StartResponsibility::ThisProgram, false, OwnRootStep::StayUnder)]
    #[case::not_yet(StartResponsibility::Another, false, OwnRootStep::ReRun)]
    #[case::still_not_after_its_re_run(
        StartResponsibility::Another,
        true,
        OwnRootStep::StillNotRoot
    )]
    fn the_start_re_runs_once_at_most(
        #[case] responsibility: StartResponsibility,
        #[case] has_re_run: bool,
        #[case] expected: OwnRootStep,
    ) {
        assert_eq!(own_root_step(responsibility, has_re_run), expected);
    }

    #[test]
    #[ignore = "the second daemon's stand-in, which the own-root instance starts as its child"]
    fn the_start_under_an_own_root_instance_of_this_program_stays_under_it() {
        let own_id = std::process::id();
        assert_eq!(
            read_own_root_step(own_id, false).expect("the step reads"),
            OwnRootStep::StayUnder
        );
        writeln!(std::io::stdout(), "{STAYS_UNDER}").expect("the stand-in writes its output");
    }

    #[test]
    #[ignore = "the daemon's stand-in, which the test starts as its own responsible process"]
    fn an_own_root_instance_of_this_program_keeps_what_it_starts_under_it() {
        let own_id = std::process::id();
        assert_eq!(
            read_responsible_id(own_id).expect("the read answers"),
            Some(own_id),
            "the stand-in started as its own responsible process"
        );
        let child = this_test_program(concat!(
            "macos::responsibility::tests::",
            "the_start_under_an_own_root_instance_of_this_program_stays_under_it",
        ))
        .output()
        .expect("the child runs");
        assert!(
            child.status.success() && String::from_utf8_lossy(&child.stdout).contains(STAYS_UNDER),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        writeln!(std::io::stdout(), "{INSTANCE_CHECKED}").expect("the stand-in writes its output");
    }

    #[test]
    fn a_start_stays_under_this_program_and_re_runs_under_any_other() {
        // The test's own responsible process runs another program, as the person's terminal or
        // the desktop does for a daemon they start.
        assert_eq!(
            read_own_root_step(std::process::id(), false).expect("the step reads"),
            OwnRootStep::ReRun
        );
        let (has_passed, output) = rerun_test_as_own_root(concat!(
            "macos::responsibility::tests::",
            "an_own_root_instance_of_this_program_keeps_what_it_starts_under_it",
        ));
        assert!(has_passed && output.contains(INSTANCE_CHECKED), "{output}");
    }

    #[rstest]
    #[case::none(None, false)]
    #[case::set_by_this_process(Some("4242"), true)]
    #[case::inherited_from_another_process(Some("17"), false)]
    #[case::not_a_process_id(Some("yes"), false)]
    fn only_the_marker_this_process_set_counts_as_its_re_run(
        #[case] marker: Option<&str>,
        #[case] is_own: bool,
    ) {
        assert_eq!(is_own_marker(marker.map(OsStr::new), 4242), is_own);
    }

    #[test]
    fn a_program_started_as_its_own_root_is_responsible_for_itself() {
        // The spawn answers once the child runs `sleep`.
        let child_id = spawn_own_root_child(
            c"/bin/sleep",
            &[CString::from(c"sleep"), CString::from(c"30")],
            &[],
            None,
        )
        .expect("the child starts as its own responsible process");
        let process = pin_running_process(child_id)
            .expect("the child reads")
            .expect("the child runs");
        assert_eq!(
            read_responsible_id(child_id).expect("the read answers"),
            Some(child_id)
        );
        assert!(matches!(
            read_responsible_process(&process).expect("the read answers"),
            ResponsibleProcess::Itself
        ));
        end_spawned_child(child_id).expect("the child ends and is reaped");

        // A child started plainly reads the test's own responsible process, never itself.
        let mut plain = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("the plain child starts");
        let plain_process = pin_running_process(plain.id())
            .expect("the plain child reads")
            .expect("the plain child runs");
        let own_responsible = read_responsible_id(std::process::id())
            .expect("the test reads its own")
            .expect("the test runs");
        assert_eq!(
            read_responsible_id(plain.id()).expect("the read answers"),
            Some(own_responsible)
        );
        let plain_responsible = read_responsible_process(&plain_process).expect("the read answers");
        assert!(
            !matches!(plain_responsible, ResponsibleProcess::Itself),
            "a plain child inherits its starter's responsible process"
        );
        plain.kill().expect("the plain child ends");
        plain.wait().expect("the plain child is reaped");
        // A reaped process is gone: no read names whatever takes its id next.
        assert!(matches!(
            read_responsible_process(&plain_process).expect("the read answers"),
            ResponsibleProcess::Ended
        ));
    }
}
