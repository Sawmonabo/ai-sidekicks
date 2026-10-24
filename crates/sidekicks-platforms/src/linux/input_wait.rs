//! Whether a command waits on its terminal's input, as Linux shows it under `/proc`: the system
//! call each thread of the terminal's foreground group is blocked in and its arguments, the
//! descriptors that call reads, and where the right to attach is refused, each thread's wait
//! channel or the terminal's own settings.

use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{FileExt, FileTypeExt, MetadataExt};
use std::path::Path;
use std::sync::Once;

use crate::input_wait::{InputTerminal, InputWaitReading};
use crate::linux::input_wait::group::{GroupMember, list_group_members};
use crate::linux::{is_gone, read_process_file, read_process_stat_fields};
use crate::posix::terminal::read_queued_bytes;
use crate::spawner::Spawner;
use crate::terminal::TerminalDevice;

mod group;

// The field of a `stat` file, numbered as proc(5) numbers them, that holds a thread's state
// letter.
const STATE_FIELD: usize = 3;

// The file Yama keeps its ptrace scope in; at 2 or 3 no reader may attach to a descendant.
const PTRACE_SCOPE_PATH: &str = "/proc/sys/kernel/yama/ptrace_scope";

// The lowest ptrace scope at which Yama refuses the `syscall` and `mem` reads to every reader.
const ADMIN_ONLY_PTRACE_SCOPE: u32 = 2;

// `<sys/epoll.h>`'s `EPOLLIN` and `<poll.h>`'s `POLLIN` and `POLLRDNORM`: a wait for input.
const EPOLLIN: u32 = 0x001;
const POLL_INPUT: i16 = 0x001 | 0x040;

// The most `pollfd` entries a `poll`'s set is read for, so a call's own count never sizes the read.
const POLL_ENTRY_LIMIT: usize = 1024;

// The wait channel a thread sleeps in while the terminal's line discipline waits for input.
const TERMINAL_WAIT_CHANNEL: &str = "wait_woken";

// The wait channels, a compiler clone's suffix cut, a thread shows while an epoll set waits, and
// while `select`, `pselect6`, `poll` or `ppoll` waits; each name after the first stands where the
// build inlined the function its waits call, nearer the sleep.
const EPOLL_WAIT_CHANNELS: [&str; 2] = ["ep_poll", "do_epoll_wait"];
const SELECT_WAIT_CHANNELS: [&str; 6] = [
    "poll_schedule_timeout",
    "do_select",
    "core_sys_select",
    "compat_core_sys_select",
    "do_poll",
    "do_sys_poll",
];

// The links of the descriptors that deliver an event, which a `select` or `poll` may wait on.
const EVENT_DESCRIPTOR_TARGETS: [&str; 4] = [
    "anon_inode:[eventfd]",
    "anon_inode:[timerfd]",
    "anon_inode:[signalfd]",
    "anon_inode:[pidfd]",
];

// Names the weaker reading in the service log once, the first time Yama refuses the reads.
static WEAKER_READING_NOTED: Once = Once::new();

