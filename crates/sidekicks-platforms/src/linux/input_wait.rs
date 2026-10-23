//! Whether a command waits on its terminal's input, as Linux shows it under `/proc`: the system
//! call each thread of the terminal's foreground group is blocked in and its arguments, the
//! descriptors that call reads, and where the right to attach is refused, each thread's wait
//! channel or the terminal's own settings.

use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::os::unix::fs::{FileExt, FileTypeExt, MetadataExt};
use std::sync::Once;

use crate::input_wait::{InputTerminal, InputWaitReading};
use crate::terminal::TerminalDevice;

// The file Yama keeps its ptrace scope in; at 2 or 3 no reader may attach to a descendant.
const PTRACE_SCOPE_PATH: &str = "/proc/sys/kernel/yama/ptrace_scope";

// The lowest ptrace scope at which Yama refuses the `syscall` and `mem` reads to every reader.
const ADMIN_ONLY_PTRACE_SCOPE: u32 = 2;

// `<sys/epoll.h>`'s `EPOLLIN` and `<poll.h>`'s `POLLIN` and `POLLRDNORM`: a wait for input.
const EPOLLIN: u32 = 0x001;
const POLL_INPUT: i16 = 0x001 | 0x040;

// The wait channels a thread sleeps in while the terminal's line discipline waits for input, and
// while an epoll set waits.
const TERMINAL_WAIT_CHANNEL: &str = "wait_woken";
const EPOLL_WAIT_CHANNEL: &str = "do_epoll_wait";

// Names the weaker reading in the service log once, the first time Yama refuses the reads.
static WEAKER_READING_NOTED: Once = Once::new();

/// Whether the terminal's foreground group waits on `terminal`'s input, takes input, and has echo
/// off: no thread of the group runs, and a thread is blocked in `read`, `readv` or `pread64` on the
/// terminal, in an epoll wait on a set holding the terminal for input, or in `select`, `pselect6`,
/// `poll` or `ppoll` with the terminal in its read set. Where Yama refuses those reads, a thread
/// sleeping where the line discipline or an epoll wait sleeps counts instead; a program the daemon
/// may not attach to, as `sudo`, waits when the terminal has canonical input on and echo off and a
/// member sleeps. Blocks on the reads; fails with the system's error when `/proc` refuses a read
/// this user may make.
pub fn read_input_wait(terminal: &InputTerminal) -> io::Result<InputWaitReading> {
    let mut accepts_input = false;
    let mut is_running = false;
    let mut is_waiting = false;
    let mut is_any_refused_sleeping = false;
    let mut is_refused = false;
    for process_id in list_group_process_ids(terminal.master.foreground_group)? {
        let Some(process) = read_process(process_id, terminal.device)? else {
            continue;
        };
        accepts_input |= !process.terminal_reads.is_empty();
        for thread in &process.threads {
            is_running |= thread.state == 'R';
            match thread_wait(&process, thread, terminal)? {
                ThreadWait::OnTerminal => is_waiting = true,
                ThreadWait::Elsewhere => {}
                ThreadWait::Refused => {
                    is_refused = true;
                    is_any_refused_sleeping |= thread.state == 'S';
                }
            }
        }
    }
    let is_password_wait = is_refused
        && is_any_refused_sleeping
        && terminal.master.is_canonical
        && !terminal.master.is_echo_on;
    Ok(InputWaitReading {
        is_waiting: !is_running && (is_waiting || is_password_wait),
        accepts_input: accepts_input || is_password_wait,
        is_echo_off: !terminal.master.is_echo_on,
    })
}

/// Whether the terminal's foreground group may wait on `terminal`'s input, which on Linux is the
/// whole reading, since no read of it is slow. Blocks and fails as [`read_input_wait`] does.
pub fn may_wait_for_input(terminal: &InputTerminal) -> io::Result<bool> {
    Ok(read_input_wait(terminal)?.is_waiting)
}

// What one process of the group shows.
struct ProcessRead {
    process_id: u32,
    threads: Vec<ThreadRead>,
    // The descriptors open for reading on the terminal.
    terminal_reads: Vec<i32>,
    // The epoll sets, whose `fdinfo` lists what they wait on.
    epoll_sets: Vec<i32>,
    // Whether a socket, inotify or fanotify descriptor is open, a read of which sleeps where the
    // line discipline's does.
    holds_other_wait_source: bool,
}

// One thread of a process.
struct ThreadRead {
    thread_id: u32,
    // The state letter of its `stat`.
    state: char,
}

// Where one thread waits.
enum ThreadWait {
    OnTerminal,
    Elsewhere,
    // The kernel refused the reads that tell.
    Refused,
}

