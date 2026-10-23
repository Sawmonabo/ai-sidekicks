//! Whether a command waits on its terminal's input, as macOS shows it: the foreground group's
//! descriptors, threads and knotes through `proc_pidinfo` and `proc_pidfdinfo`, then where each
//! reader's threads wait through Apple's `sample`, since macOS copies a thread's wait reason out to
//! no other process. A thread's run state only rules a wait out; it never shows one.

use std::io::{self, ErrorKind};
use std::process::{Command, Output, Stdio};

use libc::{c_int, c_void};
use nix::errno::Errno;

use crate::input_wait::{InputTerminal, InputWaitReading};
use crate::macos::processes::list_group_process_ids;
use crate::posix::process::id::system_process_id;

// `<sys/proc_info.h>`'s flavors and flags `libc` does not bind, and the private ones Apple's own
// tools read, which `<sys/proc_info_private.h>` defines.
const PROC_PIDLISTTHREADS: c_int = 6;
const PROC_PIDLISTDYNKQUEUES: c_int = 27;
const PROC_PIDFDVNODEINFO: c_int = 1;
const PROC_PIDFDPIPEINFO: c_int = 6;
const PROC_PIDFDKQUEUE_EXTINFO: c_int = 9;
const PROC_PIDDYNKQUEUE_EXTINFO: c_int = 1;

// `<sys/fcntl.h>`'s `FREAD`: a descriptor open for reading.
const FREAD: u32 = 0x0001;

// `<sys/pipe.h>`'s `PIPE_WANTR`: a reader sleeps on the pipe, or a timed-out read left it set.
const PIPE_WANTR: c_int = 0x0008;

// The descriptor `PROC_PIDFDKQUEUE_EXTINFO` reads the process's work-queue kqueue through.
const WORK_QUEUE_KQUEUE: c_int = -1;

// Apple's sampler, which reads a process of the same user through the task-read right its own
// signature grants it, and how long and how often it samples.
const SAMPLE_PROGRAM: &str = "/usr/bin/sample";
const SAMPLE_SECONDS: &str = "0.1";
const SAMPLE_INTERVAL_MILLISECONDS: &str = "10";

// The process state reader that runs as root, which shows a process of another user, and the
// status it exits with when a process it was asked for is missing.
const PS_PROGRAM: &str = "/bin/ps";
const PS_ANY_MISSING_STATUS: i32 = 1;

// The calls a thread blocked reading a descriptor shows innermost.
const READ_CALLS: [&str; 3] = ["read", "__read_nocancel", "readv"];

// The calls a thread blocked on a kqueue shows innermost.
const KEVENT_CALLS: [&str; 4] = ["kevent", "kevent64", "kevent_qos", "kevent_id"];

// `struct proc_fileinfo`.
#[repr(C)]
struct ProcFileInfo {
    fi_openflags: u32,
    _fi_status: u32,
    _fi_offset: i64,
    _fi_type: i32,
    _fi_guardflags: u32,
}

// `struct vnode_fdinfo`.
#[repr(C)]
struct VnodeFdInfo {
    pfi: ProcFileInfo,
    pvi: libc::vnode_info,
}

// `struct pipe_info`.
#[repr(C)]
struct PipeInfo {
    _pipe_stat: libc::vinfo_stat,
    _pipe_handle: u64,
    _pipe_peerhandle: u64,
    pipe_status: c_int,
    _rfu_1: c_int,
}

// `struct pipe_fdinfo`.
#[repr(C)]
struct PipeFdInfo {
    pfi: ProcFileInfo,
    pipeinfo: PipeInfo,
}

// The private `struct kevent_qos_s`.
#[repr(C)]
#[derive(Clone, Copy)]
struct KeventQos {
    ident: u64,
    filter: i16,
    _flags: u16,
    _qos: i32,
    _udata: u64,
    _fflags: u32,
    _xflags: u32,
    _data: i64,
    _ext: [u64; 4],
}

// The private `struct kevent_extinfo`, one knote.
#[repr(C)]
#[derive(Clone, Copy)]
struct KeventExtinfo {
    kqext_kev: KeventQos,
    _kqext_sdata: u64,
    _kqext_status: c_int,
    _kqext_sfflags: c_int,
    _kqext_reserved: [u64; 2],
}

// The entries a list's first read makes room for, doubled while the list does not fit.
const LIST_START_LENGTH: usize = 64;

