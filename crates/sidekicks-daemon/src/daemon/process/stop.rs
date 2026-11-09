//! The daemon's stop in its two steps, which the erase also runs one by one: the work ends within
//! the drain bound, then everything that holds a file in the data folder closes. Each step takes
//! the parts it closes, so a step run again skips what is already closed. The stop records each
//! step it waits on in the status file, and ends that record before it lets the data folder's lock
//! go. The process waits here for the first stop asked for, running the erase's steps as they come
//! on the task that owns it.

use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt as _;
use sidekicks_contracts::daemon::lifecycle::DAEMON_STOP_TERMINAL_DRAIN_MS;
use sidekicks_contracts::daemon::service_status::DaemonStopStep;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_recovery::restart_settle::RestartSettleError;
use sidekicks_recovery::stop_intent::StopIntentError;
use sidekicks_session::search::index::live::LiveIndexCloseError;
use sidekicks_std::scheduler::SchedulerStopError;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_workspace::clone::askpass::broker::AskpassBrokerError;
use sidekicks_workspace::git::worktree::setup::WorktreeSetupError;
use tokio::sync::oneshot;
use tokio::task::{JoinError, JoinHandle};

use crate::daemon::process::database::{
    DatabaseFileCloseFailure, DatabaseFileOpenError, close_database_file,
};
use crate::daemon::process::providers::{ProvidersRegistrationStopFailure, shut_down_drivers};
use crate::daemon::process::start_error::DaemonStartError;
use crate::daemon::process::stop::mcp::{stop_mcp_settle, stop_mcp_sign_ins};
use crate::daemon::process::{DAEMON_STOP_DRAIN_BOUND, DaemonProcess};
use crate::daemon::stop_drain::describe_drain;
use crate::data_acts::erase::EraseStep;

/// Why the daemon stops, which sets what its drivers are told. `daemon.stop` asks for `Stop`, a
/// start it cut short in the database file's repair included; `daemon.restart`, the system's stop
/// request, damage found in the database file and any other failed start restart; the erase's
/// stop is `Erase`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DaemonStopReason {
    /// The person stopped the daemon.
    Stop,
    /// The daemon starts again, so a service that outlives it keeps running.
    Restart,
    /// The erase ends the daemon with everything it kept.
    Erase,
}

impl DaemonStopReason {
    /// What the drivers are told: a restart keeps a service that outlives the daemon, while a
    /// stop and an erase end every service the daemon started.
    pub(crate) fn driver_intent(self) -> DaemonStopIntent {
        match self {
            Self::Stop | Self::Erase => DaemonStopIntent::Stop,
            Self::Restart => DaemonStopIntent::Restart,
        }
    }

    /// Whether the person stopped the daemon.
    pub(crate) fn is_persons_stop(self) -> bool {
        matches!(self, Self::Stop)
    }

    /// The reason once `later` is asked for after `self`: the person's stop replaces a restart,
    /// and every other later ask keeps the first. Every place an ask lands applies this rule.
    pub(crate) fn joined(self, later: Self) -> Self {
        if self == Self::Restart && later.is_persons_stop() {
            later
        } else {
            self
        }
    }

    /// Joins the stop `later` asks for to the one `asked` holds, the first ask taken as it is;
    /// answers whether `asked` changed.
    pub(crate) fn join_ask(asked: &mut Option<Self>, later: Self) -> bool {
        let joined = asked.map_or(later, |first| first.joined(later));
        let is_changed = *asked != Some(joined);
        *asked = Some(joined);
        is_changed
    }

    /// The reason a failed start's release stops for: the reason of a stop asked for over the
    /// repairing socket, which cut the start short, else a restart.
    pub(super) fn of_failed_start(error: &DaemonStartError) -> Self {
        if let DaemonStartError::DatabaseFile(DatabaseFileOpenError::Stopped(reason)) = error {
            *reason
        } else {
            Self::Restart
        }
    }
}

