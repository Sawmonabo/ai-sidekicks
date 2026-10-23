//! Whether a command waits on its terminal's input, as Linux shows it under `/proc`: the system
//! call each thread of the terminal's foreground group is blocked in and its arguments, the
//! descriptors that call reads, and where the right to attach is refused, each thread's wait
//! channel or the terminal's own settings.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{FileExt, FileTypeExt, MetadataExt};
use std::path::Path;
use std::sync::{Once, OnceLock};

use crate::input_wait::{InputTerminal, InputWaitReading};
use crate::linux::pinned_process::{GROUP_FIELD, SESSION_FIELD};
use crate::linux::{read_process_file, read_process_stat_fields};
use crate::posix::terminal::read_queued_bytes;
use crate::terminal::TerminalDevice;

// The fields of a `stat` file, numbered as proc(5) numbers them, that hold a process's or a
// thread's state letter and its controlling terminal's device.
const STATE_FIELD: usize = 3;
const TERMINAL_FIELD: usize = 7;

// The file Yama keeps its ptrace scope in; at 2 or 3 no reader may attach to a descendant.
const PTRACE_SCOPE_PATH: &str = "/proc/sys/kernel/yama/ptrace_scope";

// The lowest ptrace scope at which Yama refuses the `syscall` and `mem` reads to every reader.
const ADMIN_ONLY_PTRACE_SCOPE: u32 = 2;

// `<sys/epoll.h>`'s `EPOLLIN` and `<poll.h>`'s `POLLIN` and `POLLRDNORM`: a wait for input.
const EPOLLIN: u32 = 0x001;
const POLL_INPUT: i16 = 0x001 | 0x040;

// The most `pollfd` entries a `poll`'s set is read for, so a call's own count never sizes the read.
const POLL_ENTRY_LIMIT: usize = 1024;

// The wait channels a thread sleeps in while the terminal's line discipline waits for input, and
// while an epoll set waits.
const TERMINAL_WAIT_CHANNEL: &str = "wait_woken";
const EPOLL_WAIT_CHANNEL: &str = "do_epoll_wait";

// Names the weaker reading in the service log once, the first time Yama refuses the reads.
static WEAKER_READING_NOTED: Once = Once::new();

// Whether the kernel lists a thread's children (`CONFIG_PROC_CHILDREN`), read once.
static IS_CHILDREN_LISTED: OnceLock<bool> = OnceLock::new();