/// Whether the terminal's foreground group waits on `terminal`'s input, takes input, and has echo
/// off, read from `/proc` with no program started, so the spawner goes unused; a process or thread
/// that ends during the reads is left out. Fails with the system's error when `/proc` refuses a
/// read this user may make, and with `Unsupported` on a kernel that lists no thread's children,
/// where the group cannot be found.
pub async fn read_input_wait(
    _spawner: &Spawner,
    terminal: &InputTerminal,
) -> io::Result<InputWaitReading> {
    // A wait needs nothing queued on the terminal (an absent count reads as not waiting), no thread
    // of the group running or stopped, and a thread blocked in `read`, `readv` or `pread64` on the
    // terminal, in an epoll wait on a set holding the terminal for input, or in `select`,
    // `pselect6`, `poll` or `ppoll` with the terminal in its read set. Where Yama refuses those
    // reads, a thread sleeping where the line discipline or an epoll wait sleeps counts instead,
    // and one sleeping where `select` and `poll` sleep with no other source to wait on is marked
    // as a `select` wait; a program whose descriptors or calls the daemon may not read, as `sudo`,
    // waits when the terminal is set as a password prompt and a member sleeps.
    let is_wait_channel_read = is_ptrace_admin_only()?;
    let mut accepts_input = false;
    let mut is_running_or_stopped = false;
    let mut is_waiting = false;
    let mut is_in_select = false;
    let mut is_any_refused_sleeping = false;
    let mut is_refused = false;
    let members = list_group_members(
        terminal.master.session_leader,
        terminal.master.foreground_group,
    )?;
    for member in members {
        let Some(process) = read_process(&member, terminal.device, is_wait_channel_read)? else {
            continue;
        };
        accepts_input |= !process.terminal_reads.is_empty();
        for thread in &process.threads {
            // A stopped thread reads nothing until it is continued, whatever call it stopped in.
            is_running_or_stopped |= matches!(thread.state, 'R' | 'T' | 't');
            let wait = if process.is_refused {
                ThreadWait::Refused
            } else {
                thread_wait(&process, thread, terminal, is_wait_channel_read)?
            };
            match wait {
                ThreadWait::OnTerminal => is_waiting = true,
                ThreadWait::InSelect => is_in_select = true,
                ThreadWait::Elsewhere => {}
                ThreadWait::Refused => {
                    is_refused = true;
                    is_any_refused_sleeping |= thread.state == 'S';
                }
            }
        }
    }
    let is_password_wait =
        is_refused && is_any_refused_sleeping && terminal.master.is_password_prompt();
    // An absent count is not known to be empty, so the command reads as not waiting.
    let is_nothing_queued = terminal.master.queued_input_bytes == Some(0);
    let is_wait_possible = is_nothing_queued && !is_running_or_stopped;
    let is_waiting = is_wait_possible && (is_waiting || is_password_wait);
    Ok(InputWaitReading {
        is_waiting,
        is_waiting_in_select: is_wait_possible && is_in_select && !is_waiting,
        accepts_input: accepts_input || is_password_wait,
        is_echo_off: !terminal.master.is_echo_on,
        is_password_prompt: terminal.master.is_password_prompt(),
    })
}

// `TIOCGPTPEER`: opens a terminal's program side from its master, with the open flags given.
nix::ioctl_write_int_bad!(open_terminal_peer, libc::TIOCGPTPEER);

/// The input a terminal's program can read now (`TIOCINQ`), counted on the program's side, which is
/// opened from `master` for this count alone and closed before the return, so the daemon never
/// keeps the terminal open past its program. Fails with the system's error when that side cannot be
/// opened, as on a terminal set exclusive, or counted.
pub(crate) fn read_queued_input_bytes(master: BorrowedFd<'_>) -> io::Result<u32> {
    let flags = libc::O_RDONLY | libc::O_NOCTTY | libc::O_CLOEXEC;
    // SAFETY: the descriptor is the terminal's open master, and the flags are passed by value.
    let peer = unsafe { open_terminal_peer(master.as_raw_fd(), flags) }.map_err(io::Error::from)?;
    // SAFETY: the call returned a new descriptor that nothing else owns.
    let peer = unsafe { OwnedFd::from_raw_fd(peer) };
    read_queued_bytes(peer.as_fd())
}

/// Whether the terminal's foreground group may wait on `terminal`'s input, which on Linux is the
/// whole reading, either wait, since no read of it is slow. Blocks and fails as
/// [`read_input_wait`] does.
pub async fn may_wait_for_input(spawner: &Spawner, terminal: &InputTerminal) -> io::Result<bool> {
    let reading = read_input_wait(spawner, terminal).await?;
    Ok(reading.is_waiting || reading.is_waiting_in_select)
}

