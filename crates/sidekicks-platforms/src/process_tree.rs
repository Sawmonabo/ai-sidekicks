//! The one process table every reader of the machine's processes builds, and the walk from a
//! process down to every process under it.

use std::collections::{HashMap, HashSet};
use std::sync::Once;

use sysinfo::{Pid, System};

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
