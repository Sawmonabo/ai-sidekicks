//! Ending shells: a pane's close of one shell, a session's deletion of all of them, and the close
//! of every shell working in a folder about to be moved or deleted. Each ends the shell's
//! subscriptions and releases the holds they carried before the shell leaves its session, then has
//! the terminal let it go and forgets its child in the orphan registry.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use futures::FutureExt as _;
use futures::future::{BoxFuture, join_all};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::TerminalCloseRequest;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::{process_table, tree_under};
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_terminal::{TerminalError, TerminalHandle, Terminals};
use sidekicks_workspace::folder::canonical_path::canonical_folder_path;
use sidekicks_workspace::git::worktree::removal::FolderProcessOwner;
use sidekicks_workspace::trust_envelope::is_contained_within;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
use tokio::task::JoinError;

use crate::integration::injection::ShellMarkNonce;
use crate::orphan::guard::OrphanGuard;
use crate::output::stream::ShellOutputEnd;
use crate::record::ShellRecord;
use crate::refusals::terminal_not_found;
use crate::table::open::discard_unread_nonce;
use crate::table::{ShellTable, TableShared};

/// Holds a deleted session's opens refused until it drops.
pub struct SessionShellsClosed {
    table: Weak<TableShared>,
    session_id: SessionId,
}

impl Drop for SessionShellsClosed {
    fn drop(&mut self) {
        if let Some(table) = self.table.upgrade() {
            table.allow_opens(&self.session_id);
        }
    }
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the shell table and the terminal methods call it"
    )
)]
impl ShellTable {
    /// Ends a shell and removes it, ending its subscriptions and releasing the holds they
    /// carried; refused while a run holds it, and while another device holds it unless `force`.
    /// Of two closes of one shell, the second is refused `terminal.notFound`. Answers once the
    /// terminal has let the shell go, and fails as a fault when its program outlives its kill.
    pub(crate) async fn close(
        &self,
        request: &TerminalCloseRequest,
        device_id: &DeviceId,
    ) -> Result<(), HandlerError> {
        let shell = self
            .shared
            .find_shell(&request.session_id, &request.terminal_id)?;
        let ending = shell
            .lease
            .admit_close(device_id, request.force == Some(true), || {
                self.shared.end_shell(&shell)
            })
            .await?;
        // Another close may have removed the shell while this one waited on its lease.
        let ending = ending.ok_or_else(|| terminal_not_found(&request.terminal_id))?;
        self.shared.forget_if_idle(&request.session_id);
        ending.await
    }

    /// Ends every shell of a session being deleted, whoever holds it and those still opening, so
    /// none keeps running in a folder about to go, and refuses the session's opens
    /// `session.notFound` until the answered hold drops. Answers once every shell's program has
    /// exited; fails with the first program that will not end, the session's opens no longer
    /// refused.
    pub async fn close_session_shells(
        &self,
        session_id: &SessionId,
    ) -> Result<SessionShellsClosed, HandlerError> {
        let opening = {
            let mut sessions = self.shared.lock_sessions();
            let session = self.shared.session_of(&mut sessions, session_id);
            session.close_holds += 1;
            session.opening.values().cloned().collect::<Vec<_>>()
        };
        let hold = SessionShellsClosed {
            table: Arc::downgrade(&self.shared),
            session_id: *session_id,
        };
        // An open under way sees the hold once its shell started and leaves the shell here.
        for mut waiting in opening {
            while waiting.changed().await.is_ok() {}
        }
        let shells: Vec<Arc<ShellRecord>> = self
            .shared
            .lock_sessions()
            .get(session_id)
            .map(|session| session.shells.values().cloned().collect())
            .unwrap_or_default();
        let endings: Vec<_> = shells
            .iter()
            .filter_map(|shell| self.shared.end_shell(shell))
            .collect();
        for ending in endings {
            ending.await?;
        }
        Ok(hold)
    }
}