unsafe extern "C" {
    // libproc's reader of a work-loop kqueue, which its public header does not declare.
    fn proc_piddynkqueueinfo(
        pid: c_int,
        flavor: c_int,
        kq_id: u64,
        buffer: *mut c_void,
        buffersize: c_int,
    ) -> c_int;
}

/// Whether the terminal's foreground group waits on `terminal`'s input, takes input, and has echo
/// off: the reads [`may_wait_for_input`] makes, then `sample` on each process holding the terminal
/// for reading, whose thread waits when its innermost call is a read and the process holds no
/// socket and no pipe a reader sleeps on, or a `kevent` and the process holds a read knote on the
/// terminal. A group macOS refuses to show, as `sudo`'s, waits when the terminal has canonical
/// input on and echo off, nothing is queued and `ps` shows a member left and none running. A reader
/// that ends before `sample` reads it does not wait. Blocks for about a tenth of a second per
/// reader sampled; fails with the system's error when a read is refused for a process this user may
/// read, with `sample`'s or `ps`'s own error text when either fails on a process still there, and
/// with `InvalidData` when `sample`'s report has no call graph.
pub fn read_input_wait(terminal: &InputTerminal) -> io::Result<InputWaitReading> {
    let survey = survey_group(terminal)?;
    let is_waiting = match &survey.wait {
        GroupWait::RuledOut => false,
        GroupWait::Password => true,
        GroupWait::Readers(readers) => {
            let mut is_waiting = false;
            for reader in readers {
                if reader_waits(reader)? {
                    is_waiting = true;
                    break;
                }
            }
            is_waiting
        }
    };
    Ok(InputWaitReading {
        is_waiting,
        accepts_input: survey.accepts_input,
        is_echo_off: !terminal.master.is_echo_on,
        is_password_prompt: terminal.master.is_password_prompt(),
    })
}

/// Whether the terminal's foreground group may wait on `terminal`'s input, read without `sample`:
/// no input is queued, no thread of the group runs, and a process of it holds the terminal for
/// reading, or a group macOS refuses to show waits on a password. Blocks on the reads; fails with
/// the system's error when a read is refused for a process this user may read.
pub fn may_wait_for_input(terminal: &InputTerminal) -> io::Result<bool> {
    Ok(!matches!(survey_group(terminal)?.wait, GroupWait::RuledOut))
}

// What the reads without `sample` show of the foreground group.
struct GroupSurvey {
    accepts_input: bool,
    wait: GroupWait,
}

// Whether the foreground group may wait on the terminal.
enum GroupWait {
    // Input is queued, a thread runs, or nothing holds the terminal for reading.
    RuledOut,
    // A group macOS refuses to show sits at a prompt with echo off.
    Password,
    // The processes holding the terminal for reading, whose threads `sample` reads.
    Readers(Vec<Reader>),
}

// One process of the foreground group holding the terminal for reading.
struct Reader {
    process_id: u32,
    descriptors: ProcessDescriptors,
}

// What one process's descriptors show.
#[derive(Default)]
struct ProcessDescriptors {
    // The descriptors open for reading on the terminal.
    terminal_reads: Vec<c_int>,
    // Whether a socket is open, whose read a blocked read may be.
    holds_socket: bool,
    // Whether a pipe open for reading has a reader sleeping on it, whose read a blocked read may
    // be.
    holds_awaited_pipe: bool,
    // The kqueue descriptors, whose knotes a blocked `kevent` waits on.
    kqueues: Vec<c_int>,
}

// What one process of the group showed.
enum ProcessSurvey {
    // It ended while it was read.
    Gone,
    // macOS refused to show it: another user runs it.
    Refused,
    Read {
        descriptors: ProcessDescriptors,
        is_running: bool,
    },
}