// What one process of the group shows.
struct ProcessReading {
    process_id: u32,
    threads: Vec<ThreadReading>,
    // Whether the kernel refused its descriptors, so its threads' calls cannot be read either.
    is_refused: bool,
    // The descriptors open for reading on the terminal.
    terminal_reads: Vec<i32>,
    // The epoll sets, whose `fdinfo` lists what they wait on.
    epoll_sets: Vec<i32>,
    // Whether a socket, inotify or fanotify descriptor is open, a read of which sleeps where the
    // line discipline's does.
    holds_other_wait_source: bool,
    // Whether a pipe or FIFO is open for reading, or an eventfd, timerfd, signalfd or pidfd is
    // open, which a `select` or `poll` may wait on instead; read only where wait channels are.
    holds_select_source: bool,
}

// One thread of a process.
struct ThreadReading {
    thread_id: u32,
    // The state letter of its `stat`.
    state: char,
}

// Where one thread waits.
enum ThreadWait {
    OnTerminal,
    // Where `select` and `poll` sleep, with the terminal the one source its process could wait on.
    InSelect,
    Elsewhere,
    // The kernel refused the reads that tell.
    Refused,
}

// What `member` shows of its threads and descriptors, the sources a `select` may wait on only when
// `is_wait_channel_read`; `None` when it ended.
fn read_process(
    member: &GroupMember,
    device: TerminalDevice,
    is_wait_channel_read: bool,
) -> io::Result<Option<ProcessReading>> {
    let process_id = member.process_id;
    let mut threads = Vec::new();
    for &thread_id in &member.thread_ids {
        let Some([state]) = read_process_stat_fields(thread_id, [STATE_FIELD])? else {
            continue;
        };
        let state = state.chars().next().unwrap_or('?');
        threads.push(ThreadReading { thread_id, state });
    }
    let mut process = ProcessReading {
        process_id,
        threads,
        is_refused: false,
        terminal_reads: Vec::new(),
        epoll_sets: Vec::new(),
        holds_other_wait_source: false,
        holds_select_source: false,
    };
    let descriptors = match fs::read_dir(format!("/proc/{process_id}/fd")) {
        Ok(descriptors) => descriptors,
        // Another user's process shows no descriptors; its threads' calls are refused too.
        Err(error) if is_refusal(&error) => {
            process.is_refused = true;
            return Ok(Some(process));
        }
        Err(error) if is_gone(&error) => return Ok(None),
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
        let target = match fs::read_link(entry.path()) {
            Ok(target) => target,
            // Closed since the listing.
            Err(error) if is_gone(&error) => continue,
            Err(error) => return Err(error),
        };
        let target = target.to_string_lossy();
        if target.starts_with("socket:")
            || target == "anon_inode:inotify"
            || target == "anon_inode:[fanotify]"
        {
            process.holds_other_wait_source = true;
        } else if target == "anon_inode:[eventpoll]" {
            process.epoll_sets.push(descriptor);
        } else if EVENT_DESCRIPTOR_TARGETS.contains(&target.as_ref()) {
            process.holds_select_source |= is_wait_channel_read;
        } else {
            match read_descriptor_kind(&entry.path(), &target, member, device)? {
                DescriptorKind::Terminal => {
                    if is_open_for_reading(process_id, descriptor)? {
                        process.terminal_reads.push(descriptor);
                    }
                }
                // Its access mode is read only where wait channels are, so the system-call path
                // pays no read for it.
                DescriptorKind::Fifo => {
                    process.holds_select_source |=
                        is_wait_channel_read && is_open_for_reading(process_id, descriptor)?;
                }
                DescriptorKind::Other => {}
            }
        }
    }
    Ok(Some(process))
}

// What a descriptor of a process leads to, among the kinds a wait on the terminal tells apart.
enum DescriptorKind {
    // The terminal: a character device of its device number, or `/dev/tty` in a process whose
    // controlling terminal it is.
    Terminal,
    // A pipe or a FIFO.
    Fifo,
    // Anything else, or a descriptor closed since the listing.
    Other,
}