/// Why the shells working in a folder were not all closed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FolderShellsCloseError {
    /// The folder, or a shell process's working folder, could not be resolved.
    #[error("a working folder could not be resolved")]
    Folder(#[source] io::Error),
    /// The read of the shells' processes ended before it finished.
    #[error("the read of the shells' processes ended before it finished")]
    Interrupted(#[source] JoinError),
    /// A shell working in the folder could not be ended.
    #[error(transparent)]
    NotEnded(#[from] SettleFailures<HandlerError>),
}

impl ShellTable {
    /// Ends every shell, whoever holds it, whose process tree has a process working in `folder` or
    /// inside it, each process judged by its own working folder, so a shell outside whose child
    /// works inside is ended and one with nothing inside lives; shells still opening are waited
    /// for first, so none starts unseen. Answers once every such shell's
    /// program has exited; fails with each that will not end, every other one still ended.
    pub(crate) async fn close_shells_in_folder(
        &self,
        folder: &Path,
    ) -> Result<(), FolderShellsCloseError> {
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
        let is_working_inside =
            are_trees_working_in(shells.iter().map(|(_, pid)| *pid).collect(), &folder_key).await?;
        let picked: Vec<Arc<ShellRecord>> = shells
            .into_iter()
            .zip(is_working_inside)
            .filter_map(|((shell, _), is_inside)| is_inside.then_some(shell))
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

// For each process tree rooted at `roots`, whether a process of it works in the folder whose key
// is `folder_key` or inside it.
async fn are_trees_working_in(
    roots: Vec<u32>,
    folder_key: &Path,
) -> Result<Vec<bool>, FolderShellsCloseError> {
    let trees = tokio::task::spawn_blocking(move || read_tree_working_folders(&roots))
        .await
        .map_err(FolderShellsCloseError::Interrupted)?;
    let mut is_working_inside = Vec::with_capacity(trees.len());
    for working_folders in trees {
        let mut is_inside = false;
        for working_folder in working_folders {
            // A working folder that no longer exists is not inside a folder that does.
            let key = match canonical_folder_path(&working_folder).await {
                Ok(key) => key,
                Err(error) if is_missing_entry(&error) => continue,
                Err(error) => return Err(FolderShellsCloseError::Folder(error)),
            };
            if is_contained_within(&key, folder_key) {
                is_inside = true;
                break;
            }
        }
        is_working_inside.push(is_inside);
    }
    Ok(is_working_inside)
}

// The working folder of every process in each tree under `roots`, in the roots' order: one pass of
// pids and parents for every process to find the trees, then the working folders of their
// processes alone. A process that ended between the passes, or whose folder the system will not
// tell, has none.
fn read_tree_working_folders(roots: &[u32]) -> Vec<Vec<PathBuf>> {
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
                .filter_map(|pid| system.process(*pid)?.cwd().map(Path::to_path_buf))
                .collect()
        })
        .collect()
}

impl TableShared {
    /// Takes `shell` out of its session and starts its end; `None` once it already left. The
    /// answered future lets the terminal go, then forgets the shell's nonces.
    fn end_shell(
        self: &Arc<Self>,
        shell: &Arc<ShellRecord>,
    ) -> Option<BoxFuture<'static, Result<(), HandlerError>>> {
        {
            let mut sessions = self.lock_sessions();
            let session = sessions.get_mut(&shell.session_id)?;
            if !session
                .shells
                .get(&shell.terminal_id)
                .is_some_and(|held| Arc::ptr_eq(held, shell))
            {
                return None;
            }
            session.shells.remove(&shell.terminal_id);
            session.order.retain(|id| *id != shell.terminal_id);
            session.list.mark_changed();
        }
        let (handle, mark_nonce, spawn_nonce) = shell.record_end(ShellOutputEnd::Closed, true);
        self.release_streams(shell);
        let table = Arc::clone(self);
        Some(
            async move {
                let_shell_go(
                    &table.deps.orphan_guard,
                    close_terminal(&table.deps.terminals, handle),
                    mark_nonce,
                    spawn_nonce,
                )
                .await
                .map_err(|error| HandlerError::Internal(Box::new(error)))
            }
            .boxed(),
        )
    }

    fn allow_opens(&self, session_id: &SessionId) {
        if let Some(session) = self.lock_sessions().get_mut(session_id) {
            session.close_holds -= 1;
        }
        self.forget_if_idle(session_id);
    }
}

/// Has the terminals let an ended shell's terminal `handle` go, when it had one.
pub(super) async fn close_terminal(
    terminals: &Terminals,
    handle: Option<TerminalHandle>,
) -> Result<(), TerminalError> {
    match handle {
        Some(handle) => terminals.close(handle).await,
        None => Ok(()),
    }
}

/// Waits for an ended shell's terminal to be let go through `closing`, removes its nonce file, and
/// forgets its child in the orphan registry only once the terminal let it go, so a child that
/// outlived its kill stays for the next start's sweep. Fails as the close does.
pub(super) async fn let_shell_go(
    orphan_guard: &OrphanGuard,
    closing: impl Future<Output = Result<(), TerminalError>>,
    mark_nonce: Option<ShellMarkNonce>,
    spawn_nonce: Option<String>,
) -> Result<(), TerminalError> {
    let closed = closing.await;
    if let Some(mark_nonce) = mark_nonce {
        discard_unread_nonce(&mark_nonce).await;
    }
    if closed.is_ok()
        && let Some(spawn_nonce) = spawn_nonce
    {
        orphan_guard.retire(&spawn_nonce).await;
    }
    closed
}

#[cfg(test)]
mod tests {
    use std::io::{self, BufRead as _, BufReader, Write as _};
    use std::path::Path;
    use std::process::{Child, ChildStdout, Command, Stdio};

    use sidekicks_platforms::{harness_test_name, pass_through_start};
    use sidekicks_terminal::TerminalError;
    use sidekicks_workspace::folder::canonical_path::canonical_folder_path;

    use super::{are_trees_working_in, let_shell_go};
    use crate::orphan::guard::open_orphan_guard;
    use crate::orphan::registry::OrphanRegistry;

    // Set on a stand-in's start, so the harness running ignored tests leaves the stand-in idle.
    const STAND_IN_VARIABLE: &str = "SIDEKICKS_TEST_FOLDER_STAND_IN";
    // The folder a stand-in starts a child stand-in working in.
    const CHILD_FOLDER_VARIABLE: &str = "SIDEKICKS_TEST_FOLDER_STAND_IN_CHILD";
    const READY_LINE: &str = "ready";

    // A stand-in process working in a folder, which ends once its standard input closes; its
    // output stays open until it has ended, so the harness's last lines have somewhere to go.
    struct StandIn {
        child: Child,
        _output: BufReader<ChildStdout>,
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
                _output: output,
            }
        }

        fn process_id(&self) -> u32 {
            self.child.id()
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
    // and ends its child and itself once its standard input closes.
    #[test]
    #[ignore = "a stand-in process the folder tests start"]
    fn folder_process_stand_in() {
        if std::env::var_os(STAND_IN_VARIABLE).is_none() {
            return;
        }
        let child = std::env::var_os(CHILD_FOLDER_VARIABLE)
            .map(|folder| StandIn::start(Path::new(&folder), None));
        let mut output = io::stdout().lock();
        writeln!(output, "{READY_LINE}").expect("the stand-in writes its ready line");
        output.flush().expect("the ready line is flushed");
        io::copy(&mut io::stdin().lock(), &mut io::sink()).expect("the stand-in reads its input");
        drop(child);
    }

    // Kills dropping the working-folder read, and judging only each shell's own folder: a shell
    // working inside is picked, one outside is kept, and one outside whose child works inside is
    // picked.
    #[tokio::test]
    async fn a_shell_is_picked_for_a_folder_when_a_process_of_its_tree_works_inside() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let tree = scratch.path().join("tree");
        let outside = scratch.path().join("outside");
        for folder in [&tree, &outside] {
            std::fs::create_dir(folder).expect("a folder is made");
        }
        let inside_shell = StandIn::start(&tree, None);
        let outside_shell = StandIn::start(&outside, None);
        let parent_shell = StandIn::start(&outside, Some(&tree));
        let tree_key = canonical_folder_path(&tree)
            .await
            .expect("the tree's folder resolves");

        let is_working_inside = are_trees_working_in(
            vec![
                inside_shell.process_id(),
                outside_shell.process_id(),
                parent_shell.process_id(),
            ],
            &tree_key,
        )
        .await
        .expect("the processes' folders are read");

        assert_eq!(is_working_inside, vec![true, false, true]);
    }

    // Fails when the child's nonce is retired before the terminal is let go, so a child that
    // outlived a failed close is lost to the next start's sweep.
    #[tokio::test]
    async fn a_shell_s_child_leaves_the_registry_only_once_its_terminal_is_let_go() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let guard = open_orphan_guard(folder.path())
            .await
            .expect("the guard opens");
        let failed = guard.prepare_spawn().await.expect("an intent is recorded");
        let closed = guard.prepare_spawn().await.expect("an intent is recorded");

        let failure = let_shell_go(
            &guard,
            async { Err(TerminalError::Draining) },
            None,
            Some(failed.clone()),
        )
        .await;
        let_shell_go(&guard, async { Ok(()) }, None, Some(closed.clone()))
            .await
            .expect("the close succeeds");

        assert!(failure.is_err(), "the close's failure is answered");
        let kept: Vec<String> = OrphanRegistry::new(folder.path())
            .read_leftover()
            .await
            .expect("the registry reads")
            .entries
            .into_iter()
            .map(|entry| entry.nonce)
            .collect();
        assert_eq!(kept, vec![failed]);
    }
}