// The reads without `sample` of the terminal's foreground group.
fn survey_group(terminal: &InputTerminal) -> io::Result<GroupSurvey> {
    let mut readers = Vec::new();
    let mut refused = Vec::new();
    let mut is_running = false;
    for process_id in list_group_process_ids(terminal.master.foreground_group)? {
        match survey_process(process_id, terminal)? {
            ProcessSurvey::Gone => {}
            ProcessSurvey::Refused => refused.push(process_id),
            ProcessSurvey::Read {
                descriptors,
                is_running: is_process_running,
            } => {
                is_running |= is_process_running;
                if !descriptors.terminal_reads.is_empty() {
                    readers.push(Reader {
                        process_id,
                        descriptors,
                    });
                }
            }
        }
    }
    let accepts_input = !readers.is_empty();
    if is_running || terminal.master.queued_bytes > 0 {
        return Ok(GroupSurvey {
            accepts_input,
            wait: GroupWait::RuledOut,
        });
    }
    if !readers.is_empty() {
        return Ok(GroupSurvey {
            accepts_input,
            wait: GroupWait::Readers(readers),
        });
    }
    let is_password_wait = !refused.is_empty()
        && terminal.master.is_password_prompt()
        && is_any_running_by_ps(&refused)? == Some(false);
    Ok(GroupSurvey {
        accepts_input: is_password_wait,
        wait: if is_password_wait {
            GroupWait::Password
        } else {
            GroupWait::RuledOut
        },
    })
}

// What process `process_id` shows of its descriptors and threads.
fn survey_process(process_id: u32, terminal: &InputTerminal) -> io::Result<ProcessSurvey> {
    let pid = system_process_id(process_id)?.get();
    let descriptors = match read_descriptors(pid, terminal) {
        Ok(descriptors) => descriptors,
        Err(error) => return refusal_survey(error),
    };
    let is_running = match is_any_thread_running(pid) {
        Ok(is_running) => is_running,
        Err(error) => return refusal_survey(error),
    };
    Ok(ProcessSurvey::Read {
        descriptors,
        is_running,
    })
}

// A read's failure as what it says of the process: gone, refused, or a failure to surface.
fn refusal_survey(error: io::Error) -> io::Result<ProcessSurvey> {
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(ProcessSurvey::Gone),
        Some(libc::EPERM | libc::EACCES) => Ok(ProcessSurvey::Refused),
        _ => Err(error),
    }
}

// The descriptors of process `pid` that bear on a wait on `terminal`.
fn read_descriptors(pid: c_int, terminal: &InputTerminal) -> io::Result<ProcessDescriptors> {
    let listed: Vec<libc::proc_fdinfo> = read_pid_list(pid, libc::PROC_PIDLISTFDS)?;
    let mut descriptors = ProcessDescriptors::default();
    for entry in listed {
        let descriptor = entry.proc_fd;
        match c_int::try_from(entry.proc_fdtype).unwrap_or(-1) {
            libc::PROX_FDTYPE_VNODE => {
                let Some(info) = read_fd_info::<VnodeFdInfo>(pid, descriptor, PROC_PIDFDVNODEINFO)?
                else {
                    continue;
                };
                let stat = &info.pvi.vi_stat;
                let is_character_device =
                    libc::mode_t::from(stat.vst_mode) & libc::S_IFMT == libc::S_IFCHR;
                if is_character_device
                    && u64::from(stat.vst_rdev) == terminal.device.0
                    && info.pfi.fi_openflags & FREAD != 0
                {
                    descriptors.terminal_reads.push(descriptor);
                }
            }
            libc::PROX_FDTYPE_SOCKET => descriptors.holds_socket = true,
            libc::PROX_FDTYPE_PIPE => {
                let Some(info) = read_fd_info::<PipeFdInfo>(pid, descriptor, PROC_PIDFDPIPEINFO)?
                else {
                    continue;
                };
                if info.pfi.fi_openflags & FREAD != 0 && info.pipeinfo.pipe_status & PIPE_WANTR != 0
                {
                    descriptors.holds_awaited_pipe = true;
                }
            }
            libc::PROX_FDTYPE_KQUEUE => descriptors.kqueues.push(descriptor),
            _ => {}
        }
    }
    Ok(descriptors)
}

// Whether a thread of process `pid` is running now.
fn is_any_thread_running(pid: c_int) -> io::Result<bool> {
    let thread_ids: Vec<u64> = read_pid_list(pid, PROC_PIDLISTTHREADS)?;
    for thread_id in thread_ids {
        // SAFETY: `proc_threadinfo` is a C struct of integers and characters, for which all zero
        // bytes are valid.
        let mut info: libc::proc_threadinfo = unsafe { std::mem::zeroed() };
        let length =
            c_int::try_from(size_of::<libc::proc_threadinfo>()).map_err(io::Error::other)?;
        // SAFETY: the pointer names a live `proc_threadinfo` of `length` bytes, the struct this
        // flavor fills, and nothing else reads it until the call returns.
        let written = read_libproc_count(|| unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTHREADINFO,
                thread_id,
                (&raw mut info).cast(),
                length,
            )
        });
        match written {
            // A thread that ended since the listing is no longer running.
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
            Err(error) => return Err(error),
            Ok(_) if info.pth_run_state == libc::TH_STATE_RUNNING => return Ok(true),
            Ok(_) => {}
        }
    }
    Ok(false)
}

