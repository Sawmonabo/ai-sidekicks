//! The close of what the shells run in a folder about to be moved or deleted. Each process a shell
//! started is judged by its own working folder: a shell working inside is ended with its tree, and
//! under a shell outside each process working inside is ended with every process under it, while
//! the shell lives. A shell whose program the `shell` mode starts as its child, keeping its own
//! folder, is judged by the folder it was told to start in. A process that left its shell's tree,
//! as a daemonized server does, is found by the shell's nonce in its environment and judged the
//! same way, and so is one an ended shell left behind, its nonce kept while a process carries it.
//! The close holds back the opens of the sessions working in the folder until its hold
//! drops, so no shell starts there before the move lands.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use futures::future::{BoxFuture, join_all};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_platforms::{
    DOES_SHELL_MODE_KEEP_ITS_FOLDER, end_processes, process_table, tree_under,
};
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_workspace::folder::canonical_path::canonical_folder_path;
use sidekicks_workspace::git::worktree::removal::{FolderProcessHold, FolderProcessOwner};
use sidekicks_workspace::trust_envelope::is_contained_within;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
use tokio::sync::watch;
use tokio::task::JoinError;

use crate::orphan::nonce_search::find_processes_carrying_nonces;
use crate::record::ShellRecord;
use crate::table::{FolderHold, ShellTable, TableShared};

/// Holds back the opens of the sessions working in a folder whose shells were closed, those begun
/// after the close, until it drops: once the folder's move has landed.
pub(crate) struct FolderShellsClosed {
    table: Weak<TableShared>,
    sequence: u64,
    // Dropped after the hold leaves the table, which wakes each open it held back.
    _released: watch::Sender<()>,
}

impl Drop for FolderShellsClosed {
    fn drop(&mut self) {
        if let Some(table) = self.table.upgrade() {
            table
                .lock_folder_holds()
                .retain(|hold| hold.sequence != self.sequence);
        }
    }
}

