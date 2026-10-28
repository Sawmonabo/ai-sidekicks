//! The close of what the shells run in a folder about to be moved or deleted. Each process a shell
//! started is judged by its own working folder: a shell working inside is ended with its tree, and
//! under a shell outside each process working inside is ended with every process under it, while
//! the shell lives.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::{BoxFuture, join_all};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::{end_processes, process_table, tree_under};
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_workspace::folder::canonical_path::canonical_folder_path;
use sidekicks_workspace::git::worktree::removal::FolderProcessOwner;
use sidekicks_workspace::trust_envelope::is_contained_within;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
use tokio::task::JoinError;

use crate::record::ShellRecord;
use crate::table::ShellTable;

/// Why what the shells run in a folder was not all ended.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FolderShellsCloseError {
    /// The folder, or a process's working folder, could not be resolved.
    #[error("a working folder could not be resolved")]
    Folder(#[source] io::Error),
    /// The read of the shells' processes ended before it finished.
    #[error("the read of the shells' processes ended before it finished")]
    Interrupted(#[source] JoinError),
    /// A process working in the folder under a shell outside it could not be ended.
    #[error("a process working in the folder could not be ended")]
    ProcessesNotEnded(#[source] io::Error),
    /// A shell working in the folder could not be ended.
    #[error(transparent)]
    NotEnded(#[from] SettleFailures<HandlerError>),
}

impl ShellTable {
    /// Ends what the shells, whoever holds them, run in `folder` or inside it, each process judged
    /// by its own working folder: a shell working inside is closed and its tree ended, and under a
    /// shell outside each process working inside is ended with every process under it, the shell
    /// living. Shells still opening are waited for first. Answers once each ended program has
    /// exited; fails with what will not end, everything else still ended.
    async fn close_shells_in_folder(&self, folder: &Path) -> Result<(), FolderShellsCloseError> {
        let folder_key = canonical_folder_path(folder)
            .await
            .map_err(FolderShellsCloseError::Folder)?;
        let opening: Vec<_> = self
            .shared
            .lock_sessions()
            .values()
            .flat_map(|session| session.opening.values().cloned())
            .collect();
        for mut waiting in opening {
            while waiting.changed().await.is_ok() {}
        }
        let terminals = &self.shared.deps.terminals;
        let shells: Vec<(Arc<ShellRecord>, u32)> = self
            .shared
            .lock_sessions()
            .values()
            .flat_map(|session| session.shells.values())
            .filter_map(|shell| Some((Arc::clone(shell), terminals.process_id(shell.handle()?)?)))
            .collect();
        if shells.is_empty() {
            return Ok(());
        }
        let roots = shells.iter().map(|(_, process_id)| *process_id).collect();
        let roots_inside = end_processes_inside(roots, &folder_key).await?;
        let picked: Vec<Arc<ShellRecord>> = shells
            .into_iter()
            .filter(|(_, process_id)| roots_inside.contains(process_id))
            .map(|(shell, _)| shell)
            .collect();
        let ended = join_all(
            picked
                .iter()
                .filter_map(|shell| self.shared.end_shell(shell)),
        )
        .await;
        for shell in &picked {
            self.shared.forget_if_idle(&shell.session_id);
        }
        settle_all(ended, "closing the shells working in the folder")?;
        Ok(())
    }
}

impl FolderProcessOwner for ShellTable {
    fn end_processes_in_folder<'a>(
        &'a self,
        folder: &'a Path,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move { Ok(self.close_shells_in_folder(folder).await?) })
    }
}

// One process of a tree, with its parent and its working folder; `None` where the process ended
// or the system will not tell its folder.
struct TreeProcess {
    id: Pid,
    parent: Option<Pid>,
    working_folder: Option<PathBuf>,
}

// Ends, under each of `roots`, every process working in the folder whose key is `folder_key` or
// inside it, with every process under it, and answers the roots that work inside themselves,
// which are left running with their trees for the caller to end as shells.
async fn end_processes_inside(
    roots: Vec<u32>,
    folder_key: &Path,
) -> Result<HashSet<u32>, FolderShellsCloseError> {
    let trees = tokio::task::spawn_blocking(move || read_trees(&roots))
        .await
        .map_err(FolderShellsCloseError::Interrupted)?;
    let mut folders_inside: HashMap<PathBuf, bool> = HashMap::new();
    let mut roots_inside = HashSet::new();
    let mut ending_ids = Vec::new();
    let mut is_listed = HashSet::new();
    for tree in trees {
        let Some(root) = tree.first().map(|process| process.id) else {
            continue;
        };
        // Each process comes after its parent, so an ending parent is known before its children.
        let mut ending = HashSet::new();
        for process in &tree {
            let is_parent_ending = process
                .parent
                .is_some_and(|parent| ending.contains(&parent));
            if !is_parent_ending
                && !is_working_inside(process, folder_key, &mut folders_inside).await?
            {
                continue;
            }
            ending.insert(process.id);
            if process.id == root {
                roots_inside.insert(root.as_u32());
            } else if is_listed.insert(process.id) {
                ending_ids.push(process.id.as_u32());
            }
        }
    }
    end_processes(ending_ids)
        .await
        .map_err(FolderShellsCloseError::ProcessesNotEnded)?;
    Ok(roots_inside)
}

// Whether `process` works in the folder whose key is `folder_key` or inside it, each working
// folder resolved once into `folders_inside`.
async fn is_working_inside(
    process: &TreeProcess,
    folder_key: &Path,
    folders_inside: &mut HashMap<PathBuf, bool>,
) -> Result<bool, FolderShellsCloseError> {
    let Some(working_folder) = &process.working_folder else {
        return Ok(false);
    };
    if let Some(is_inside) = folders_inside.get(working_folder) {
        return Ok(*is_inside);
    }
    let key = canonical_folder_path(working_folder)
        .await
        .map_err(FolderShellsCloseError::Folder)?;
    let is_inside = is_contained_within(&key, folder_key);
    folders_inside.insert(working_folder.clone(), is_inside);
    Ok(is_inside)
}

// Every process in each tree under `roots`, in the roots' order, each tree's root first and each
// process after its parent: one pass of pids and parents for every process to find the trees, then
// the working folders of their processes alone.
fn read_trees(roots: &[u32]) -> Vec<Vec<TreeProcess>> {
    let mut system = process_table();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    let trees: Vec<Vec<Pid>> = roots
        .iter()
        .map(|root| tree_under(&system, Pid::from_u32(*root)))
        .collect();
    let pids: Vec<Pid> = trees.iter().flatten().copied().collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cwd(UpdateKind::Always),
    );
    trees
        .iter()
        .map(|tree| {
            tree.iter()
                .map(|pid| {
                    let process = system.process(*pid);
                    TreeProcess {
                        id: *pid,
                        parent: process.and_then(sysinfo::Process::parent),
                        working_folder: process
                            .and_then(sysinfo::Process::cwd)
                            .map(Path::to_path_buf),
                    }
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::io::{self, BufRead as _, BufReader, Write as _};
    use std::path::Path;
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use sidekicks_platforms::{harness_test_name, pass_through_start};
    use sidekicks_workspace::folder::canonical_path::canonical_folder_path;

    use super::end_processes_inside;

    // Set on a stand-in's start, so the harness running ignored tests leaves the stand-in idle.
    const STAND_IN_VARIABLE: &str = "SIDEKICKS_TEST_FOLDER_STAND_IN";
    // The folder a stand-in starts a child stand-in working in.
    const CHILD_FOLDER_VARIABLE: &str = "SIDEKICKS_TEST_FOLDER_STAND_IN_CHILD";
    const READY_LINE: &str = "ready";
    // What a stand-in prints once its child stand-in has ended.
    const CHILD_ENDED_LINE: &str = "child ended";
    // How long a test waits for a line a stand-in prints.
    const LINE_WAIT: Duration = Duration::from_secs(30);

    // A stand-in process working in a folder, which ends once its standard input closes; its
    // output stays open until it has ended, so the harness's last lines have somewhere to go.
    struct StandIn {
        child: Child,
        output: Option<BufReader<ChildStdout>>,
    }

    impl StandIn {
        // Starts this test program's stand-in working in `folder`, and its child in
        // `child_folder`, answering once both are ready.
        fn start(folder: &Path, child_folder: Option<&Path>) -> Self {
            let program = pass_through_start(&harness_test_name(
                module_path!(),
                "folder_process_stand_in",
            ));
            let mut command = Command::new(program.program);
            command
                .args(program.arguments)
                .current_dir(folder)
                .env(STAND_IN_VARIABLE, "1")
                .env_remove(CHILD_FOLDER_VARIABLE)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped());
            if let Some(child_folder) = child_folder {
                command.env(CHILD_FOLDER_VARIABLE, child_folder);
            }
            let mut child = command.spawn().expect("the stand-in starts");
            let mut output =
                BufReader::new(child.stdout.take().expect("the stand-in's output is piped"));
            // The harness writes its own lines around the test's.
            let is_ready = (&mut output)
                .lines()
                .any(|line| line.expect("the stand-in's output reads") == READY_LINE);
            assert!(is_ready, "the stand-in became ready");
            Self {
                child,
                output: Some(output),
            }
        }

        fn process_id(&self) -> u32 {
            self.child.id()
        }

        // Whether the stand-in still runs.
        fn is_running(&mut self) -> bool {
            self.child
                .try_wait()
                .expect("the stand-in's exit reads")
                .is_none()
        }

        // Whether the stand-in prints `line` within the wait, its output read from here on.
        fn prints_line(&mut self, line: &str) -> bool {
            let output = self
                .output
                .take()
                .expect("the stand-in's output is read once");
            let (sender, lines) = mpsc::channel();
            thread::spawn(move || {
                // The test may stop listening first; the rest is still read, so the stand-in's
                // last lines have somewhere to go.
                let mut is_listening = true;
                for printed in output.lines() {
                    let printed = printed.expect("the stand-in's output reads");
                    if is_listening {
                        is_listening = sender.send(printed).is_ok();
                    }
                }
            });
            let deadline = Instant::now() + LINE_WAIT;
            while let Ok(printed) =
                lines.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                if printed == line {
                    return true;
                }
            }
            false
        }
    }

    impl Drop for StandIn {
        fn drop(&mut self) {
            drop(self.child.stdin.take());
            if let Err(error) = self.child.wait() {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a stand-in could not be waited for"
                );
            }
        }
    }

    // The stand-in a folder test starts: it starts its own child where asked, says it is ready,
    // says when its child has ended, and ends its child and itself once its standard input closes.
    #[test]
    #[ignore = "a stand-in process the folder tests start"]
    fn folder_process_stand_in() {
        if std::env::var_os(STAND_IN_VARIABLE).is_none() {
            return;
        }
        let child: Option<(Option<ChildStdin>, JoinHandle<()>)> =
            std::env::var_os(CHILD_FOLDER_VARIABLE).map(|folder| {
                let mut child = StandIn::start(Path::new(&folder), None);
                let input = child.child.stdin.take();
                let waiting = thread::spawn(move || {
                    child
                        .child
                        .wait()
                        .expect("the child stand-in is waited for");
                    writeln!(io::stdout().lock(), "{CHILD_ENDED_LINE}")
                        .expect("the stand-in writes its child's end");
                });
                (input, waiting)
            });
        {
            let mut output = io::stdout().lock();
            writeln!(output, "{READY_LINE}").expect("the stand-in writes its ready line");
            output.flush().expect("the ready line is flushed");
        }
        io::copy(&mut io::stdin().lock(), &mut io::sink()).expect("the stand-in reads its input");
        if let Some((input, waiting)) = child {
            drop(input);
            waiting.join().expect("the child's wait ends");
        }
    }

    // Kills judging a process by its tree rather than by its own folder, and dropping the end of
    // the processes inside: a shell working inside is answered, one outside is kept, and under one
    // outside the child working inside is ended while the shell lives.
    #[tokio::test]
    async fn each_process_is_judged_by_its_own_folder_and_ended_inside_with_its_tree() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let tree = scratch.path().join("tree");
        let outside = scratch.path().join("outside");
        for folder in [&tree, &outside] {
            std::fs::create_dir(folder).expect("a folder is made");
        }
        let inside_shell = StandIn::start(&tree, None);
        let outside_shell = StandIn::start(&outside, None);
        let mut parent_shell = StandIn::start(&outside, Some(&tree));
        let tree_key = canonical_folder_path(&tree)
            .await
            .expect("the tree's folder resolves");

        let roots_inside = end_processes_inside(
            vec![
                inside_shell.process_id(),
                outside_shell.process_id(),
                parent_shell.process_id(),
            ],
            &tree_key,
        )
        .await
        .expect("the processes inside are ended");

        assert_eq!(
            roots_inside.into_iter().collect::<Vec<_>>(),
            vec![inside_shell.process_id()]
        );
        assert!(
            parent_shell.prints_line(CHILD_ENDED_LINE),
            "the child working inside is ended"
        );
        assert!(parent_shell.is_running(), "the shell outside lives");
    }
}
