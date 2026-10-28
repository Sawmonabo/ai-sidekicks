//! A session's shells: the session → shell → terminal table and every act on it. Each shell's
//! record holds its control lease, its flow control, its screen copy and its ordered input, and a
//! task per running shell takes its terminal's output and exit.
//!
//! A request naming a shell its session does not have is refused `terminal.notFound`, and a take or
//! a write naming an output subscription that is not the calling connection's own open
//! subscription to that shell is refused `terminal.output.subscriptionNotFound` before the lease
//! reads it. A connection's end releases its bindings on every shell before its subscriptions end,
//! so a hold that ends with it is released as a disconnect. A shell keeps running until it is
//! closed, its program exits or its session is deleted; an exited shell keeps its record and its
//! scrollback. Each shell's screen copy answers what its program asks the terminal, its colors and
//! cell size from the pane holding it, which a change of holder forgets, or else from the console
//! theme the desktop last reported for every shell.

mod end;
mod open;
mod output;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::control::TerminalFlowControlUpdateRequest;
use sidekicks_contracts::terminal::{
    TerminalAppearanceReportRequest, TerminalColors, TerminalId, TerminalListEntry,
    TerminalListUpdate, TerminalReorderRequest, TerminalResizeRequest,
};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{HandlerError, TransportId};
use sidekicks_ipc::stream::latest_value::LatestValueOutlet;
use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
use sidekicks_terminal::{CommandLine, TerminalHandle, Terminals};
use sidekicks_workspace::working_folder::SessionWorkingFolder;
use tokio::runtime::Handle;
use tokio::sync::watch;

use crate::control_lease::{
    LeaseBroadcast, LeaseReading, ShellConnection, ShellControlLease, ShellLeaseCaller,
};
use crate::input_lookup::ShellInputLookup;
use crate::integration::injection::{ShellMarkNonce, ShellStartupFolders};
use crate::list::ShellListFollowers;
use crate::orphan::guard::OrphanGuard;
use crate::output::screen::{ShellScreenAppearance, cut_title};
use crate::output::stream::ShellOutputEnd;
use crate::record::{ShellRecord, ShellRecordDeps};
use crate::refusals::terminal_not_found;
use crate::resize::{ShellResizeError, ShellSize};

/// Reads a session's shape and working folder; refuses a session this daemon does not hold
/// `session.notFound`.
pub(crate) type ReadSessionWorkingFolder = Arc<
    dyn Fn(SessionId) -> BoxFuture<'static, Result<SessionWorkingFolder, HandlerError>>
        + Send
        + Sync,
>;

/// Reads, at each shell's start, what the shell takes from the machine's settings file.
pub(crate) type ReadShellSettings =
    Arc<dyn Fn(SessionId) -> BoxFuture<'static, Result<ShellSettings, HandlerError>> + Send + Sync>;

/// What a session's shell takes from the machine's settings file, read at its start.
pub(crate) struct ShellSettings {
    /// Whether `Simplify for a screen reader` is on.
    pub(crate) is_screen_reader_mode_on: bool,
    /// The `Every project` rows.
    pub(crate) every_project_rows: Vec<EnvironmentRow>,
    /// The session's project's rows.
    pub(crate) project_rows: Vec<EnvironmentRow>,
}

/// What the shell table is built from.
pub(crate) struct ShellTableDeps {
    /// The daemon's terminals.
    pub(crate) terminals: Arc<Terminals>,
    /// This machine's own device id, which a run's hold names.
    pub(crate) machine_device_id: DeviceId,
    /// What each shell's terminal answers a program asking its name and version.
    pub(crate) terminal_version: String,
    /// Appends one change of a shell's holder to its session's event log.
    pub(crate) append_control_change: LeaseBroadcast,
    /// Reads a session's shape and working folder.
    pub(crate) read_working_folder: ReadSessionWorkingFolder,
    /// Reads what a shell takes from the machine's settings file.
    pub(crate) read_shell_settings: ReadShellSettings,
    /// The login shell's environment captured at the daemon's start.
    pub(crate) base_environment: Vec<(String, String)>,
    /// The names a person's row may not set.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
    /// The variables each provider reads as the screen-reader switch.
    pub(crate) screen_reader_environment_names: Vec<&'static str>,
    /// The folders every shell's start writes its scripts and nonce file in.
    pub(crate) startup_folders: ShellStartupFolders,
    /// The daemon's `shell` mode with its arguments.
    pub(crate) shell_mode: CommandLine,
    /// The registry of terminal children a crash could leave behind.
    pub(crate) orphan_guard: Arc<OrphanGuard>,
    /// The daemon's runtime, which every task a shell starts runs on, so work started from a drop
    /// after the runtime stopped is dropped rather than panicking.
    pub(crate) runtime: Handle,
}