/// Why what the shells run in a folder was not all ended.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FolderShellsCloseError {
    /// The folder could not be resolved.
    #[error("the folder could not be resolved")]
    Folder(#[source] io::Error),
    /// The read of the shells' processes ended before it finished.
    #[error("the read of the shells' processes ended before it finished")]
    Interrupted(#[source] JoinError),
    /// A process working in the folder, with those under it, could not be ended, so the shells
    /// working inside were left open.
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
    /// living. The opens of the sessions working in the folder begun from here on wait until the
    /// answered hold drops, and those already under way are waited for first. Answers once each
    /// ended program has exited. Fails with what will not end, the opens no longer held back: a
    /// shell that will not close leaves the other shells closed, and a process that will not end
    /// leaves the shells working inside open.
    async fn close_shells_in_folder(
        &self,
        folder: &Path,
    ) -> Result<FolderShellsClosed, FolderShellsCloseError> {
        let folder_key = canonical_folder_path(folder)
            .await
            .map_err(FolderShellsCloseError::Folder)?;
        let (released, released_reader) = watch::channel(());
        let (sequence, opening): (u64, Vec<_>) = {
            let sessions = self.shared.lock_sessions();
            let sequence = self.shared.next_sequence();
            self.shared.lock_folder_holds().push(FolderHold {
                sequence,
                folder_key: folder_key.clone(),
                released: released_reader,
            });
            let opening = sessions
                .iter()
                .filter(|(_, session)| !session.opening.is_empty())
                .map(|(session_id, session)| {
                    (
                        *session_id,
                        session.opening.values().cloned().collect::<Vec<_>>(),
                    )
                })
                .collect();
            (sequence, opening)
        };
        let hold = FolderShellsClosed {
            table: Arc::downgrade(&self.shared),
            sequence,
            _released: released,
        };
        for (session_id, waiting) in opening {
            if self.is_session_outside(session_id, &folder_key).await {
                continue;
            }
            for mut waiting in waiting {
                while waiting.changed().await.is_ok() {}
            }
        }
        let terminals = &self.shared.deps.terminals;
        let shells: Vec<(Arc<ShellRecord>, u32)> = self
            .shared
            .lock_sessions()
            .values()
            .flat_map(|session| session.shells.values())
            .filter_map(|shell| Some((Arc::clone(shell), terminals.process_id(shell.handle()?)?)))
            .collect();
        let ended_nonces = self.shared.lock_ended_nonces().clone();
        if shells.is_empty() && ended_nonces.is_empty() {
            return Ok(hold);
        }
        let roots = shells
            .iter()
            .map(|(shell, process_id)| {
                let told_folder =
                    DOES_SHELL_MODE_KEEP_ITS_FOLDER.then(|| shell.start_folder.clone());
                (*process_id, told_folder)
            })
            .collect();
        let nonces = shells
            .iter()
            .filter_map(|(shell, _)| shell.spawn_nonce())
            .chain(ended_nonces.iter().cloned())
            .collect();
        let EndedInside {
            roots_inside,
            carried_nonces,
        } = end_processes_inside(roots, nonces, &folder_key).await?;
        // An ended shell's nonce no process carries any more has nothing left to find.
        self.shared
            .lock_ended_nonces()
            .retain(|nonce| !ended_nonces.contains(nonce) || carried_nonces.contains(nonce));
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
        Ok(hold)
    }

    // Whether the session works outside the folder whose key is `folder_key`: `false` for a
    // session whose folder cannot be read, so its open is waited for.
    async fn is_session_outside(&self, session_id: SessionId, folder_key: &Path) -> bool {
        let Ok(session) = (self.shared.deps.read_working_folder)(session_id).await else {
            return false;
        };
        let Some(working_folder) = session.working_folder else {
            return true;
        };
        match canonical_folder_path(&working_folder).await {
            Ok(key) => !is_contained_within(&key, folder_key),
            Err(_) => false,
        }
    }
}

impl TableShared {
    /// Waits for the folder hold taken before the open `open_sequence` over `session_id`'s working
    /// `folder`, if one is in force; answers whether it waited, so the open reads its folder again.
    /// Refuses `session.notFound` once the session's deletion begins, so a deletion never waits for
    /// a move, and fails as a fault when the folder cannot be resolved.
    pub(in crate::table) async fn wait_for_folder_hold(
        self: &Arc<Self>,
        session_id: &SessionId,
        folder: &Path,
        open_sequence: u64,
    ) -> Result<bool, HandlerError> {
        let folder_key = canonical_folder_path(folder)
            .await
            .map_err(|error| HandlerError::Internal(Box::new(error)))?;
        let mut close_begun = {
            let mut sessions = self.lock_sessions();
            let session = self.session_of(&mut sessions, session_id);
            if session.close_holds > 0 {
                return Err(session_not_found(session_id).into());
            }
            session.close_begun.subscribe()
        };
        let released = self
            .lock_folder_holds()
            .iter()
            .find(|hold| {
                hold.sequence < open_sequence && is_contained_within(&folder_key, &hold.folder_key)
            })
            .map(|hold| hold.released.clone());
        let Some(mut released) = released else {
            return Ok(false);
        };
        // The hold never sends; its sender drops as the hold does.
        let hold_released = async { while released.changed().await.is_ok() {} };
        tokio::select! {
            () = hold_released => Ok(true),
            Ok(()) = close_begun.changed() => Err(session_not_found(session_id).into()),
        }
    }
}

impl FolderProcessOwner for ShellTable {
    fn end_processes_in_folder<'a>(
        &'a self,
        folder: &'a Path,
    ) -> BoxFuture<'a, Result<FolderProcessHold, Box<dyn Error + Send + Sync>>> {
        // The removal keeps the hold until its move or deletion lands.
        Box::pin(async move {
            Ok(Box::new(self.close_shells_in_folder(folder).await?) as FolderProcessHold)
        })
    }
}

// What a close's kills answer: the shells that work inside themselves, left running for the caller
// to close, and the nonces some process still carried.
struct EndedInside {
    roots_inside: HashSet<u32>,
    carried_nonces: HashSet<String>,
}

// One process of a tree, with its parent and its working folder; `None` where the process ended
// or the system will not tell its folder.
struct TreeProcess {
    id: Pid,
    parent: Option<Pid>,
    working_folder: Option<PathBuf>,
}

// The processes under one root: a shell's, or one that carries a shell's nonce outside every
// shell's tree.
struct ProcessTree {
    is_shell: bool,
    processes: Vec<TreeProcess>,
}