/// Why a step of the stop failed; every other step still ran.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DaemonStopFailure {
    /// The crash monitor could not be ended, or its socket stayed.
    #[error(transparent)]
    CrashMonitor(#[from] CrashMonitorEndFailure),
    /// A step of the database file's close failed.
    #[error(transparent)]
    DatabaseFile(#[from] DatabaseFileCloseFailure),
    /// Mutating calls were still running when the drain bound ran out.
    #[error("{0} mutating calls were still running when the stop's drain bound ran out")]
    MutatingCallsRunning(usize),
    /// The machine keys' background read was still running when the drain bound ran out; the
    /// next start reads the keys again.
    #[error("the machine keys' read was still running when the stop's drain bound ran out")]
    MachineKeyReadRunning,
    /// The capability refresh's task ended abnormally.
    #[error("the capability refresh ended abnormally")]
    CapabilityRefresh(#[source] JoinError),
    /// The providers' registration did not end cleanly.
    #[error(transparent)]
    ProvidersRegistration(#[from] ProvidersRegistrationStopFailure),
    /// Sign-ins were still settling when the drain bound ran out; the next start removes a new
    /// account's home one left.
    #[error("sign-ins were still settling when the stop's drain bound ran out")]
    SignInsRunning,
    /// The scheduler's task, its running job or an owner task ended abnormally, or one still ran
    /// at the drain bound and was aborted.
    #[error("the scheduler did not stop cleanly")]
    Scheduler(#[source] SchedulerStopError),
    /// The session search index did not close cleanly.
    #[error("the session search index did not close cleanly")]
    SearchIndex(#[source] Arc<LiveIndexCloseError>),
    /// A service's background task ended abnormally.
    #[error(transparent)]
    Task(#[from] TaskStopFailure),
    /// The clone service's askpass broker ended abnormally at its close.
    #[error(transparent)]
    Askpass(#[from] AskpassBrokerError),
    /// A worktree's setup command could not be ended.
    #[error(transparent)]
    WorktreeSetup(#[from] WorktreeSetupError),
    /// The tool servers' connections were still closing when the drain bound ran out; a close cut
    /// there leaves its receipts in flight for the next start's sweep.
    #[error("the tool servers' connections were still closing when the stop's drain bound ran out")]
    ToolServersClosing,
    /// A background task, one the start began or a service's own, was still running when the drain
    /// bound ran out, and was ended; the next start does its work again.
    #[error("the {0} was still running when the stop's drain bound ran out")]
    StartTaskRunning(&'static str),
    /// A step with no failure of its own was still running when the drain bound ran out, and was
    /// left to the process's end.
    #[error(
        "the {0} was still running when the stop's drain bound ran out, and was left to the \
         process's end"
    )]
    StepRunning(&'static str),
    /// The person's Stop could not write its intent, so the next start resumes the work the
    /// drain did not end as after a crash.
    #[error("the stop intent could not be written")]
    StopIntent(#[source] StopIntentError),
    /// The drain of the live runs at the person's Stop failed; the next start settles the runs
    /// it left live.
    #[error("the live runs' drain at the stop failed")]
    Drain(#[source] RestartSettleError),
}

/// A service's background task, a follow of the log among them, that ended abnormally at the stop.
#[derive(Debug, thiserror::Error)]
#[error("the {task} ended abnormally at the stop")]
pub(crate) struct TaskStopFailure {
    /// What the task does, in plain words.
    pub(crate) task: &'static str,
    /// How it ended.
    #[source]
    pub(crate) error: JoinError,
}

/// Waits within `bound` for each background task, one the start began or a service's own, named
/// by what it does, and ends one still running then. Answers each task that ended abnormally or
/// ran past the bound.
pub(crate) async fn end_start_tasks(
    tasks: impl IntoIterator<Item = (&'static str, JoinHandle<()>)>,
    bound: Duration,
) -> Vec<DaemonStopFailure> {
    let deadline = tokio::time::Instant::now() + bound;
    let mut failures = Vec::new();
    for (task, mut handle) in tasks {
        match tokio::time::timeout_at(deadline, &mut handle).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failures.push(TaskStopFailure { task, error }.into()),
            Err(_elapsed) => {
                handle.abort();
                failures.push(DaemonStopFailure::StartTaskRunning(task));
            }
        }
    }
    failures
}

// Waits on `step` of the stop within `bound`, answering its own output, or the step's failure once
// the bound runs out, the wait then dropped.
async fn wait_within<T>(
    bound: Duration,
    step: &'static str,
    wait: impl Future<Output = T>,
) -> Result<T, DaemonStopFailure> {
    tokio::time::timeout(bound, wait)
        .await
        .map_err(|_elapsed| DaemonStopFailure::StepRunning(step))
}

/// Why the crash monitor's end failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CrashMonitorEndFailure {
    /// The monitor could not be killed.
    #[error("the crash monitor could not be ended")]
    Kill(#[source] io::Error),
    /// The monitor did not exit within its end's bound.
    #[error("the crash monitor did not end within {0:?}")]
    StillRunning(Duration),
    /// The monitor's socket stayed in the run folder.
    #[error("the crash monitor's socket {} could not be removed", path.display())]
    Socket {
        /// The socket's path.
        path: PathBuf,
        /// The system's failure.
        #[source]
        source: io::Error,
    },
}

/// Ends the daemon's work, `bound` counted from this call: the person's Stop first writes its
/// intent whole; that write and the stop's record of each step it waits on, which a cut write could
/// land after the stop's end record, are the waits `bound` does not cut; then the stop token and
/// the cut of the engine's interrupt hands, so the work under way ends and no hand holds a lock a
/// mutating call waits on; then, within what is left of `bound`, the recovery's session ends, whose
/// waits the token ends, the socket, so no new call comes, the mutating calls under way, the
/// machine keys' background read, the capability refresh, the providers' registration, the tool
/// servers' client, the wait for the engine's interrupt hands, the run queue, the worktree
/// cleanup's requests and the start's background tasks, the clone service with its askpass broker,
/// the worktrees' setup commands, the repository services' background work, the attention
/// decisions, the keep-awake hold, the session services' follows with the chats' write watch and
/// file recount, whose watermark a clean end stores, the renames' name pushes, the highlighter, the
/// terminals, the provider accounts' sign-ins, the start's sweep of new accounts' homes and the
/// account observer, the scheduler, the working-folder watch, the projects list, the search index,
/// the MCP binding edits' settle pass, the MCP server sign-ins, the drivers, the person's Stop's
/// drain of the live runs, the turn end captures under way, the git trees a failed call left and,
/// last, the kept worktrees' reads. The drivers are told `reason`'s intent, once a stop the person
/// asked for over the socket since has replaced a restart, which writes the intent there. Answers
/// each step's failure, every step having run.
pub(crate) async fn stop_work(
    process: &mut DaemonProcess,
    reason: DaemonStopReason,
    bound: Duration,
) -> Vec<DaemonStopFailure> {
    let started = Instant::now();
    process.stop_started = Some(started);
    tracing::info!(
        ?reason,
        drain_bound_ms = bound.as_millis(),
        "the background service stops"
    );
    let mut failures = Vec::new();
    // Before anything stops, so the next start ends whatever this stop leaves as the stop does.
    if reason.is_persons_stop()
        && let Err(error) = process.stop_intent.write_whole().await
    {
        failures.push(DaemonStopFailure::StopIntent(error));
    }
    process.process_state.mark_stopping();
    process.work_stop.cancel();
    // With the token, so no interrupt hand holds a run's interrupt lock that a mutating call
    // waits on; the run queue's step waits the hands out.
    if let Some(session) = &process.session {
        session.engine.cut_interrupt_hands();
    }
    let remaining = || bound.saturating_sub(started.elapsed());
    // Right after the cancel, which ends each wait of the recovery's name drops with the name kept.
    if let Some(recovery) = process.recovery.take()
        && let Err(failure) =
            wait_within(remaining(), "recovery's session ends", recovery.stop()).await
    {
        failures.push(failure);
    }
    // Its listener closed at the cancel, so no call comes past a cut wait.
    if let Some(gateway) = process.gateway.take() {
        process
            .stop_record
            .write_step(DaemonStopStep::Gateway)
            .await;
        if let Err(failure) = wait_within(remaining(), "socket", gateway.stop()).await {
            failures.push(failure);
        }
    }
    if let Some(in_flight) = process.in_flight.take() {
        let running = in_flight.wait_for_pending_within(None, remaining()).await;
        if running > 0 {
            failures.push(DaemonStopFailure::MutatingCallsRunning(running));
        }
    }
    // The socket is closed and the calls under way waited out, so no ask comes past this read.
    let asked = *process.stop_asked.borrow();
    let joined = asked.map_or(reason, |asked| reason.joined(asked));
    // A Stop that replaced a restart writes its intent here, before the drivers hear of it.
    if joined.is_persons_stop()
        && !reason.is_persons_stop()
        && let Err(error) = process.stop_intent.write_whole().await
    {
        failures.push(DaemonStopFailure::StopIntent(error));
    }
    let reason = joined;
    // Past the bound, the dropped stop drops the background read's handle, which aborts it.
    if let Some(machine_identity) = process.machine_identity.take()
        && tokio::time::timeout(remaining(), machine_identity.stop())
            .await
            .is_err()
    {
        failures.push(DaemonStopFailure::MachineKeyReadRunning);
    }
    let drivers = match process.providers.take() {
        Some(providers) => {
            process
                .stop_record
                .write_step(DaemonStopStep::CapabilityRefresh)
                .await;
            match wait_within(
                remaining(),
                "capability refresh",
                providers.refreshing.stop(),
            )
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push(DaemonStopFailure::CapabilityRefresh(error)),
                Err(failure) => failures.push(failure),
            }
            Some(providers.registry)
        }
        None => None,
    };
    if let Some(registration) = process.providers_registration.take()
        && let Err(failure) = registration.stop(remaining()).await
    {
        failures.push(failure.into());
    }
    // Ends a fill under way, whose reads run on the drivers.
    drop(process.mcp_attribution_fills.take());
    // Before the queue and the drivers, so every end the stop causes meets the stopping mark and
    // writes nothing; while the database is open, so an end a server answered is still written.
    if let Some(mcp_client) = process.mcp_client.take() {
        process
            .stop_record
            .write_step(DaemonStopStep::ToolServers)
            .await;
        if tokio::time::timeout(remaining(), mcp_client.stop())
            .await
            .is_err()
        {
            failures.push(DaemonStopFailure::ToolServersClosing);
        }
    }
    // Before the attachments and the drivers, so no run is admitted or delivered past here.
    if let Some(session) = &process.session {
        process
            .stop_record
            .write_step(DaemonStopStep::RunQueue)
            .await;
        // Before the queue's stop, so a hand the token cuts never meets a stopped queue.
        if let Err(failure) = wait_within(
            remaining(),
            "interrupt hands",
            session.engine.stop_interrupt_hands(),
        )
        .await
        {
            failures.push(failure);
        }
        if let Err(failure) = wait_within(remaining(), "run queue", session.queue.stop()).await {
            failures.push(failure);
        }
    }
    // Before the scheduler, which runs the cleanup, and before the services the tasks write
    // through.
    if let Some(workspace_work) = &mut process.workspace_work {
        failures.extend(workspace_work.stop(remaining()).await);
    }
    // Before the session attachments' stop, so a clone that attaches tells sessions still served;
    // taken, so a stop run again finds no broker to close.
    if let Some(clones) = process.clones.take()
        && let Err(failure) = clones.close(remaining()).await
    {
        failures.push(failure.into());
    }
    // Before the working-folder watch, on which a setup's warm step holds its tree.
    if let Some(worktree_setup) = process.worktree_setup.take()
        && let Err(failure) = worktree_setup.stop(remaining()).await
    {
        failures.push(failure.into());
    }
    // Before the scheduler, whose tick wakes the health re-probe.
    if let (Some(repo_attachments), Some(repo)) = (process.repo_attachments.take(), &process.repo) {
        process
            .stop_record
            .write_step(DaemonStopStep::RepositoryAttachments)
            .await;
        match wait_within(
            remaining(),
            "repository services' background work",
            repo_attachments.stop(repo),
        )
        .await
        {
            Ok(None) => {}
            Ok(Some(failure)) => failures.push(failure.into()),
            Err(failure) => failures.push(failure),
        }
    }
    // The work's stop ends the attention decisions and the web address's sender; a write under way
    // is waited out within the bound, and either is ended past it.
    if let Some(attention) = process.attention.take() {
        process
            .stop_record
            .write_step(DaemonStopStep::AttentionDecisions)
            .await;
        failures.extend(end_start_tasks([("attention decisions", attention)], remaining()).await);
    }
    // The work's stop lets go of the keep-awake hold, which is waited out.
    if let Some(keep_awake) = process.keep_awake.take() {
        failures.extend(end_start_tasks([("keep-awake", keep_awake)], remaining()).await);
    }
    if let Some(web_address_sender) = process.web_address_sender.take() {
        process
            .stop_record
            .write_step(DaemonStopStep::WebAddressSender)
            .await;
        failures.extend(
            end_start_tasks([("web address sender", web_address_sender)], remaining()).await,
        );
    }
    // The session services' follows end with the chats' write watch, which they wait out.
    match (
        process.session_attachments.take(),
        &mut process.session,
        &process.repo,
    ) {
        (Some(attachments), Some(session), Some(repo)) => {
            process
                .stop_record
                .write_step(DaemonStopStep::SessionFollows)
                .await;
            match wait_within(
                remaining(),
                "session follows",
                attachments.stop(session, &repo.workspaces),
            )
            .await
            {
                Ok(ended) => {
                    // Every write the watch sent was taken, so the next start walks from here once
                    // each report held behind an open tool call is recorded too; a watermark not
                    // kept makes it walk from the last one kept.
                    if ended.is_empty()
                        && let Err(failure) = wait_within(
                            remaining(),
                            "chat watermark",
                            session
                                .chat_versions
                                .keep_caught_up(repo.workspaces.whole_since()),
                        )
                        .await
                    {
                        failures.push(failure);
                    }
                    failures.extend(ended.into_iter().map(DaemonStopFailure::from));
                }
                Err(failure) => failures.push(failure),
            }
        }
        (_, _, Some(repo)) => {
            process
                .stop_record
                .write_step(DaemonStopStep::ChatsRecount)
                .await;
            match wait_within(remaining(), "chats' file recount", repo.workspaces.stop()).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push(
                    TaskStopFailure {
                        task: "chats' file recount",
                        error,
                    }
                    .into(),
                ),
                Err(failure) => failures.push(failure),
            }
        }
        (_, _, None) => {}
    }
    if let Some(session) = &process.session {
        process
            .stop_record
            .write_step(DaemonStopStep::ChatsChanges)
            .await;
        if let Err(failure) =
            wait_within(remaining(), "chats' change feed", session.changes.stop()).await
        {
            failures.push(failure);
        }
        session.highlighter.stop();
        process
            .stop_record
            .write_step(DaemonStopStep::Terminals)
            .await;
        // Before the orphan guard goes, so every child the drain ended is still retired. Capped at
        // the terminals' own drain, so the drivers keep the rest when a shell ignores its stop.
        let terminals_bound = remaining().min(Duration::from_millis(DAEMON_STOP_TERMINAL_DRAIN_MS));
        let drain = session.terminals.drain(terminals_bound).await;
        tracing::info!("{}", describe_drain(drain));
    }
    if let Some(provider_accounts) = &mut process.provider_accounts {
        process
            .stop_record
            .write_step(DaemonStopStep::SignIns)
            .await;
        // Before the drivers, whose services the flows run on, and before the observer, which a
        // finished sign-in hands its account.
        if !provider_accounts.end_sign_ins(remaining()).await {
            failures.push(DaemonStopFailure::SignInsRunning);
        }
        // Before the drivers, whose legs its sign-outs run through.
        failures.extend(provider_accounts.end_minted_home_sweep(remaining()).await);
        // Before the scheduler, whose jobs and timers it holds.
        provider_accounts.stop();
    }
    // Before the drivers, since a job it runs may still call into them.
    if let Some(scheduler) = process.scheduler.take() {
        process
            .stop_record
            .write_step(DaemonStopStep::Scheduler)
            .await;
        if let Err(failure) = scheduler
            .stop(tokio::time::Instant::now() + remaining())
            .await
        {
            failures.push(DaemonStopFailure::Scheduler(failure));
        }
    }
    // The watch only reads, so one cut leaves nothing half written.
    if let Some(repo) = &process.repo {
        process
            .stop_record
            .write_step(DaemonStopStep::FolderWatch)
            .await;
        if let Err(failure) = wait_within(
            remaining(),
            "repositories' folder watch",
            repo.folder_watch.stop(),
        )
        .await
        {
            failures.push(failure);
        }
    }
    if let Some(project_list_feed) = process.project_list_feed.take() {
        project_list_feed.close();
    }
    // A close cut here stays with the process, for the data folder's close to wait out.
    if let Some(search_index) = process.search_index.clone() {
        process
            .stop_record
            .write_step(DaemonStopStep::SearchIndex)
            .await;
        match wait_within(remaining(), "session search index", search_index.close()).await {
            Ok(closed) => {
                process.search_index = None;
                if let Err(error) = closed {
                    failures.push(DaemonStopFailure::SearchIndex(error));
                }
            }
            Err(failure) => failures.push(failure),
        }
    }
    failures.extend(stop_mcp_settle(process, remaining()).await);
    failures.extend(stop_mcp_sign_ins(process, remaining()).await);
    if let Some(drivers) = drivers {
        process
            .stop_record
            .write_step(DaemonStopStep::Providers)
            .await;
        shut_down_drivers(&drivers, reason.driver_intent(), remaining()).await;
    }
    // After the drivers, so no provider runs on; before the captures stop, so a drained turn end
    // is captured as the start's pass captures its own. What the bound cuts off, the next start
    // settles from the intent.
    if reason.is_persons_stop()
        && let Some(restart_settle) = &process.restart_settle
    {
        process
            .stop_record
            .write_step(DaemonStopStep::LiveRunsDrain)
            .await;
        if let Err(error) = restart_settle
            .settle_at_stop(tokio::time::Instant::now() + remaining())
            .await
        {
            failures.push(DaemonStopFailure::Drain(error));
        }
    }
    // After the drivers, so no turn ends past here; a capture still under way at the bound is cut
    // at the process's end, and may leave its scratch index behind.
    if let Some(turn_capturing) = process.turn_capturing.take() {
        process
            .stop_record
            .write_step(DaemonStopStep::TurnCaptures)
            .await;
        if let Err(failure) = wait_within(remaining(), "turn captures", turn_capturing.stop()).await
        {
            failures.push(failure);
        }
    }
    if let Some(git) = &process.git {
        process
            .stop_record
            .write_step(DaemonStopStep::GitTrees)
            .await;
        if let Err(failure) = wait_within(remaining(), "git trees", git.wait_for_tree_ends()).await
        {
            failures.push(failure);
        }
    }
    // Last, so nothing writes once the stop resolves; a size read or deletion cut here runs past
    // the stop and the next cleanup does it again.
    if let Some(workspace_work) = process.workspace_work.take() {
        process
            .stop_record
            .write_step(DaemonStopStep::WorkspaceWorkSettle)
            .await;
        if let Err(failure) = wait_within(
            remaining(),
            "workspace services' work",
            workspace_work.settle(),
        )
        .await
        {
            failures.push(failure);
        }
    }
    // After the drain, so every child it ended is still retired.
    drop(process.orphan_guard.take());
    process.has_stop_failed |= !failures.is_empty();
    failures
}

/// Closes everything that holds a file in the data folder, as `close_data_folder_contents` does,
/// then lets the data folder's lock go last. Answers each step's failure, every step having run.
pub(crate) async fn close_data_folder(process: &mut DaemonProcess) -> Vec<DaemonStopFailure> {
    let failures = close_data_folder_contents(process).await;
    drop(process.data_folder_lock.take());
    failures
}

/// Closes everything that holds a file in the data folder but its lock, within what is left of the
/// latest stop's drain bound, recorded as one step of a begun stop. Answers each step's failure,
/// every step having run.
pub(super) async fn close_data_folder_contents(
    process: &mut DaemonProcess,
) -> Vec<DaemonStopFailure> {
    let mut failures = Vec::new();
    let remaining = || {
        DAEMON_STOP_DRAIN_BOUND.saturating_sub(
            process
                .stop_started
                .map_or(Duration::ZERO, |started| started.elapsed()),
        )
    };
    process
        .stop_record
        .write_step(DaemonStopStep::DataFolderClose)
        .await;
    // A close the work's stop cut is waited out before the database file closes, since its deletes
    // write through the file's writer, and before the lock goes, since the index's files sit in the
    // data folder.
    if let Some(search_index) = process.search_index.take() {
        match wait_within(remaining(), "session search index", search_index.close()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failures.push(DaemonStopFailure::SearchIndex(error)),
            Err(failure) => failures.push(failure),
        }
    }
    // The session services, with the restart's settle, and the repository services go; the MCP
    // first-observation drain is waited for, ended where it stands past the bound; the database
    // file closes; the crash monitor ends, its exit waited for and its socket removed.
    let mut session = process.session.take();
    let mcp_first_observations = session.as_mut().and_then(|session| {
        // Ended here, since the tracker outlives the session services: the provider port holds it.
        session.mcp_status.end_first_observations();
        session.mcp_first_observations.take()
    });
    // Their pools and writer handles go before the file closes.
    drop(session);
    drop(process.restart_settle.take());
    drop(process.repo.take());
    // Before the file closes, since the drain writes through its writer.
    if let Some(mut drain) = mcp_first_observations {
        let ended = match tokio::time::timeout(remaining(), &mut drain).await {
            Ok(ended) => ended,
            Err(_elapsed) => {
                drain.abort();
                drain.await
            }
        };
        if let Err(error) = ended {
            failures.push(
                TaskStopFailure {
                    task: "MCP first-observation drain",
                    error,
                }
                .into(),
            );
        }
    }
    if let Some(database) = process.database.take() {
        failures.extend(
            close_database_file(database, remaining(), process.has_stop_failed)
                .await
                .into_iter()
                .map(DaemonStopFailure::from),
        );
    }
    // Before the lock goes, so a start that takes the lock next meets no monitor of this one.
    if let Some(crash_monitor) = process.crash_monitor.take() {
        failures.extend(crash_monitor.end().await);
    }
    failures
}

/// A step of the erase the process runs on the task that owns it, answering once the step ran.
pub(super) enum DaemonCommand {
    /// Ends the daemon's work as the stop does.
    StopWork(oneshot::Sender<()>),
    /// Closes everything that holds a file in the data folder.
    CloseDataFolder(oneshot::Sender<()>),
}

impl DaemonProcess {
    /// The stop asked for over the socket: the lifecycle methods' stop asks with
    /// [`DaemonStopReason::Stop`], their restart with [`DaemonStopReason::Restart`], and the
    /// erase's end with [`DaemonStopReason::Erase`]; each ask joins the one before it.
    pub(crate) fn accept_stop(&self) -> Arc<dyn Fn(DaemonStopReason) + Send + Sync> {
        let stop_asked = self.stop_asked.clone();
        Arc::new(move |reason| {
            stop_asked.send_if_modified(|asked| DaemonStopReason::join_ask(asked, reason));
        })
    }

    /// The erase's step that ends the daemon's work as the stop does.
    pub(crate) fn stop_work_step(&self) -> EraseStep {
        self.command_step(DaemonCommand::StopWork)
    }

    /// The erase's step that closes everything that holds a file in the data folder.
    pub(crate) fn close_data_folder_step(&self) -> EraseStep {
        self.command_step(DaemonCommand::CloseDataFolder)
    }

    // An erase step that sends the command `command` makes to the task that owns the process and
    // waits until it ran. Once the stop has begun, the stop closes these parts instead, and the
    // erase's later steps race the runtime's end.
    fn command_step(&self, command: fn(oneshot::Sender<()>) -> DaemonCommand) -> EraseStep {
        let commands = self.command_sender.clone();
        Arc::new(move || {
            let commands = commands.clone();
            async move {
                let (reply, replied) = oneshot::channel();
                if commands.send(command(reply)).await.is_err() || replied.await.is_err() {
                    tracing::info!(
                        "the daemon's stop had begun before the erase's step, so the stop closes \
                         those parts"
                    );
                }
            }
            .boxed()
        })
    }

    /// Runs the erase's steps as they come, until the first stop asked for: the system's stop
    /// request, which restarts, damage found in the database file, which restarts so the next
    /// start repairs it, or a stop or restart over the socket or the erase's end, each for its own
    /// reason.
    pub(crate) async fn wait_for_stop(&mut self) -> DaemonStopReason {
        let mut stop_asked = self.stop_asked.subscribe();
        let damage = self
            .database
            .as_ref()
            .map(|database| Arc::clone(&database.damage));
        loop {
            let command = tokio::select! {
                () = self.system_stop.cancelled() => return DaemonStopReason::Restart,
                () = async {
                    match &damage {
                        Some(damage) => {
                            damage.when_found().await;
                        }
                        None => std::future::pending().await,
                    }
                } => return DaemonStopReason::Restart,
                asked = stop_asked.wait_for(Option::is_some) => return match asked.as_deref() {
                    Ok(Some(reason)) => *reason,
                    // The process holds the sender, so the wait ends only with an ask.
                    Ok(None) | Err(_) => DaemonStopReason::Restart,
                },
                Some(command) = self.commands.recv() => command,
            };
            self.run_command(command).await;
        }
    }

    // Runs one of the erase's steps, logging each failure, and answers that it ran.
    async fn run_command(&mut self, command: DaemonCommand) {
        let (failures, reply) = match command {
            DaemonCommand::StopWork(reply) => (
                stop_work(self, DaemonStopReason::Erase, DAEMON_STOP_DRAIN_BOUND).await,
                reply,
            ),
            DaemonCommand::CloseDataFolder(reply) => (close_data_folder(self).await, reply),
        };
        for failure in &failures {
            tracing::error!(
                error = failure as &(dyn Error + 'static),
                "a step of the erase's stop failed"
            );
        }
        if reply.send(()).is_err() {
            tracing::debug!("the erase ended before its step answered");
        }
    }

    /// Stops the daemon for `reason`: its work within the drain bound, each step it waits on
    /// recorded in the status file, then its data folder; a part the erase already closed is
    /// skipped. The record ends, as why the stop failed or no file, before the data folder's lock
    /// goes last, so a start that takes the lock next meets no write of this stop. Fails with every
    /// step's failure, each step having run.
    pub(crate) async fn stop(
        mut self,
        reason: DaemonStopReason,
    ) -> Result<(), SettleFailures<DaemonStopFailure>> {
        // An erase's step let the lock go already, so this stop records nothing after it.
        if self.data_folder_lock.is_some() {
            self.stop_record.begin();
        }
        let mut failures = stop_work(&mut self, reason, DAEMON_STOP_DRAIN_BOUND).await;
        failures.extend(close_data_folder_contents(&mut self).await);
        let is_intent_unsaved = failures
            .iter()
            .any(|failure| matches!(failure, DaemonStopFailure::StopIntent(_)));
        self.stop_record.write_end(is_intent_unsaved).await;
        drop(self.data_folder_lock.take());
        settle_all(
            failures
                .into_iter()
                .map(Err)
                .collect::<Vec<Result<(), _>>>(),
            "the daemon's stop",
        )
        .map(drop)
    }
}

mod mcp;
#[cfg(test)]
mod tests;