// Whether `ps`, which runs as root, shows any of `process_ids` running; `None` when it shows none
// of them, since every one ended. `ps` exits 1 when any is missing and still lists the rest.
fn is_any_running_by_ps(process_ids: &[u32]) -> io::Result<Option<bool>> {
    let listed = process_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let output = Command::new(PS_PROGRAM)
        .args(["-o", "stat=", "-p", &listed])
        .stdin(Stdio::null())
        .output()?;
    let states = String::from_utf8_lossy(&output.stdout);
    match output.status.code() {
        Some(0 | PS_ANY_MISSING_STATUS) => {}
        _ => return Err(program_failure("ps", &listed, &output)),
    }
    if states.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(
        states
            .lines()
            .any(|state| state.trim_start().starts_with('R')),
    ))
}

// Whether a thread of `reader` waits on the terminal, read through `sample`; a reader that ended
// before `sample` read it waits on nothing.
fn reader_waits(reader: &Reader) -> io::Result<bool> {
    let Some(innermost_calls) = sample_innermost_calls(reader.process_id)? else {
        return Ok(false);
    };
    let is_read_wait = innermost_calls
        .iter()
        .any(|calls| calls.iter().all(|call| READ_CALLS.contains(&call.as_str())));
    if is_read_wait && !reader.descriptors.holds_socket && !reader.descriptors.holds_awaited_pipe {
        return Ok(true);
    }
    let is_kevent_wait = innermost_calls.iter().any(|calls| {
        calls
            .iter()
            .all(|call| KEVENT_CALLS.contains(&call.as_str()))
    });
    if !is_kevent_wait {
        return Ok(false);
    }
    let pid = system_process_id(reader.process_id)?.get();
    holds_terminal_read_knote(pid, &reader.descriptors)
}

// Whether a kqueue of process `pid`, its work-queue kqueue or one of its work-loop kqueues holds a
// read knote on one of its descriptors of the terminal.
fn holds_terminal_read_knote(pid: c_int, descriptors: &ProcessDescriptors) -> io::Result<bool> {
    let is_terminal_read = |knote: &KeventExtinfo| {
        knote.kqext_kev.filter == libc::EVFILT_READ
            && c_int::try_from(knote.kqext_kev.ident)
                .is_ok_and(|descriptor| descriptors.terminal_reads.contains(&descriptor))
    };
    for kqueue in descriptors
        .kqueues
        .iter()
        .copied()
        .chain([WORK_QUEUE_KQUEUE])
    {
        let knotes = read_counted_list::<KeventExtinfo>(|buffer, length| {
            // SAFETY: the buffer is live and `length` bytes long, sized for whole knotes, and
            // nothing else reads it until the call returns.
            unsafe { libc::proc_pidfdinfo(pid, kqueue, PROC_PIDFDKQUEUE_EXTINFO, buffer, length) }
        });
        if gone_as_empty(knotes)?.iter().any(is_terminal_read) {
            return Ok(true);
        }
    }
    let work_loops = read_counted_list::<u64>(|buffer, length| {
        // SAFETY: the buffer is live and `length` bytes long, sized for whole ids, and nothing else
        // reads it until the call returns.
        unsafe { libc::proc_pidinfo(pid, PROC_PIDLISTDYNKQUEUES, 0, buffer, length) }
    })?;
    for work_loop in work_loops {
        let knotes = read_counted_list::<KeventExtinfo>(|buffer, length| {
            // SAFETY: the buffer is live and `length` bytes long, sized for whole knotes, and
            // nothing else reads it until the call returns.
            unsafe {
                proc_piddynkqueueinfo(pid, PROC_PIDDYNKQUEUE_EXTINFO, work_loop, buffer, length)
            }
        });
        if gone_as_empty(knotes)?.iter().any(is_terminal_read) {
            return Ok(true);
        }
    }
    Ok(false)
}