// Ends, under each of the shells `roots` and each process outside their trees that carries one of
// `nonces`, every process working in the folder whose key is `folder_key` or inside it, with every
// process under it, and answers the shells that work inside themselves, which are left running
// with their trees for the caller to close, and the nonces a process carried. A shell given with the folder it was told to start in
// is judged by that folder rather than its process's own.
async fn end_processes_inside(
    roots: Vec<(u32, Option<PathBuf>)>,
    nonces: HashSet<String>,
    folder_key: &Path,
) -> Result<EndedInside, FolderShellsCloseError> {
    let (root_ids, told_folders): (Vec<u32>, Vec<Option<PathBuf>>) = roots.into_iter().unzip();
    let (mut trees, carried_nonces) =
        tokio::task::spawn_blocking(move || read_trees(&root_ids, &nonces))
            .await
            .map_err(FolderShellsCloseError::Interrupted)?;
    // The shells' trees come first, in the roots' order, each root first.
    for (tree, told_folder) in trees.iter_mut().zip(told_folders) {
        if let (Some(root), Some(told_folder)) = (tree.processes.first_mut(), told_folder) {
            root.working_folder = Some(told_folder);
        }
    }
    let mut folders_inside: HashMap<PathBuf, bool> = HashMap::new();
    let mut roots_inside = HashSet::new();
    let mut ending_ids = Vec::new();
    let mut is_listed = HashSet::new();
    for tree in trees {
        let Some(root) = tree.processes.first().map(|process| process.id) else {
            continue;
        };
        // Each process comes after its parent, so an ending parent is known before its children.
        let mut ending = HashSet::new();
        for process in &tree.processes {
            let is_parent_ending = process
                .parent
                .is_some_and(|parent| ending.contains(&parent));
            if !is_parent_ending
                && !is_working_inside(process, folder_key, &mut folders_inside).await
            {
                continue;
            }
            ending.insert(process.id);
            if tree.is_shell && process.id == root {
                roots_inside.insert(root.as_u32());
            } else if is_listed.insert(process.id) {
                ending_ids.push(process.id.as_u32());
            }
        }
    }
    end_processes(ending_ids)
        .await
        .map_err(FolderShellsCloseError::ProcessesNotEnded)?;
    Ok(EndedInside {
        roots_inside,
        carried_nonces,
    })
}