/// One session's shells, in tab order, and who follows its list.
struct SessionShells {
    order: Vec<TerminalId>,
    shells: HashMap<TerminalId, Arc<ShellRecord>>,
    /// The opens under way by their key; a retry waits until the first one's sender drops.
    opening: HashMap<ClientUuid, watch::Receiver<()>>,
    list: ShellListFollowers,
    /// The deletions of the session under way, each refusing its opens until it settles.
    close_holds: usize,
    /// Changes as each deletion of the session begins, waking the opens a folder hold keeps.
    close_begun: watch::Sender<()>,
}

/// A folder whose shells were closed before its move, holding back the opens begun after it of the
/// sessions working in it until the hold drops.
struct FolderHold {
    /// Where the hold falls among the opens, from the table's one count.
    sequence: u64,
    /// The folder's key, resolved.
    folder_key: PathBuf,
    /// Answers its change once the hold drops.
    released: watch::Receiver<()>,
}

/// The table's state and what it calls out to, shared with every shell's output task.
struct TableShared {
    deps: ShellTableDeps,
    record_deps: Arc<ShellRecordDeps>,
    sessions: Mutex<HashMap<SessionId, SessionShells>>,
    /// The folder holds in force, each taken under the sessions' lock.
    folder_holds: Mutex<Vec<FolderHold>>,
    /// The spawn nonces of ended shells, kept until a folder close finds no process carrying one,
    /// so a process an ended shell left behind is still ended with its folder.
    ended_nonces: Mutex<HashSet<String>>,
    /// The one count that orders the opens and the folder holds, taken under the sessions' lock.
    sequence: AtomicU64,
}

/// Every session's shells in this daemon.
pub struct ShellTable {
    shared: Arc<TableShared>,
}

#[expect(
    dead_code,
    reason = "the daemon's start builds the shell table and the terminal methods call it"
)]
impl ShellTable {
    /// The table over `deps`, holding no shell.
    pub(crate) fn new(deps: ShellTableDeps) -> Self {
        let record_deps = Arc::new(ShellRecordDeps {
            terminals: Arc::clone(&deps.terminals),
            machine_device_id: deps.machine_device_id.clone(),
            terminal_version: deps.terminal_version.clone(),
            append_control_change: Arc::clone(&deps.append_control_change),
            console_colors: Arc::new(Mutex::new(None)),
            runtime: deps.runtime.clone(),
        });
        Self {
            shared: Arc::new(TableShared {
                deps,
                record_deps,
                sessions: Mutex::new(HashMap::new()),
                folder_holds: Mutex::new(Vec::new()),
                ended_nonces: Mutex::new(HashSet::new()),
                sequence: AtomicU64::new(0),
            }),
        }
    }

    /// Follows a session's shells: `outlet` gets the whole list now and after every change.
    /// Refuses a session this daemon does not hold `session.notFound`. Answers the unfollow.
    pub(crate) async fn follow_list(
        &self,
        session_id: SessionId,
        outlet: LatestValueOutlet<TerminalListUpdate>,
    ) -> Result<impl FnOnce() + Send + use<>, HandlerError> {
        (self.shared.deps.read_working_folder)(session_id).await?;
        let (list, id) = {
            let mut sessions = self.shared.lock_sessions();
            let list = self
                .shared
                .session_of(&mut sessions, &session_id)
                .list
                .clone();
            (list.clone(), list.follow(outlet))
        };
        let table = Arc::downgrade(&self.shared);
        Ok(move || {
            list.unfollow(id);
            if let Some(table) = table.upgrade() {
                table.forget_if_idle(&session_id);
            }
        })
    }