// The ids of the processes in group `group_id`, read from each process's `stat`; a process that
// ended during the walk is left out.
fn list_group_process_ids(group_id: u32) -> io::Result<Vec<u32>> {
    let mut process_ids = Vec::new();
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(process_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        if stat_field(&stat, 2).and_then(|group| group.parse().ok()) == Some(group_id) {
            process_ids.push(process_id);
        }
    }
    Ok(process_ids)
}

// Field `index` of a `stat` line counted from its state, field 0, which follows the command name's
// closing parenthesis, since the name may hold spaces and parentheses itself.
fn stat_field(stat: &str, index: usize) -> Option<&str> {
    stat.rsplit_once(')')?.1.split_whitespace().nth(index)
}

// What process `process_id` shows of its threads and descriptors; `None` when it ended.
fn read_process(process_id: u32, device: TerminalDevice) -> io::Result<Option<ProcessRead>> {
    let process_path = format!("/proc/{process_id}");
    let Some(stat) = read_if_present(&format!("{process_path}/stat"))? else {
        return Ok(None);
    };
    let controlling_terminal = stat_field(&stat, 4).and_then(|field| field.parse::<i64>().ok());
    let mut threads = Vec::new();
    for entry in read_dir_if_present(&format!("{process_path}/task"))? {
        let Some(thread_id) = entry.to_str().and_then(|name| name.parse::<u32>().ok()) else {
            continue;
        };
        let Some(thread_stat) = read_if_present(&format!("{process_path}/task/{thread_id}/stat"))?
        else {
            continue;
        };
        let state = stat_field(&thread_stat, 0)
            .and_then(|state| state.chars().next())
            .unwrap_or('?');
        threads.push(ThreadRead { thread_id, state });
    }
    let mut process = ProcessRead {
        process_id,
        threads,
        terminal_reads: Vec::new(),
        epoll_sets: Vec::new(),
        holds_other_wait_source: false,
    };
    let descriptors = match fs::read_dir(format!("{process_path}/fd")) {
        Ok(descriptors) => descriptors,
        // Another user's process shows no descriptors; its threads' reads are refused too.
        Err(error) if is_refusal(&error) || error.kind() == ErrorKind::NotFound => {
            return Ok(Some(process));
        }
        Err(error) => return Err(error),
    };
    for entry in descriptors {
        let entry = entry?;
        let Some(descriptor) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse().ok())
        else {
            continue;
        };
        let Ok(target) = fs::read_link(entry.path()) else {
            continue;
        };
        let target = target.to_string_lossy();
        if target.starts_with("socket:")
            || target == "anon_inode:inotify"
            || target == "anon_inode:[fanotify]"
        {
            process.holds_other_wait_source = true;
        } else if target == "anon_inode:[eventpoll]" {
            process.epoll_sets.push(descriptor);
        } else if is_terminal_descriptor(&entry.path(), &target, controlling_terminal, device)
            && is_open_for_reading(process_id, descriptor)?
        {
            process.terminal_reads.push(descriptor);
        }
    }
    Ok(Some(process))
}

// Whether the descriptor at `path`, open on `target`, is the terminal: a character device of its
// device number, or `/dev/tty` in a process whose controlling terminal it is.
fn is_terminal_descriptor(
    path: &std::path::Path,
    target: &str,
    controlling_terminal: Option<i64>,
    device: TerminalDevice,
) -> bool {
    if target == "/dev/tty" {
        return controlling_terminal == Some(old_device_encoding(device));
    }
    fs::metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_char_device() && metadata.rdev() == device.0)
}

// A device number in the old encoding `stat`'s `tty_nr` field writes it in.
fn old_device_encoding(device: TerminalDevice) -> i64 {
    let major = i64::from(libc::major(device.0));
    let minor = i64::from(libc::minor(device.0));
    (minor & 0xff) | (major << 8) | ((minor & !0xff) << 12)
}

// Whether descriptor `descriptor` of process `process_id` was opened for reading, from the access
// mode in its `fdinfo` flags.
fn is_open_for_reading(process_id: u32, descriptor: i32) -> io::Result<bool> {
    let Some(info) = read_if_present(&format!("/proc/{process_id}/fdinfo/{descriptor}"))? else {
        return Ok(false);
    };
    let flags = info
        .lines()
        .find_map(|line| line.strip_prefix("flags:"))
        .and_then(|flags| i32::from_str_radix(flags.trim(), 8).ok())
        .unwrap_or(libc::O_WRONLY);
    Ok(matches!(
        flags & libc::O_ACCMODE,
        libc::O_RDONLY | libc::O_RDWR
    ))
}