// The kind of the descriptor at `path`, open on `target`, of `member`.
fn read_descriptor_kind(
    path: &Path,
    target: &str,
    member: &GroupMember,
    device: TerminalDevice,
) -> io::Result<DescriptorKind> {
    if target == "/dev/tty" {
        let is_terminal = member.controlling_terminal == Some(encode_old_device(device));
        return Ok(if is_terminal {
            DescriptorKind::Terminal
        } else {
            DescriptorKind::Other
        });
    }
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if is_gone(&error) => return Ok(DescriptorKind::Other),
        Err(error) => return Err(error),
    };
    let file_type = metadata.file_type();
    Ok(
        if file_type.is_char_device() && metadata.rdev() == device.0 {
            DescriptorKind::Terminal
        } else if file_type.is_fifo() {
            DescriptorKind::Fifo
        } else {
            DescriptorKind::Other
        },
    )
}

// A device number in the old encoding `stat`'s `tty_nr` field writes it in.
fn encode_old_device(device: TerminalDevice) -> i64 {
    let major = i64::from(libc::major(device.0));
    let minor = i64::from(libc::minor(device.0));
    (minor & 0xff) | (major << 8) | ((minor & !0xff) << 12)
}

// Whether descriptor `descriptor` of process `process_id` was opened for reading, from the access
// mode in its `fdinfo` flags.
fn is_open_for_reading(process_id: u32, descriptor: i32) -> io::Result<bool> {
    let Some(info) = read_process_file(process_id, &format!("fdinfo/{descriptor}"))? else {
        return Ok(false);
    };
    let flags = String::from_utf8_lossy(&info)
        .lines()
        .find_map(|line| line.strip_prefix("flags:"))
        .and_then(|flags| i32::from_str_radix(flags.trim(), 8).ok())
        .unwrap_or(libc::O_WRONLY);
    Ok(matches!(
        flags & libc::O_ACCMODE,
        libc::O_RDONLY | libc::O_RDWR
    ))
}