    /// Puts the named shells first in the given order; any it does not name keep theirs after.
    /// Refuses a session this daemon does not hold `session.notFound` and a shell the session
    /// does not have `terminal.notFound`, changing nothing.
    pub(crate) async fn reorder(
        &self,
        request: &TerminalReorderRequest,
    ) -> Result<(), HandlerError> {
        let named: Vec<TerminalId> = request.terminal_ids.as_slice().to_vec();
        let missing = {
            let mut sessions = self.shared.lock_sessions();
            match sessions.get_mut(&request.session_id) {
                None => Some(named[0].clone()),
                Some(session) => {
                    let missing = named
                        .iter()
                        .find(|id| !session.shells.contains_key(*id))
                        .cloned();
                    if missing.is_none() {
                        let unnamed: Vec<TerminalId> = session
                            .order
                            .iter()
                            .filter(|id| !named.contains(id))
                            .cloned()
                            .collect();
                        session.order = named.into_iter().chain(unnamed).collect();
                        session.list.mark_changed();
                    }
                    missing
                }
            }
        };
        if let Some(missing) = missing {
            return Err(self
                .shared
                .refuse_missing_shell(&request.session_id, &missing)
                .await);
        }
        Ok(())
    }

    /// Whether the shell reports its prompt and command marks: false until its first prompt mark
    /// carrying its nonce arrives. Refuses a shell the session does not have `terminal.notFound`.
    pub(crate) fn is_reporting_marks(
        &self,
        session_id: &SessionId,
        terminal_id: &TerminalId,
    ) -> Result<bool, DomainError> {
        Ok(self
            .shared
            .find_shell(session_id, terminal_id)?
            .is_reporting_marks())
    }

    /// Whether a device typed into the shell since its last prompt mark, so a run takes only a
    /// shell sitting idle at its prompt. Refuses as [`Self::is_reporting_marks`] does.
    pub(crate) fn has_input_since_prompt(
        &self,
        session_id: &SessionId,
        terminal_id: &TerminalId,
    ) -> Result<bool, DomainError> {
        Ok(self
            .shared
            .find_shell(session_id, terminal_id)?
            .has_input_since_prompt())
    }

    /// The lease of the shell the caller's output subscription streams, for a take through that
    /// pane. Refuses a shell the session does not have `terminal.notFound`, and a subscription
    /// that is not the calling connection's own open one to it
    /// `terminal.output.subscriptionNotFound`.
    pub(crate) fn lease_for_output_subscription(
        &self,
        session_id: &SessionId,
        terminal_id: &TerminalId,
        caller: &ShellLeaseCaller,
    ) -> Result<Arc<ShellControlLease>, DomainError> {
        let shell = self.shared.find_shell(session_id, terminal_id)?;
        let is_own = shell.streams().contains(&(
            caller.output_subscription_id,
            caller.connection.transport_id,
        ));
        if !is_own {
            return Err(crate::refusals::output_subscription_not_found(
                terminal_id,
                &caller.output_subscription_id,
            ));
        }
        Ok(Arc::clone(&shell.lease))
    }

    /// The lookup `terminal.write` finds each write's shell input through, refusing a write
    /// naming no shell as [`Self::reorder`] does.
    pub(crate) fn input_lookup(&self) -> ShellInputLookup {
        let table = Arc::downgrade(&self.shared);
        Arc::new(move |session_id, terminal_id| {
            let Some(table) = table.upgrade() else {
                let refusal = HandlerError::from(terminal_not_found(terminal_id));
                return Err(futures::future::ready(refusal).boxed());
            };
            match table.held_shell(session_id, terminal_id) {
                Some(shell) => Ok(Arc::clone(&shell.input)),
                None => Err(table.refuse_missing_shell(session_id, terminal_id)),
            }
        })
    }

    /// Sizes a shell from a connection its hold is bound to; answers once the terminal has this
    /// size or a newer one. Refuses as the lease does, and a shell the session does not have
    /// `terminal.notFound`; fails as a fault when the terminal refused the size.
    pub(crate) async fn resize(
        &self,
        request: &TerminalResizeRequest,
        caller: &ShellConnection,
    ) -> Result<(), HandlerError> {
        let shell = self
            .shared
            .find_shell(&request.session_id, &request.terminal_id)?;
        let size = ShellSize {
            columns: u16::try_from(request.columns.get()).unwrap_or(u16::MAX),
            rows: u16::try_from(request.rows.get()).unwrap_or(u16::MAX),
        };
        let applied = shell
            .lease
            .admit_from_holding_connection(caller, || shell.resize(size))
            .await?;
        match applied.await {
            Ok(()) | Err(ShellResizeError::Ended) => Ok(()),
            Err(error @ ShellResizeError::Failed(_)) => {
                Err(HandlerError::Internal(Box::new(error)))
            }
        }
    }