// Where `thread` of `process` waits.
fn thread_wait(
    process: &ProcessRead,
    thread: &ThreadRead,
    terminal: &InputTerminal,
) -> io::Result<ThreadWait> {
    let task_path = format!("/proc/{}/task/{}", process.process_id, thread.thread_id);
    let call = match fs::read_to_string(format!("{task_path}/syscall")) {
        Ok(call) => call,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(ThreadWait::Elsewhere),
        Err(error) if is_refusal(&error) => {
            return if is_ptrace_admin_only()? {
                note_weaker_reading();
                wait_channel_wait(process, thread, &task_path, terminal)
            } else {
                Ok(ThreadWait::Refused)
            };
        }
        Err(error) => return Err(error),
    };
    let mut fields = call.split_whitespace();
    let Some(number) = fields
        .next()
        .and_then(|number| number.parse::<libc::c_long>().ok())
    else {
        // `running`, or a thread not in a system call.
        return Ok(ThreadWait::Elsewhere);
    };
    let arguments: Vec<u64> = fields
        .take(6)
        .filter_map(|argument| u64::from_str_radix(argument.trim_start_matches("0x"), 16).ok())
        .collect();
    let [first, second, ..] = arguments.as_slice() else {
        return Ok(ThreadWait::Elsewhere);
    };
    let is_on_terminal = match system_call(number) {
        Some(SystemCall::Read) => process.terminal_reads.contains(&descriptor_of(*first)),
        Some(SystemCall::EpollWait) => epoll_set_waits_on_terminal(process, descriptor_of(*first))?,
        Some(SystemCall::Select) => select_reads_terminal(process, *first, *second)?,
        Some(SystemCall::Poll) => poll_reads_terminal(process, *first, *second)?,
        None => false,
    };
    Ok(if is_on_terminal {
        ThreadWait::OnTerminal
    } else {
        ThreadWait::Elsewhere
    })
}

// The kinds of system call a terminal's reader blocks in.
enum SystemCall {
    // `read`, `readv` or `pread64`, whose first argument is the descriptor.
    Read,
    // An epoll wait, whose first argument is the set's descriptor.
    EpollWait,
    // `select` or `pselect6`: the descriptor count, then the read set's address.
    Select,
    // `poll` or `ppoll`: the descriptors' address, then their count.
    Poll,
}

// The kind of system call `number` is on this processor; `restart_syscall` and every other call
// read as none, since a resumed `poll` shows no descriptor set.
fn system_call(number: libc::c_long) -> Option<SystemCall> {
    match number {
        libc::SYS_read | libc::SYS_readv | libc::SYS_pread64 => Some(SystemCall::Read),
        libc::SYS_epoll_pwait | libc::SYS_epoll_pwait2 => Some(SystemCall::EpollWait),
        libc::SYS_pselect6 => Some(SystemCall::Select),
        libc::SYS_ppoll => Some(SystemCall::Poll),
        #[cfg(target_arch = "x86_64")]
        libc::SYS_epoll_wait => Some(SystemCall::EpollWait),
        #[cfg(target_arch = "x86_64")]
        libc::SYS_select => Some(SystemCall::Select),
        #[cfg(target_arch = "x86_64")]
        libc::SYS_poll => Some(SystemCall::Poll),
        _ => None,
    }
}

// A system call argument as the descriptor it names; one past `i32` names none.
fn descriptor_of(argument: u64) -> i32 {
    i32::try_from(argument).unwrap_or(-1)
}

// Whether epoll set `epoll_set` of `process` waits for input on one of its descriptors of the
// terminal, as the set's `fdinfo` lists its targets.
fn epoll_set_waits_on_terminal(process: &ProcessRead, epoll_set: i32) -> io::Result<bool> {
    if !process.epoll_sets.contains(&epoll_set) {
        return Ok(false);
    }
    let Some(info) = read_if_present(&format!("/proc/{}/fdinfo/{epoll_set}", process.process_id))?
    else {
        return Ok(false);
    };
    Ok(info.lines().any(|line| {
        let mut fields = line.split_whitespace();
        let (Some("tfd:"), Some(target), Some("events:"), Some(events)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return false;
        };
        target
            .parse()
            .is_ok_and(|target: i32| process.terminal_reads.contains(&target))
            && u32::from_str_radix(events, 16).is_ok_and(|events| events & EPOLLIN != 0)
    }))
}

// Whether a `select` over `descriptor_count` descriptors with its read set at `read_set` in
// `process`'s memory holds one of its descriptors of the terminal.
fn select_reads_terminal(
    process: &ProcessRead,
    descriptor_count: u64,
    read_set: u64,
) -> io::Result<bool> {
    let Ok(descriptor_count) = usize::try_from(descriptor_count) else {
        return Ok(false);
    };
    if read_set == 0 || descriptor_count == 0 {
        return Ok(false);
    }
    // The set is an array of 64-bit words, one bit per descriptor.
    let mut words = vec![0_u8; descriptor_count.div_ceil(64) * 8];
    if !read_memory(process.process_id, read_set, &mut words)? {
        return Ok(false);
    }
    Ok(process.terminal_reads.iter().any(|descriptor| {
        usize::try_from(*descriptor).is_ok_and(|descriptor| {
            descriptor < descriptor_count
                && words
                    .get(descriptor / 8)
                    .is_some_and(|byte| byte & (1 << (descriptor % 8)) != 0)
        })
    }))
}