// A kqueue's knotes, none when the kqueue closed or its process ended since its listing.
fn gone_as_empty(knotes: io::Result<Vec<KeventExtinfo>>) -> io::Result<Vec<KeventExtinfo>> {
    match knotes {
        Err(error) if matches!(error.raw_os_error(), Some(libc::EBADF | libc::ESRCH)) => {
            Ok(Vec::new())
        }
        knotes => knotes,
    }
}

// The list `proc_pidinfo` answers in bytes for `flavor` of process `pid`, in entries of `T`.
fn read_pid_list<T>(pid: c_int, flavor: c_int) -> io::Result<Vec<T>> {
    read_list(ListLength::Bytes, |buffer, length| {
        // SAFETY: the buffer is live and `length` bytes long, sized for whole entries, and nothing
        // else reads it until the call returns.
        unsafe { libc::proc_pidinfo(pid, flavor, 0, buffer, length) }
    })
}

// A list whose call answers how many entries the kernel holds, which may be more than it wrote.
fn read_counted_list<T>(call: impl FnMut(*mut c_void, c_int) -> c_int) -> io::Result<Vec<T>> {
    read_list(ListLength::Count, call)
}

// What a list call's answer counts.
#[derive(Clone, Copy)]
enum ListLength {
    // The bytes it wrote, a full buffer meaning more may be left.
    Bytes,
    // The entries the kernel holds, written up to the buffer's room.
    Count,
}

// The entries of type `T` a libproc list call writes into a buffer it is given, the buffer grown
// until the whole list fits.
fn read_list<T>(
    length_kind: ListLength,
    mut call: impl FnMut(*mut c_void, c_int) -> c_int,
) -> io::Result<Vec<T>> {
    let mut capacity = LIST_START_LENGTH;
    loop {
        let mut entries = Vec::<T>::with_capacity(capacity);
        let length = c_int::try_from(capacity * size_of::<T>()).map_err(io::Error::other)?;
        let answered = read_libproc_count(|| call(entries.as_mut_ptr().cast(), length))?;
        let (written, is_whole) = match length_kind {
            ListLength::Bytes => (
                answered / size_of::<T>(),
                answered < capacity * size_of::<T>(),
            ),
            ListLength::Count => (answered, answered <= capacity),
        };
        if is_whole {
            // SAFETY: the call wrote `written` whole entries from the buffer's start, within its
            // capacity.
            unsafe { entries.set_len(written) };
            return Ok(entries);
        }
        capacity = written.max(capacity).saturating_mul(2);
    }
}

// What `proc_pidfdinfo` answers for `flavor` of descriptor `descriptor` of process `pid`; `None`
// when the descriptor was closed since its listing.
fn read_fd_info<T>(pid: c_int, descriptor: c_int, flavor: c_int) -> io::Result<Option<T>> {
    let mut info = std::mem::MaybeUninit::<T>::uninit();
    let length = c_int::try_from(size_of::<T>()).map_err(io::Error::other)?;
    // SAFETY: the pointer names a live `T` of `length` bytes, the struct this flavor fills, and
    // nothing else reads it until the call returns.
    let written = read_libproc_count(|| unsafe {
        libc::proc_pidfdinfo(pid, descriptor, flavor, info.as_mut_ptr().cast(), length)
    });
    match written {
        Ok(written) if written == size_of::<T>() => {
            // SAFETY: the call filled the whole struct.
            Ok(Some(unsafe { info.assume_init() }))
        }
        Ok(_) => Ok(None),
        Err(error) if error.raw_os_error() == Some(libc::EBADF) => Ok(None),
        Err(error) => Err(error),
    }
}

// Runs a libproc call answering a count, which answers 0 both when it fails and when it found
// nothing, so `errno`, cleared first, tells the two apart.
fn read_libproc_count(call: impl FnOnce() -> c_int) -> io::Result<usize> {
    Errno::clear();
    let count = call();
    match usize::try_from(count) {
        Ok(count) if count > 0 => Ok(count),
        _ => match Errno::last_raw() {
            0 => Ok(0),
            code => Err(io::Error::from_raw_os_error(code)),
        },
    }
}

// The innermost calls of each thread of process `process_id`, as one `sample` shows them; `None`
// when `sample` fails because the process ended.
fn sample_innermost_calls(process_id: u32) -> io::Result<Option<Vec<Vec<String>>>> {
    let output = Command::new(SAMPLE_PROGRAM)
        .args([
            &process_id.to_string(),
            SAMPLE_SECONDS,
            SAMPLE_INTERVAL_MILLISECONDS,
            // Written to standard output alone, so no report is left in the temporary folder.
            "-file",
            "/dev/stdout",
        ])
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success() {
        let pid = system_process_id(process_id)?.get();
        if is_gone(pid)? {
            return Ok(None);
        }
        return Err(program_failure("sample", &process_id.to_string(), &output));
    }
    innermost_calls_in(&String::from_utf8_lossy(&output.stdout)).map(Some)
}