    /// Keeps the appearance a shell's program is answered from: the console theme's colors for
    /// every shell, or the colors and cell size of the pane holding one shell, which only a
    /// connection its hold is bound to may report. A pane's report refuses as a resize does.
    pub(crate) async fn report_terminal_appearance(
        &self,
        request: TerminalAppearanceReportRequest,
        caller: &ShellConnection,
    ) -> Result<(), DomainError> {
        match request {
            TerminalAppearanceReportRequest::ConsoleTheme { colors } => {
                *self.shared.lock_console_colors() = Some(Arc::new(colors));
                Ok(())
            }
            TerminalAppearanceReportRequest::HoldingPane {
                session_id,
                terminal_id,
                colors,
                cell_size,
            } => {
                let shell = self.shared.find_shell(&session_id, &terminal_id)?;
                shell
                    .lease
                    .admit_from_holding_connection(caller, || {
                        shell.set_pane_appearance(ShellScreenAppearance {
                            colors: Some(Arc::new(colors)),
                            cell_size: Some(cell_size),
                        });
                    })
                    .await
            }
        }
    }

    /// Records whether a connection has fallen behind on a shell; its streams that missed output
    /// reseed from the scrollback once it caught up. Naming a shell the session does not have, or
    /// one that no longer runs, changes nothing, since the call may race a closing shell.
    pub(crate) fn declare_flow_control(
        &self,
        request: &TerminalFlowControlUpdateRequest,
        transport_id: TransportId,
    ) {
        if let Ok(shell) = self
            .shared
            .find_shell(&request.session_id, &request.terminal_id)
            && shell.handle().is_some()
        {
            shell.declare_flow_control(transport_id, request.paused);
        }
    }

    /// Ends a closed connection's bindings on every shell's hold, a hold ending with its last as a
    /// disconnect. Called before the connection's subscriptions end, so their ends find nothing
    /// left; a release that cannot be appended goes to the service log.
    pub(crate) fn release_connection(&self, transport_id: TransportId) {
        for shell in self.shared.every_shell() {
            self.shared.deps.runtime.spawn(async move {
                if let Err(error) = shell.lease.release_connection(transport_id).await {
                    log_failure(&shell, "could not release its hold at a disconnect", &error);
                }
            });
        }
    }
}