/// Whether the terminal's foreground group waits on `terminal`'s input, takes input, and has echo
/// off, read from `/proc`; a process or thread that ends during the reads is left out. Fails with
/// the system's error when `/proc` refuses a read this user may make, and with `Unsupported` on a
/// kernel that lists no thread's children, where the group cannot be found.
pub fn read_input_wait(terminal: &InputTerminal) -> io::Result<InputWaitReading> {
    // A wait needs nothing queued on the terminal (an absent count reads as not waiting), no thread
    // of the group running or stopped, and a thread blocked in `read`, `readv` or `pread64` on the
    // terminal, in an epoll wait on a set holding the terminal for input, or in `select`,
    // `pselect6`, `poll` or `ppoll` with the terminal in its read set. Where Yama refuses those
    // reads, a thread sleeping where the line discipline or an epoll wait sleeps counts instead; a
    // program whose descriptors or calls the daemon may not read, as `sudo`, waits when the
    // terminal is set as a password prompt and a member sleeps.
    let mut accepts_input = false;
    let mut is_running_or_stopped = false;
    let mut is_waiting = false;
    let mut is_any_refused_sleeping = false;
    let mut is_refused = false;
    let members = list_group_members(
        terminal.master.session_leader,
        terminal.master.foreground_group,
    )?;
    for member in members {
        let Some(process) = read_process(&member, terminal.device)? else {
            continue;
        };
        accepts_input |= !process.terminal_reads.is_empty();
        for thread in &process.threads {
            // A stopped thread reads nothing until it is continued, whatever call it stopped in.
            is_running_or_stopped |= matches!(thread.state, 'R' | 'T' | 't');
            let wait = if process.is_refused {
                ThreadWait::Refused
            } else {
                thread_wait(&process, thread, terminal)?
            };
            match wait {
                ThreadWait::OnTerminal => is_waiting = true,
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
    Ok(InputWaitReading {
        is_waiting: is_nothing_queued && !is_running_or_stopped && (is_waiting || is_password_wait),
        // The `select` and `poll` sets are read from the call's memory, so such a wait is above.
        is_waiting_in_select: false,
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
/// whole reading, since no read of it is slow. Blocks and fails as [`read_input_wait`] does.
pub fn may_wait_for_input(terminal: &InputTerminal) -> io::Result<bool> {
    Ok(read_input_wait(terminal)?.is_waiting)
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
    Elsewhere,
    // The kernel refused the reads that tell.
    Refused,
}

// One process of the foreground group, as the walk that found it read it.
struct GroupMember {
    process_id: u32,
    thread_ids: Vec<u32>,
    // Its controlling terminal's device, in `stat`'s old encoding.
    controlling_terminal: Option<i64>,
}

// What a process the group walk reaches must show before it and its descendants are walked.
#[derive(Clone, Copy)]
enum WalkStart {
    // The session leader, or a descendant of a process walked.
    Descendant,
    // A child of this process, which as a child subreaper takes in the orphans of every session.
    OwnChild,
    // The foreground group's own leader, which may have left the session leader's tree.
    GroupLeader,
}

// The processes in group `group_id` among session leader `leader`'s descendants, this process's
// own children in that session and theirs, and the group's leader with its descendants when it is
// in the group but outside both; each process's `stat`, threads and children read once. A process
// that ended during the walk is left out, and so are the children of one whose children the kernel
// refuses to list. A `children` listing that races an exiting sibling drops a member for one
// check, and an orphan a nearer subreaper took in or a process that left the session is missed;
// the walk's cost grows with this process's direct children.
fn list_group_members(leader: u32, group_id: u32) -> io::Result<Vec<GroupMember>> {
    if !is_children_listed()? {
        return Err(io::Error::new(
            ErrorKind::Unsupported,
            "the kernel lists no thread's children, so a terminal's foreground group is not found",
        ));
    }
    let own_id = std::process::id();
    // A stack, so the leader's tree is walked first and the group's leader last.
    let mut pending = vec![(group_id, WalkStart::GroupLeader)];
    pending.extend(
        list_children(own_id, &list_thread_ids(own_id)?)?
            .into_iter()
            .map(|child| (child, WalkStart::OwnChild)),
    );
    pending.push((leader, WalkStart::Descendant));
    let mut members = Vec::new();
    let mut seen = HashSet::new();
    while let Some((process_id, start)) = pending.pop() {
        if !seen.insert(process_id) {
            continue;
        }
        let Some([group, session, terminal]) =
            read_process_stat_fields(process_id, [GROUP_FIELD, SESSION_FIELD, TERMINAL_FIELD])?
        else {
            continue;
        };
        let is_member = group.parse() == Ok(group_id);
        let is_walked = match start {
            WalkStart::Descendant => true,
            WalkStart::OwnChild => session.parse() == Ok(leader),
            WalkStart::GroupLeader => is_member,
        };
        if !is_walked {
            continue;
        }
        let thread_ids = list_thread_ids(process_id)?;
        pending.extend(
            list_children(process_id, &thread_ids)?
                .into_iter()
                .map(|child| (child, WalkStart::Descendant)),
        );
        if is_member {
            members.push(GroupMember {
                process_id,
                thread_ids,
                controlling_terminal: terminal.parse().ok(),
            });
        }
    }
    Ok(members)
}

// Whether the kernel lists a thread's children, read from this thread's own listing once; until it
// is known to, a missing listing could not tell an ended thread from an unbuilt file.
fn is_children_listed() -> io::Result<bool> {
    if let Some(is_listed) = IS_CHILDREN_LISTED.get() {
        return Ok(*is_listed);
    }
    let own_listing = format!("/proc/self/task/{}/children", nix::unistd::gettid());
    let is_listed = Path::new(&own_listing).try_exists()?;
    Ok(*IS_CHILDREN_LISTED.get_or_init(|| is_listed))
}

// The children of process `process_id`, listed by each of its threads `thread_ids`; none for a
// thread that ended or whose children the kernel refuses to list.
fn list_children(process_id: u32, thread_ids: &[u32]) -> io::Result<Vec<u32>> {
    let mut children = Vec::new();
    for thread_id in thread_ids {
        match read_process_file(process_id, &format!("task/{thread_id}/children")) {
            Ok(Some(listed)) => children.extend(
                String::from_utf8_lossy(&listed)
                    .split_whitespace()
                    .filter_map(|child| child.parse::<u32>().ok()),
            ),
            Ok(None) => {}
            Err(error) if is_refusal(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(children)
}

// The ids of process `process_id`'s threads, none when it ended.
fn list_thread_ids(process_id: u32) -> io::Result<Vec<u32>> {
    let entries = match fs::read_dir(format!("/proc/{process_id}/task")) {
        Ok(entries) => entries,
        Err(error) if is_gone(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut thread_ids = Vec::new();
    for entry in entries {
        if let Some(thread_id) = entry?
            .file_name()
            .to_str()
            .and_then(|name| name.parse().ok())
        {
            thread_ids.push(thread_id);
        }
    }
    Ok(thread_ids)
}

// What `member` shows of its threads and descriptors; `None` when it ended.
fn read_process(
    member: &GroupMember,
    device: TerminalDevice,
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
        } else if is_terminal_descriptor(
            &entry.path(),
            &target,
            member.controlling_terminal,
            device,
        )? && is_open_for_reading(process_id, descriptor)?
        {
            process.terminal_reads.push(descriptor);
        }
    }
    Ok(Some(process))
}

// Whether the descriptor at `path`, open on `target`, is the terminal: a character device of its
// device number, or `/dev/tty` in a process whose controlling terminal it is; not one closed since
// the listing.
fn is_terminal_descriptor(
    path: &Path,
    target: &str,
    controlling_terminal: Option<i64>,
    device: TerminalDevice,
) -> io::Result<bool> {
    if target == "/dev/tty" {
        return Ok(controlling_terminal == Some(encode_old_device(device)));
    }
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_char_device() && metadata.rdev() == device.0),
        Err(error) if is_gone(&error) => Ok(false),
        Err(error) => Err(error),
    }
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

// Where `thread` of `process` waits.
fn thread_wait(
    process: &ProcessReading,
    thread: &ThreadReading,
    terminal: &InputTerminal,
) -> io::Result<ThreadWait> {
    let call = match read_process_file(
        process.process_id,
        &format!("task/{}/syscall", thread.thread_id),
    ) {
        Ok(Some(call)) => call,
        // The thread ended since its listing.
        Ok(None) => return Ok(ThreadWait::Elsewhere),
        Err(error) if is_refusal(&error) => {
            return if is_ptrace_admin_only()? {
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
// there and the master holds no unread output, so it is no writer; or in an epoll wait on a set
// holding the terminal for input.
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
    let channel = channel.trim();
    let is_on_terminal = if thread.state != 'S' {
        false
    } else if channel == TERMINAL_WAIT_CHANNEL {
        !process.terminal_reads.is_empty()
            && !process.holds_other_wait_source
            && terminal.master.unread_output_bytes == 0
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
// No Yama module, and so no scope file, refuses nothing.
fn is_ptrace_admin_only() -> io::Result<bool> {
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

// Whether `error` is a read of a process or thread that ended.
fn is_gone(error: &io::Error) -> bool {
    error.kind() == ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH)
}

#[cfg(test)]
mod tests {
    use super::{ProcessReading, select_reads_terminal};
    use crate::posix::memory::page_bytes;

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
        };

        let reads = select_reads_terminal(&process, 0x7fff_ffff, set as u64);
        // SAFETY: the first page is still mapped and nothing points into it any more.
        unsafe { libc::munmap(pages, page) };

        assert!(reads.expect("the set is read"));
    }
}
