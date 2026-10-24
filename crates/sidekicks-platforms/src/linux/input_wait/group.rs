//! The processes of a terminal's foreground group, found by a walk from its session's leader and
//! the orphans this process holds as a child subreaper, since Linux lists no group's members.

use std::collections::HashSet;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;
use std::sync::OnceLock;

use super::is_refusal;
use crate::linux::pinned_process::{GROUP_FIELD, SESSION_FIELD};
use crate::linux::{is_gone, read_process_file, read_process_stat_fields};

// The field of a `stat` file, numbered as proc(5) numbers them, that holds a process's controlling
// terminal's device.
const TERMINAL_FIELD: usize = 7;

// Whether the kernel lists a thread's children (`CONFIG_PROC_CHILDREN`), read once.
static IS_CHILDREN_LISTED: OnceLock<bool> = OnceLock::new();

// One process of the foreground group, as the walk that found it read it.
pub(super) struct GroupMember {
    pub(super) process_id: u32,
    pub(super) thread_ids: Vec<u32>,
    // Its controlling terminal's device, in `stat`'s old encoding.
    pub(super) controlling_terminal: Option<i64>,
}

// What a process the group walk reaches must show before it and its descendants are walked.
#[derive(Clone, Copy)]
enum WalkStart {
    // The session leader, or a descendant of a process walked.
    Descendant,
    // An orphan this process took in as a child subreaper, which it does for every session.
    OwnChild,
    // The foreground group's own leader, which may have left the session leader's tree.
    GroupLeader,
}

// The processes in group `group_id` among session leader `leader`'s descendants, the orphans this
// process holds as a child subreaper in that session and theirs, and the group's leader with its
// descendants when it is in the group but outside both; each process's `stat`, threads and
// children read once. A process that ended during the walk is left out, and so are the children of
// one whose children the kernel refuses to list. A `children` listing that races an exiting
// sibling drops a member for one check, and an orphan a nearer subreaper took in or a process that
// left the session is missed; the walk's cost grows with the orphans this process holds.
pub(super) fn list_group_members(leader: u32, group_id: u32) -> io::Result<Vec<GroupMember>> {
    if !is_children_listed()? {
        return Err(io::Error::new(
            ErrorKind::Unsupported,
            "the kernel lists no thread's children, so a terminal's foreground group is not found",
        ));
    }
    let own_id = std::process::id();
    // A stack, so the leader's tree is walked first and the group's leader last.
    let mut pending = vec![(group_id, WalkStart::GroupLeader)];
    // The kernel hands an orphan to its subreaper's first thread that is not exiting, the leader
    // first, and this process's leader lives as long as the process does.
    pending.extend(
        list_children(own_id, &[own_id])?
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