impl TableShared {
    fn lock_sessions(&self) -> MutexGuard<'_, HashMap<SessionId, SessionShells>> {
        self.sessions
            .lock()
            .expect("no panic holds the shell table, since a panic ends the daemon")
    }

    fn lock_folder_holds(&self) -> MutexGuard<'_, Vec<FolderHold>> {
        self.folder_holds
            .lock()
            .expect("no panic holds the folder holds, since a panic ends the daemon")
    }

    fn lock_ended_nonces(&self) -> MutexGuard<'_, HashSet<String>> {
        self.ended_nonces
            .lock()
            .expect("no panic holds the ended shells' nonces, since a panic ends the daemon")
    }

    /// Records `shell`'s end as [`ShellRecord::record_end`] does, keeping its spawn nonce among the
    /// ended shells' for the folder closes to search.
    fn record_shell_end(
        &self,
        shell: &ShellRecord,
        end: ShellOutputEnd,
        is_removed: bool,
    ) -> (
        Option<TerminalHandle>,
        Option<ShellMarkNonce>,
        Option<String>,
    ) {
        let (handle, mark_nonce, spawn_nonce) = shell.record_end(end, is_removed);
        if let Some(spawn_nonce) = &spawn_nonce {
            self.lock_ended_nonces().insert(spawn_nonce.clone());
        }
        (handle, mark_nonce, spawn_nonce)
    }

    /// The next place in the order of opens and folder holds; taken under the sessions' lock.
    fn next_sequence(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed)
    }

    fn lock_console_colors(&self) -> MutexGuard<'_, Option<Arc<TerminalColors>>> {
        self.record_deps
            .console_colors
            .lock()
            .expect("no panic holds the console colors, since a panic ends the daemon")
    }

    /// The session's shells, made empty when the table holds none of it yet.
    fn session_of<'s>(
        self: &Arc<Self>,
        sessions: &'s mut HashMap<SessionId, SessionShells>,
        session_id: &SessionId,
    ) -> &'s mut SessionShells {
        sessions.entry(*session_id).or_insert_with(|| {
            let table = Arc::downgrade(self);
            let session = *session_id;
            SessionShells {
                order: Vec::new(),
                shells: HashMap::new(),
                opening: HashMap::new(),
                list: ShellListFollowers::new(Arc::new(move || {
                    read_list(table.clone(), session).boxed()
                })),
                close_holds: 0,
                close_begun: watch::channel(()).0,
            }
        })
    }

    /// A session with no shell, no open under way, no one following its list and no deletion
    /// under way holds nothing.
    fn forget_if_idle(&self, session_id: &SessionId) {
        let mut sessions = self.lock_sessions();
        if sessions.get(session_id).is_some_and(|session| {
            session.shells.is_empty()
                && session.opening.is_empty()
                && session.list.follower_count() == 0
                && session.close_holds == 0
        }) {
            sessions.remove(session_id);
        }
    }

    fn find_shell(
        &self,
        session_id: &SessionId,
        terminal_id: &TerminalId,
    ) -> Result<Arc<ShellRecord>, DomainError> {
        self.held_shell(session_id, terminal_id)
            .ok_or_else(|| terminal_not_found(terminal_id))
    }

    fn held_shell(
        &self,
        session_id: &SessionId,
        terminal_id: &TerminalId,
    ) -> Option<Arc<ShellRecord>> {
        self.lock_sessions()
            .get(session_id)
            .and_then(|session| session.shells.get(terminal_id))
            .cloned()
    }

    /// The refusal of a request naming `terminal_id`, which the table does not hold:
    /// `session.notFound` when the session's read refuses the session, else `terminal.notFound`.
    fn refuse_missing_shell(
        &self,
        session_id: &SessionId,
        terminal_id: &TerminalId,
    ) -> BoxFuture<'static, HandlerError> {
        let session_read = (self.deps.read_working_folder)(*session_id);
        let refusal = terminal_not_found(terminal_id);
        async move {
            match session_read.await {
                Ok(_) => refusal.into(),
                Err(error) => error,
            }
        }
        .boxed()
    }

    fn every_shell(&self) -> Vec<Arc<ShellRecord>> {
        self.lock_sessions()
            .values()
            .flat_map(|session| session.shells.values().cloned())
            .collect()
    }

    fn refresh_list(&self, session_id: &SessionId) {
        if let Some(session) = self.lock_sessions().get(session_id) {
            session.list.mark_changed();
        }
    }
}

/// The session's list in tab order, each holder read once its changes in flight settled; a shell
/// closed while its holder was read is left out, as its close reads the list again.
async fn read_list(table: Weak<TableShared>, session_id: SessionId) -> TerminalListUpdate {
    let shells: Vec<Arc<ShellRecord>> = table
        .upgrade()
        .and_then(|table| {
            table.lock_sessions().get(&session_id).map(|session| {
                session
                    .order
                    .iter()
                    .filter_map(|id| session.shells.get(id).cloned())
                    .collect()
            })
        })
        .unwrap_or_default();
    let mut terminals = Vec::with_capacity(shells.len());
    for shell in shells {
        let LeaseReading {
            holder,
            lease_version,
        } = shell.lease.read_holder().await;
        if shell.is_removed() {
            continue;
        }
        let title = shell
            .listener
            .title()
            .and_then(BoundedText::new)
            .or_else(|| BoundedText::new(cut_title(&shell.program_name).to_owned()))
            .expect("a shell's program has a name");
        terminals.push(TerminalListEntry {
            terminal_id: shell.terminal_id.clone(),
            title,
            status: shell.status(),
            holder,
            lease_version,
        });
    }
    TerminalListUpdate {
        session_id,
        terminals: UniqueList::new(terminals).expect("a session's shells each appear once"),
    }
}

/// Writes a failure no caller waits on to the service log.
fn log_failure(shell: &ShellRecord, what: &str, error: &(dyn Error + 'static)) {
    tracing::warn!(
        terminal = shell.terminal_id.as_str(),
        what,
        error,
        "a shell's work failed"
    );
}