// Whether `process` works in the folder whose key is `folder_key` or inside it: a working folder
// whose own path lies inside is, and any other is resolved once into `folders_inside`. A folder
// that cannot be resolved, behind a refused permission or an unresponsive mount, counts as outside,
// so one such process elsewhere never holds back every close.
async fn is_working_inside(
    process: &TreeProcess,
    folder_key: &Path,
    folders_inside: &mut HashMap<PathBuf, bool>,
) -> bool {
    let Some(working_folder) = &process.working_folder else {
        return false;
    };
    if is_contained_within(working_folder, folder_key) {
        return true;
    }
    if let Some(is_inside) = folders_inside.get(working_folder) {
        return *is_inside;
    }
    let is_inside = match canonical_folder_path(working_folder).await {
        Ok(key) => is_contained_within(&key, folder_key),
        Err(error) => {
            tracing::debug!(
                process_id = process.id.as_u32(),
                error = &error as &(dyn Error + 'static),
                "a process's working folder could not be resolved, so it counts as outside"
            );
            false
        }
    };
    folders_inside.insert(working_folder.clone(), is_inside);
    is_inside
}

// Every process in each tree under the shells `roots`, in their order, then under each topmost
// process outside those trees carrying one of `nonces`, each tree's root first and each process
// after its parent: one pass of pids and parents for every process to find the trees, then the
// working folders of their processes alone. Answers too the nonces some process carries. Blocks on
// the reads.
fn read_trees(roots: &[u32], nonces: &HashSet<String>) -> (Vec<ProcessTree>, HashSet<String>) {
    let mut system = process_table();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    let mut trees: Vec<(bool, Vec<Pid>)> = roots
        .iter()
        .map(|root| (true, tree_under(&system, Pid::from_u32(*root))))
        .collect();
    let in_shell_trees: HashSet<Pid> = trees.iter().flat_map(|(_, tree)| tree).copied().collect();
    let carried = find_processes_carrying_nonces(&nonces.iter().map(String::as_str).collect());
    let carriers: HashSet<Pid> = carried.keys().copied().map(Pid::from_u32).collect();
    let carried_nonces = carried.into_values().collect();
    let mut escaped: Vec<Pid> = carriers
        .iter()
        .copied()
        .filter(|carrier| !in_shell_trees.contains(carrier))
        .filter(|carrier| {
            let parent = system.process(*carrier).and_then(sysinfo::Process::parent);
            parent.is_none_or(|parent| !carriers.contains(&parent))
        })
        .collect();
    escaped.sort_unstable();
    trees.extend(
        escaped
            .into_iter()
            .map(|carrier| (false, tree_under(&system, carrier))),
    );
    let pids: Vec<Pid> = trees.iter().flat_map(|(_, tree)| tree).copied().collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cwd(UpdateKind::Always),
    );
    let trees = trees
        .iter()
        .map(|(is_shell, tree)| ProcessTree {
            is_shell: *is_shell,
            processes: tree
                .iter()
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
                .collect(),
        })
        .collect();
    (trees, carried_nonces)
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

    use std::collections::HashSet;

    use std::sync::Arc;

    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::terminal::TerminalOpenRequest;
    use sidekicks_contracts::wire::id::ClientUuid;
    use sidekicks_ipc::registry::HandlerError;
    use tokio::sync::watch;

    use super::end_processes_inside;
    use crate::orphan::registry::SPAWN_NONCE_ENVIRONMENT_NAME;
    use crate::test_table::{session, table_fixture};

    // Set on a stand-in's start, so the harness running ignored tests leaves the stand-in idle.
    const STAND_IN_VARIABLE: &str = "SIDEKICKS_TEST_FOLDER_STAND_IN";
    // The folder a stand-in starts a child stand-in working in.
    const CHILD_FOLDER_VARIABLE: &str = "SIDEKICKS_TEST_FOLDER_STAND_IN_CHILD";
    const READY_LINE: &str = "ready";
    // What a stand-in prints once its child stand-in has ended.
    const CHILD_ENDED_LINE: &str = "child ended";
    // How long a test waits for a line a stand-in prints or for its end.
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
            Self::start_carrying(folder, child_folder, None)
        }

        // Starts a stand-in as [`Self::start`] does, carrying `nonce` in its environment as a
        // shell's processes carry their shell's.
        fn start_carrying(folder: &Path, child_folder: Option<&Path>, nonce: Option<&str>) -> Self {
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
            if let Some(nonce) = nonce {
                command.env(SPAWN_NONCE_ENVIRONMENT_NAME, nonce);
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

        // Whether the stand-in has ended within the wait; a killed process can still be exiting
        // once its kill's wait answers, so its end is read again until it lands.
        fn ends_within_wait(&mut self) -> bool {
            let deadline = Instant::now() + LINE_WAIT;
            while self.is_running() {
                if Instant::now() >= deadline {
                    return false;
                }
                thread::sleep(Duration::from_millis(10));
            }
            true
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

    // Kills judging a process by its tree rather than by its own folder, dropping the end of the
    // processes inside, and judging a shell given its told folder by its own: a shell working
    // inside is answered, one outside is kept, under one outside the child working inside is ended
    // while the shell lives, and one outside told to start inside is answered.
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
        let told_shell = StandIn::start(&outside, None);
        let tree_key = canonical_folder_path(&tree)
            .await
            .expect("the tree's folder resolves");

        let ended = end_processes_inside(
            vec![
                (inside_shell.process_id(), None),
                (outside_shell.process_id(), None),
                (parent_shell.process_id(), None),
                (told_shell.process_id(), Some(tree.clone())),
            ],
            HashSet::new(),
            &tree_key,
        )
        .await
        .expect("the processes inside are ended");

        assert_eq!(
            ended.roots_inside,
            HashSet::from([inside_shell.process_id(), told_shell.process_id()])
        );
        assert!(
            parent_shell.prints_line(CHILD_ENDED_LINE),
            "the child working inside is ended"
        );
        assert!(parent_shell.is_running(), "the shell outside lives");
    }

    // Kills dropping the nonce search: a process carrying a shell's nonce that left the shell's
    // tree and works inside is ended, while the shell outside lives.
    #[tokio::test]
    async fn a_process_that_left_its_shell_s_tree_is_found_by_its_nonce_and_ended_inside() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let tree = scratch.path().join("tree");
        let outside = scratch.path().join("outside");
        for folder in [&tree, &outside] {
            std::fs::create_dir(folder).expect("a folder is made");
        }
        let nonce = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d10";
        let mut shell = StandIn::start_carrying(&outside, None, Some(nonce));
        let mut escaped = StandIn::start_carrying(&tree, None, Some(nonce));
        let tree_key = canonical_folder_path(&tree)
            .await
            .expect("the tree's folder resolves");

        let ended = end_processes_inside(
            vec![(shell.process_id(), None)],
            HashSet::from([nonce.to_owned()]),
            &tree_key,
        )
        .await
        .expect("the processes inside are ended");

        assert!(
            ended.roots_inside.is_empty(),
            "the shell outside is not closed"
        );
        assert_eq!(
            ended.carried_nonces,
            HashSet::from([nonce.to_owned()]),
            "the nonce a process carries is kept"
        );
        assert!(
            escaped.ends_within_wait(),
            "the process that left the tree is ended"
        );
        assert!(shell.is_running(), "the shell outside lives");
    }

    // Kills dropping the folder hold: an open begun after the close waits while the hold lasts,
    // so no shell of its session starts in the folder, and goes on once the hold drops.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_open_begun_after_a_folder_close_waits_until_the_hold_drops() {
        let (_gate, gate_reader) = watch::channel(true);
        let fixture = table_fixture(gate_reader).await;
        let request = TerminalOpenRequest {
            session_id: session(),
            client_idempotency_key: ClientUuid::new(
                "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0001".to_owned(),
            )
            .expect("a client UUID"),
        };

        let hold = fixture
            .table
            .close_shells_in_folder(&fixture.working_folder)
            .await
            .expect("the folder's shells close");
        let mut opening = tokio::spawn({
            let table = Arc::clone(&fixture.table);
            async move { table.open(request).await }
        });
        let is_held = tokio::time::timeout(Duration::from_millis(300), &mut opening)
            .await
            .is_err();
        let shell_count_while_held = fixture
            .table
            .shared
            .lock_sessions()
            .get(&session())
            .map_or(0, |session| session.shells.len());
        drop(hold);
        let opened = opening.await.expect("the open's task ends");

        assert!(is_held, "the open waits while the hold lasts");
        assert_eq!(
            shell_count_while_held, 0,
            "no shell starts while the hold lasts"
        );
        opened.expect("the open goes on once the hold drops");
    }

    // Kills dropping the held open's wake on the session's deletion: a deletion begun while a
    // folder hold keeps an open waiting settles with the hold still in force, and the open is
    // refused as the session's other opens are.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_deleted_while_its_open_waits_on_a_folder_hold_refuses_the_open() {
        let (_gate, gate_reader) = watch::channel(true);
        let fixture = table_fixture(gate_reader).await;
        let request = TerminalOpenRequest {
            session_id: session(),
            client_idempotency_key: ClientUuid::new(
                "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0002".to_owned(),
            )
            .expect("a client UUID"),
        };

        let hold = fixture
            .table
            .close_shells_in_folder(&fixture.working_folder)
            .await
            .expect("the folder's shells close");
        let mut opening = tokio::spawn({
            let table = Arc::clone(&fixture.table);
            async move { table.open(request).await }
        });
        let is_held = tokio::time::timeout(Duration::from_millis(300), &mut opening)
            .await
            .is_err();
        let deleted =
            tokio::time::timeout(LINE_WAIT, fixture.table.close_session_shells(&session())).await;
        drop(hold);
        let opened = opening.await.expect("the open's task ends");

        assert!(is_held, "the open waits while the hold lasts");
        drop(
            deleted
                .expect("the deletion settles while the folder's hold lasts")
                .expect("the deletion ends every shell"),
        );
        let refusal = match opened.expect_err("the held open is refused") {
            HandlerError::Refused(refusal) => refusal.code,
            other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
                panic!("a refusal, not {other:?}")
            }
        };
        assert_eq!(refusal, RefusalCode::SessionNotFound);
    }
}