// Where `thread` of `process` waits; its wait channel tells where its system call is refused and
// `is_wait_channel_read`.
fn thread_wait(
    process: &ProcessReading,
    thread: &ThreadReading,
    terminal: &InputTerminal,
    is_wait_channel_read: bool,
) -> io::Result<ThreadWait> {
    let call = match read_process_file(
        process.process_id,
        &format!("task/{}/syscall", thread.thread_id),
    ) {
        Ok(Some(call)) => call,
        // The thread ended since its listing.
        Ok(None) => return Ok(ThreadWait::Elsewhere),
        Err(error) if is_refusal(&error) => {
            return if is_wait_channel_read {
                note_weaker_reading();
                wait_channel_wait(process, thread, terminal)
            } else {
                Ok(ThreadWait::Refused)
            };
        }
        Err(error) => return Err(error),
    };
    let call = String::from_utf8_lossy(&call);
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
    let is_on_terminal = match read_system_call(number) {
        Some(SystemCall::Read) => process.terminal_reads.contains(&read_descriptor(*first)),
        Some(SystemCall::EpollWait) => {
            epoll_set_waits_on_terminal(process, read_descriptor(*first))?
        }
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
fn read_system_call(number: libc::c_long) -> Option<SystemCall> {
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

// A system call argument as the descriptor it names, which the kernel reads as an `int` from the
// register's low 32 bits.
fn read_descriptor(argument: u64) -> i32 {
    low_32_bits(argument).cast_signed()
}

// Whether epoll set `epoll_set` of `process` waits for input on one of its descriptors of the
// terminal, as the set's `fdinfo` lists its targets.
fn epoll_set_waits_on_terminal(process: &ProcessReading, epoll_set: i32) -> io::Result<bool> {
    if !process.epoll_sets.contains(&epoll_set) {
        return Ok(false);
    }
    let Some(info) = read_process_file(process.process_id, &format!("fdinfo/{epoll_set}"))? else {
        return Ok(false);
    };
    Ok(String::from_utf8_lossy(&info).lines().any(|line| {
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
// `process`'s memory holds one of its descriptors of the terminal. The set is read only up to the
// highest such descriptor, so the call's own count never sizes the read.
fn select_reads_terminal(
    process: &ProcessReading,
    descriptor_count: u64,
    read_set: u64,
) -> io::Result<bool> {
    // The kernel reads the count as an `int`, from the register's low 32 bits.
    let descriptor_count = low_32_bits(descriptor_count).cast_signed();
    let Some(highest) = process
        .terminal_reads
        .iter()
        .copied()
        .filter(|descriptor| (0..descriptor_count).contains(descriptor))
        .max()
    else {
        return Ok(false);
    };
    if read_set == 0 {
        return Ok(false);
    }
    let highest = usize::try_from(highest).map_err(io::Error::other)?;
    // The set is an array of 64-bit words, one bit per descriptor; read as bytes, which holds on a
    // little-endian processor, where descriptor `n`'s bit is bit `n % 8` of byte `n / 8`.
    let mut bytes = vec![0_u8; highest / 8 + 1];
    if !read_memory(process.process_id, read_set, &mut bytes)? {
        return Ok(false);
    }
    Ok(process.terminal_reads.iter().any(|descriptor| {
        usize::try_from(*descriptor).is_ok_and(|descriptor| {
            bytes
                .get(descriptor / 8)
                .is_some_and(|byte| byte & (1 << (descriptor % 8)) != 0)
        })
    }))
}

// Whether a `poll` over the `count` `pollfd` entries at `entries` in `process`'s memory waits for
// input on one of its descriptors of the terminal, among its first `POLL_ENTRY_LIMIT` entries.
fn poll_reads_terminal(process: &ProcessReading, entries: u64, count: u64) -> io::Result<bool> {
    // `struct pollfd`: a 32-bit descriptor, then 16-bit requested and returned events.
    const ENTRY_BYTES: usize = 8;
    // The kernel reads the count as an `unsigned int`, from the register's low 32 bits.
    let count = usize::try_from(low_32_bits(count))
        .map_err(io::Error::other)?
        .min(POLL_ENTRY_LIMIT);
    if entries == 0 || count == 0 {
        return Ok(false);
    }
    let mut bytes = vec![0_u8; count * ENTRY_BYTES];
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

// A system call register's low 32 bits, which the kernel reads an `int` argument from.
fn low_32_bits(register: u64) -> u32 {
    u32::try_from(register & u64::from(u32::MAX)).expect("the masked register fits 32 bits")
}

// Fills `bytes` from `process_id`'s memory at `address`, answering whether the memory was there,
// which it is not once the process ended; fails with the system's error when the read is refused.
fn read_memory(process_id: u32, address: u64, bytes: &mut [u8]) -> io::Result<bool> {
    let memory = match File::open(format!("/proc/{process_id}/mem")) {
        Ok(memory) => memory,
        Err(error) if is_gone(&error) => return Ok(false),
        Err(error) => return Err(error),
    };
    match memory.read_exact_at(bytes, address) {
        Ok(()) => Ok(true),
        // An address the call's arguments name but the process no longer maps, or a process that
        // ended, whose memory reads as empty.
        Err(error)
            if error.kind() == ErrorKind::UnexpectedEof
                || matches!(error.raw_os_error(), Some(libc::EIO | libc::EFAULT)) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

// Where `thread` waits, read from its wait channel where Yama refuses its system call: in the line
// discipline's sleep while its process holds the terminal for reading, no other source that sleeps
// there and the master holds no unread output, so it is no writer; in an epoll wait on a set
// holding the terminal for input; or in a `select` wait while its process holds the terminal for
// reading, no other source such a wait may be on and no epoll set, and the master no unread output,
// since a writer stalled on a full terminal waits there too.
fn wait_channel_wait(
    process: &ProcessReading,
    thread: &ThreadReading,
    terminal: &InputTerminal,
) -> io::Result<ThreadWait> {
    let Some(channel) = read_process_file(
        process.process_id,
        &format!("task/{}/wchan", thread.thread_id),
    )?
    else {
        return Ok(ThreadWait::Elsewhere);
    };
    let channel = String::from_utf8_lossy(&channel);
    // A compiler clone of a function shows as its name with a suffix, as `name.constprop.0`.
    let channel = channel.trim();
    let channel = channel
        .split_once('.')
        .map_or(channel, |(name, _clone_suffix)| name);
    let is_terminal_alone_read = !process.terminal_reads.is_empty()
        && !process.holds_other_wait_source
        && terminal.master.unread_output_bytes == 0;
    if thread.state != 'S' {
        return Ok(ThreadWait::Elsewhere);
    }
    if channel == TERMINAL_WAIT_CHANNEL && is_terminal_alone_read {
        return Ok(ThreadWait::OnTerminal);
    }
    if EPOLL_WAIT_CHANNELS.contains(&channel) {
        for epoll_set in &process.epoll_sets {
            if epoll_set_waits_on_terminal(process, *epoll_set)? {
                return Ok(ThreadWait::OnTerminal);
            }
        }
    }
    let is_select_on_terminal_alone =
        is_terminal_alone_read && !process.holds_select_source && process.epoll_sets.is_empty();
    Ok(
        if SELECT_WAIT_CHANNELS.contains(&channel) && is_select_on_terminal_alone {
            ThreadWait::InSelect
        } else {
            ThreadWait::Elsewhere
        },
    )
}

/// Whether Yama refuses the system-call and memory reads to every reader without the capability,
/// read anew each call, since the scope can be changed while the daemon runs. No Yama module, and
/// so no scope file, refuses nothing.
pub(crate) fn is_ptrace_admin_only() -> io::Result<bool> {
    let scope = match fs::read_to_string(PTRACE_SCOPE_PATH) {
        Ok(scope) => scope,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    Ok(scope
        .trim()
        .parse::<u32>()
        .is_ok_and(|scope| scope >= ADMIN_ONLY_PTRACE_SCOPE))
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io;
    use std::sync::Once;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::{
        ProcessReading, ThreadWait, list_group_members, read_process, select_reads_terminal,
        wait_channel_wait,
    };
    use crate::input_wait::{
        InputTerminal, PIPE_HOLDING_SELECT_READER_SCRIPT, SELECT_READER_SCRIPT,
    };
    use crate::posix::memory::page_bytes;
    use crate::posix::terminal::inner::{
        TEST_WINDOW_SIZE, end_inner_terminal, read_until_marker, start_inner_terminal,
    };
    use crate::posix::terminal::{read_terminal_master, terminal_options};
    use crate::terminal::InnerTerminal;

    // How long a reader's wait channel is read for a `select` wait before it reads as none.
    const WAIT_BOUND: Duration = Duration::from_millis(500);

    // The terminal's descriptor the set marks, the last bit of the set's first byte.
    const TERMINAL_DESCRIPTOR: i32 = 7;

    // Fails when the `select` set is read to the length the call's own count names: the set's one
    // byte ends a mapping, so a read past it finds no memory and the terminal is missed.
    #[test]
    fn a_select_set_is_read_only_up_to_the_terminal_s_descriptor() {
        let page = usize::try_from(page_bytes().expect("the page size reads")).expect("a size");
        // SAFETY: a private anonymous mapping of two fresh pages, aliasing nothing.
        let pages = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                2 * page,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                -1,
                0,
            )
        };
        assert_ne!(pages, libc::MAP_FAILED, "the pages are mapped");
        // SAFETY: the second page lies inside the mapping just made, and nothing points into it.
        let unmapped = unsafe { libc::munmap(pages.cast::<u8>().add(page).cast(), page) };
        assert_eq!(unmapped, 0, "the second page is unmapped");
        // SAFETY: the first page's last byte lies inside the mapping, which nothing else uses.
        let set = unsafe {
            let set = pages.cast::<u8>().add(page - 1);
            set.write(1 << TERMINAL_DESCRIPTOR);
            set
        };
        let process = ProcessReading {
            process_id: std::process::id(),
            threads: Vec::new(),
            is_refused: false,
            terminal_reads: vec![TERMINAL_DESCRIPTOR],
            epoll_sets: Vec::new(),
            holds_other_wait_source: false,
            holds_select_source: false,
        };

        let reads = select_reads_terminal(&process, 0x7fff_ffff, set as u64);
        // SAFETY: the first page is still mapped and nothing points into it any more.
        unsafe { libc::munmap(pages, page) };

        assert!(reads.expect("the set is read"));
    }

    // Fails when a `select` reader on the terminal alone is not marked where its wait channel is
    // the only reading, when one holding a pipe open for reading is, or when one is marked while
    // the master holds unread output, as a writer stalled on a full terminal sleeps there too.
    #[test]
    fn a_select_reader_s_wait_channel_marks_it_only_on_the_terminal_alone() {
        let alone = read_select_wait(SELECT_READER_SCRIPT, 0);
        let pipe_holding = read_select_wait(PIPE_HOLDING_SELECT_READER_SCRIPT, 0);
        let unread_output = read_select_wait(SELECT_READER_SCRIPT, 1);

        assert!(
            matches!(alone, ThreadWait::InSelect),
            "on the terminal alone"
        );
        assert!(
            matches!(pipe_holding, ThreadWait::Elsewhere),
            "holding a pipe"
        );
        assert!(
            matches!(unread_output, ThreadWait::Elsewhere),
            "with unread output"
        );
    }

    // Where the group of `script`'s terminal waits once it prints `ready`, as its threads' wait
    // channels read with the master's unread output taken as `unread_output_bytes`: the first wait
    // read within the bound, or none.
    fn read_select_wait(script: &str, unread_output_bytes: u32) -> ThreadWait {
        let options = terminal_options(
            "/bin/sh".to_owned(),
            vec!["-c".to_owned(), script.to_owned()],
            None,
            HashMap::new(),
        );
        let terminal =
            start_inner_terminal(&options, TEST_WINDOW_SIZE).expect("the terminal starts");
        let prompt = read_until_marker(&terminal.pty, "ready", Duration::from_secs(20));
        let wait = prompt
            .is_ok()
            .then(|| read_group_wait(&terminal, unread_output_bytes));
        end_inner_terminal(terminal);
        prompt.expect("the command prompts");
        wait.expect("the command prompted")
            .expect("the wait channels read")
    }

    fn read_group_wait(
        terminal: &InnerTerminal,
        unread_output_bytes: u32,
    ) -> io::Result<ThreadWait> {
        let peer_failure_noted = Once::new();
        let window_start = Instant::now();
        loop {
            let mut master = read_terminal_master(&terminal.pty, &peer_failure_noted)?;
            master.unread_output_bytes = unread_output_bytes;
            let input_terminal = InputTerminal {
                device: terminal.device,
                master,
            };
            for member in list_group_members(master.session_leader, master.foreground_group)? {
                let Some(process) = read_process(&member, terminal.device, true)? else {
                    continue;
                };
                for thread in &process.threads {
                    let wait = wait_channel_wait(&process, thread, &input_terminal)?;
                    if !matches!(wait, ThreadWait::Elsewhere) {
                        return Ok(wait);
                    }
                }
            }
            if window_start.elapsed() >= WAIT_BOUND {
                return Ok(ThreadWait::Elsewhere);
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}