// Whether a `poll` over the `count` `pollfd` entries at `entries` in `process`'s memory waits for
// input on one of its descriptors of the terminal.
fn poll_reads_terminal(process: &ProcessRead, entries: u64, count: u64) -> io::Result<bool> {
    // `struct pollfd`: a 32-bit descriptor, then 16-bit requested and returned events.
    const ENTRY_BYTES: usize = 8;
    let Ok(count) = usize::try_from(count) else {
        return Ok(false);
    };
    if entries == 0 || count == 0 {
        return Ok(false);
    }
    let mut bytes = vec![0_u8; count.saturating_mul(ENTRY_BYTES)];
    if !read_memory(process.process_id, entries, &mut bytes)? {
        return Ok(false);
    }
    let (entries, _rest) = bytes.as_chunks::<ENTRY_BYTES>();
    Ok(entries.iter().any(|entry| {
        let descriptor = i32::from_ne_bytes([entry[0], entry[1], entry[2], entry[3]]);
        let events = i16::from_ne_bytes([entry[4], entry[5]]);
        events & POLL_INPUT != 0 && process.terminal_reads.contains(&descriptor)
    }))
}

// Fills `bytes` from `process_id`'s memory at `address`, answering whether the memory was there;
// fails with the system's error when the read is refused.
fn read_memory(process_id: u32, address: u64, bytes: &mut [u8]) -> io::Result<bool> {
    let memory = match File::open(format!("/proc/{process_id}/mem")) {
        Ok(memory) => memory,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    match memory.read_exact_at(bytes, address) {
        Ok(()) => Ok(true),
        // An address the call's arguments name but the process no longer maps.
        Err(error) if matches!(error.raw_os_error(), Some(libc::EIO | libc::EFAULT)) => Ok(false),
        Err(error) => Err(error),
    }
}

// Where `thread` waits, read from its wait channel where Yama refuses its system call: in the line
// discipline's sleep while its process holds the terminal for reading, no other source that sleeps
// there and the master holds no unread output, so it is no writer; or in an epoll wait on a set
// holding the terminal for input.
fn wait_channel_wait(
    process: &ProcessRead,
    thread: &ThreadRead,
    task_path: &str,
    terminal: &InputTerminal,
) -> io::Result<ThreadWait> {
    let Some(channel) = read_if_present(&format!("{task_path}/wchan"))? else {
        return Ok(ThreadWait::Elsewhere);
    };
    let channel = channel.trim();
    let is_on_terminal = if thread.state != 'S' {
        false
    } else if channel == TERMINAL_WAIT_CHANNEL {
        !process.terminal_reads.is_empty()
            && !process.holds_other_wait_source
            && terminal.master.queued_bytes == 0
    } else if channel == EPOLL_WAIT_CHANNEL {
        let mut is_on_terminal = false;
        for epoll_set in &process.epoll_sets {
            is_on_terminal |= epoll_set_waits_on_terminal(process, *epoll_set)?;
        }
        is_on_terminal
    } else {
        false
    };
    Ok(if is_on_terminal {
        ThreadWait::OnTerminal
    } else {
        ThreadWait::Elsewhere
    })
}

// Whether Yama refuses the system-call and memory reads to every reader without the capability.
fn is_ptrace_admin_only() -> io::Result<bool> {
    Ok(read_if_present(PTRACE_SCOPE_PATH)?
        .and_then(|scope| scope.trim().parse::<u32>().ok())
        .is_some_and(|scope| scope >= ADMIN_ONLY_PTRACE_SCOPE))
}

fn note_weaker_reading() {
    WEAKER_READING_NOTED.call_once(|| {
        tracing::info!(
            "input waits are read from wait channels, since the kernel's ptrace scope refuses \
             system call reads"
        );
    });
}

// Whether `error` is the kernel refusing a read this user has no right to.
fn is_refusal(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::EACCES | libc::EPERM))
}

// The text of the file at `path`, or `None` when it is gone, as a file of an ended process is.
fn read_if_present(path: &str) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => Ok(None),
        Err(error) => Err(error),
    }
}

// The entry names of the folder at `path`, none when it is gone.
fn read_dir_if_present(path: &str) -> io::Result<Vec<std::ffi::OsString>> {
    match fs::read_dir(path) {
        Ok(entries) => entries
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect(),
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => {
            Ok(Vec::new())
        }
        Err(error) => Err(error),
    }
}
