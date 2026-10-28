//! The one process table every reader of the machine's processes builds, the walk from a process
//! down to every process under it, and the outright end of the processes such a walk lists.

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::Once;

use futures_util::future::join_all;
use sysinfo::{Pid, System};

use crate::pinned_process::KILL_WAIT_BOUND;
use crate::{PinnedProcess, pin_running_process};

// The open-files setting is process-wide and takes effect at the first refresh, so it is set once.
static NO_OPEN_PROCESS_FILES: Once = Once::new();

/// An empty process table, which keeps no process file open between refreshes: on Linux a table
/// would otherwise keep each process's `stat` file open. Never fails.
pub fn process_table() -> System {
    NO_OPEN_PROCESS_FILES.call_once(|| {
        sysinfo::set_open_files_limit(0);
    });
    System::new()
}

/// `root` and every process in `system` whose parent chain reaches it, `root` first and each
/// process after its parent. Reads only the pids and parents `system` last refreshed.
pub fn tree_under(system: &System, root: Pid) -> Vec<Pid> {
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }
    let mut tree = vec![root];
    let mut seen = HashSet::from([root]);
    let mut next = 0;
    while let Some(pid) = tree.get(next).copied() {
        next += 1;
        for child in children.get(&pid).into_iter().flatten() {
            if seen.insert(*child) {
                tree.push(*child);
            }
        }
    }
    tree
}

/// Ends each of `process_ids` outright in the order given, so with parents listed before their
/// children, as [`tree_under`] lists them, no ended parent starts another; a process already gone
/// is skipped. Each is pinned before its kill, so no process its id passes to meanwhile is ended.
/// Answers once each has exited, on macOS once it has begun its exit, waiting for them all together
/// under one kill's bound. Fails with the first error a pin, a kill or a wait met, every kill still
/// sent, and with `TimedOut` when one still runs past the bound.
pub async fn end_processes(process_ids: Vec<u32>) -> io::Result<()> {
    let (killed, kill_result) = tokio::task::spawn_blocking(move || kill_processes(&process_ids))
        .await
        .map_err(io::Error::other)?;
    let wait_result = tokio::time::timeout(
        KILL_WAIT_BOUND,
        join_all(killed.iter().map(PinnedProcess::wait_for_end)),
    )
    .await
    .map_err(|_elapsed| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "a killed process still runs past the kill's bound",
        )
    })
    .and_then(|exits| exits.into_iter().collect::<io::Result<()>>());
    kill_result.and(wait_result)
}

// Pins and kills each of `process_ids` in order, answering those the kill reached and the first
// error met.
fn kill_processes(process_ids: &[u32]) -> (Vec<PinnedProcess>, io::Result<()>) {
    let mut killed = Vec::new();
    let mut result = Ok(());
    for &process_id in process_ids {
        let kill = pin_running_process(process_id).and_then(|process| match process {
            Some(process) if process.kill()? => Ok(Some(process)),
            _ => Ok(None),
        });
        match kill {
            Ok(Some(process)) => killed.push(process),
            Ok(None) => {}
            Err(error) => result = result.and(Err(error)),
        }
    }
    (killed, result)
}