// Whether process `pid` has ended, as [`survey_process`] reads an ended process.
fn is_gone(pid: c_int) -> io::Result<bool> {
    match read_pid_list::<u64>(pid, PROC_PIDLISTTHREADS) {
        Ok(_threads) => Ok(false),
        Err(error) => Ok(matches!(refusal_survey(error)?, ProcessSurvey::Gone)),
    }
}

// A program's failure on `processes`, with its status and the error text it wrote.
fn program_failure(program: &str, processes: &str, output: &Output) -> io::Error {
    io::Error::other(format!(
        "{program} could not read process {processes} ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

// The innermost calls of each thread of a `sample` report's call graph: the frames no deeper frame
// follows in the thread's tree. Fails with `InvalidData` when the report has no call graph.
fn innermost_calls_in(report: &str) -> io::Result<Vec<Vec<String>>> {
    let mut threads: Vec<Vec<String>> = Vec::new();
    let mut frames: Vec<(usize, String)> = Vec::new();
    let finish_thread = |frames: &mut Vec<(usize, String)>, threads: &mut Vec<Vec<String>>| {
        if frames.is_empty() {
            return;
        }
        let leaves = frames
            .iter()
            .enumerate()
            .filter(|(index, (depth, _name))| {
                frames
                    .get(index + 1)
                    .is_none_or(|(next_depth, _next_name)| next_depth <= depth)
            })
            .map(|(_index, (_depth, name))| name.clone())
            .collect();
        threads.push(leaves);
        frames.clear();
    };
    let Some((_before, call_graph)) = report.split_once("Call graph:") else {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "sample's report has no call graph",
        ));
    };
    // The first line is the rest of the heading's own line.
    for line in call_graph.lines().skip(1) {
        if line.trim().is_empty() {
            break;
        }
        let body = line.trim_start_matches([' ', '+', '|', '!', ':']);
        let depth = line.len() - body.len();
        let Some((_count, rest)) = body.split_once(' ') else {
            continue;
        };
        if rest.starts_with("Thread_") {
            finish_thread(&mut frames, &mut threads);
            continue;
        }
        let name = rest
            .split_once("  (in ")
            .map_or(rest, |(name, _place)| name);
        frames.push((depth, name.trim().to_owned()));
    }
    finish_thread(&mut frames, &mut threads);
    Ok(threads)
}

#[cfg(test)]
mod tests {
    use super::innermost_calls_in;

    // Fails when a frame some deeper frame follows is taken as innermost, or one thread's frames
    // run into the next thread's.
    #[test]
    fn a_sample_report_s_innermost_calls_are_read_per_thread() {
        let report = "Analysis of sampling cat (pid 1) every 10 milliseconds\n\
            Call graph:\n    \
            10 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)\n    \
            + 10 start  (in dyld) + 6688  [0x1]\n    \
            +   10 main  (in cat) + 100  [0x2]\n    \
            +     10 read  (in libsystem_kernel.dylib) + 8  [0x3]\n    \
            10 Thread_2\n    \
            + 6 thread_start  (in libsystem_pthread.dylib) + 8  [0x4]\n    \
            + ! 4 work  (in cat) + 1  [0x5]\n    \
            + ! : 4 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x6]\n    \
            + ! 2 kevent  (in libsystem_kernel.dylib) + 8  [0x7]\n\n\
            Total number in stack (recursive counted multiple, when >=5):\n";

        let threads = innermost_calls_in(report).expect("the report has a call graph");

        assert_eq!(
            threads,
            vec![
                vec!["read".to_owned()],
                vec!["__psynch_cvwait".to_owned(), "kevent".to_owned()],
            ]
        );
    }

    // Fails when a report with no call graph reads as threads waiting on nothing rather than as a
    // failure.
    #[test]
    fn a_sample_report_without_a_call_graph_is_refused() {
        let report = "Analysis of sampling cat (pid 1) every 10 milliseconds\n\
            Process:         cat [1]\n";

        assert!(innermost_calls_in(report).is_err());
    }
}
