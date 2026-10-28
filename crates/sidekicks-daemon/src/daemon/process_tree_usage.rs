//! How much processor and memory the daemon and every process under it use, read when asked: the
//! daemon's own process, its terminals, its providers and whatever they started.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sidekicks_std::mutex_lock::lock;
use sidekicks_std::processor_bound::processor_count;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// One reading over a process and every process under it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ProcessTreeUsage {
    /// A share of the whole machine's processor, from 0 to 100.
    pub(crate) processor_percent: f64,
    /// The resident memory of every process in the tree, summed, in bytes.
    pub(crate) resident_bytes: u64,
}

/// Why a reading of the process tree failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ProcessTreeUsageError {
    /// The blocking task that reads the tree ended before it gave a reading.
    #[error("the process tree reading ended before it finished")]
    Interrupted(#[source] tokio::task::JoinError),
}

/// Reads a process tree's processor and memory use when asked, each process's processor share
/// measured since this reader last read it, or since the process started at its first reading.
pub(crate) struct ProcessTreeUsageReader {
    state: Arc<Mutex<ReaderState>>,
}

// The process table and each process's processor time at its last reading.
struct ReaderState {
    system: System,
    last_readings: HashMap<Pid, ProcessorReading>,
}

#[derive(Clone, Copy)]
struct ProcessorReading {
    // Processor time the process has used, all cores together.
    accumulated_cpu_time: Duration,
    read_at: Instant,
}

impl ProcessTreeUsageReader {
    /// A reader with an empty process table, which keeps no process file open between readings.
    pub(crate) fn new() -> Self {
        // On Linux the process table would otherwise keep each process's `stat` file open.
        sysinfo::set_open_files_limit(0);
        Self {
            state: Arc::new(Mutex::new(ReaderState {
                system: System::new(),
                last_readings: HashMap::new(),
            })),
        }
    }

    /// Reads `root_pid` and every process under it on a blocking thread. Fails when that thread
    /// ends early.
    pub(crate) async fn read(
        &self,
        root_pid: u32,
    ) -> Result<ProcessTreeUsage, ProcessTreeUsageError> {
        let state = Arc::clone(&self.state);
        tokio::task::spawn_blocking(move || lock(&state).read(Pid::from_u32(root_pid)))
            .await
            .map_err(ProcessTreeUsageError::Interrupted)
    }
}

impl ReaderState {
    fn read(&mut self, root: Pid) -> ProcessTreeUsage {
        // Pids and parents only, to find the tree; then processor and memory for the tree alone.
        // Neither lists threads: a thread is listed as a child of its process and reports its
        // process's memory, so it would count as a second process of the tree.
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        let tree = self.tree_under(root);
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&tree),
            true,
            ProcessRefreshKind::nothing()
                .without_tasks()
                .with_cpu()
                .with_memory(),
        );
        let read_at = Instant::now();
        let mut core_percent = 0.0;
        let mut resident_bytes: u64 = 0;
        let mut readings = HashMap::with_capacity(tree.len());
        for pid in &tree {
            // A process that ended between the two refreshes counts for nothing.
            let Some(process) = self.system.process(*pid) else {
                continue;
            };
            resident_bytes = resident_bytes.saturating_add(process.memory());
            let reading = ProcessorReading {
                accumulated_cpu_time: Duration::from_millis(process.accumulated_cpu_time()),
                read_at,
            };
            let last = self.last_readings.get(pid).copied();
            if let Some(share) = core_share(last, reading, Duration::from_secs(process.run_time()))
            {
                core_percent += share;
            }
            readings.insert(*pid, reading);
        }
        // Only the tree's processes are kept, so the readings never outgrow the tree.
        self.last_readings = readings;
        // Each share is of one core, so the sum is divided over every core the machine has; no
        // machine has more cores than a `u32` counts.
        let core_count = f64::from(u32::try_from(processor_count()).unwrap_or(u32::MAX));
        ProcessTreeUsage {
            processor_percent: (core_percent / core_count).min(100.0),
            resident_bytes,
        }
    }

    // `root` and every process whose parent chain reaches it.
    fn tree_under(&self, root: Pid) -> Vec<Pid> {
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, process) in self.system.processes() {
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
}

// One process's share of one core, in percent: its processor time since its last reading over the
// wall time since then, or at its first reading its processor time over its run time. No figure
// when no time has passed, or at a first reading in the process's first second (its run time
// counts whole seconds).
fn core_share(
    last: Option<ProcessorReading>,
    reading: ProcessorReading,
    run_time: Duration,
) -> Option<f64> {
    // A lower total means the pid now names a new process, read as a first reading.
    let (used, over) = last
        .and_then(|last| {
            let used = reading
                .accumulated_cpu_time
                .checked_sub(last.accumulated_cpu_time)?;
            Some((
                used,
                reading.read_at.saturating_duration_since(last.read_at),
            ))
        })
        .unwrap_or((reading.accumulated_cpu_time, run_time));
    if over.is_zero() {
        None
    } else {
        Some(used.as_secs_f64() / over.as_secs_f64() * 100.0)
    }
}
