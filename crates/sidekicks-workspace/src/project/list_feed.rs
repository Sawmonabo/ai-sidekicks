//! The live projects list `project.subscribe` streams: every project as the Projects page and the
//! session list's project headers draw it, held in memory while a subscription is open and sent
//! whole on each change.
//!
//! - The first subscription reads every project; one opening meanwhile waits for that read and
//!   takes its list. Changes named from the read's start are read again once the list is held.
//! - A committed event that can move a project's session count, tally or running session names its
//!   session; a writer that changes a project's row or a run's held root without an event names
//!   the projects through [`ProjectListFeed::refresh`], and one that changes a session without an
//!   event names it through [`ProjectListFeed::refresh_sessions`].
//! - One task reads every waiting change in one read however many named it: a session reaches the
//!   project the last read held it in and the one it sits in now, and only those projects are read
//!   again, their sessions' facts with them, so a burst never reads the whole list.
//! - The list holds a place, never a queue: it is sent only when it differs from the one held, and
//!   a slow subscriber reads only the newest list.
//! - A failed read ends every subscription and drops the list, so the next one reads the rows
//!   again; the last subscription closing drops it too.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::mem;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use sidekicks_contracts::event::declared_variants::SessionEventCompactedPayload;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::project::{ProjectId, ProjectList};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::stream::latest_value::LatestValueOutlet;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::events::session::followers::{
    CommittedEvent, FollowerAttachment, SessionEventFollowers,
};
use tokio::sync::Notify;
use tokio_util::task::AbortOnDropHandle;

use crate::project::records::{
    ListedProject, ListedProjects, ProjectChanges, ProjectReadError, ProjectRecords,
};

/// A subscription's list stopped being current: a changed project could not be read, as the
/// service log names.
#[derive(Debug, thiserror::Error)]
#[error("the projects list stopped being current")]
pub(crate) struct ProjectListNotCurrent;

/// The daemon's one live projects list: read when the first subscription opens and dropped when
/// the last one closes.
pub struct ProjectListFeed {
    records: Arc<ProjectRecords>,
    shared: Arc<SharedFeed>,
    // Held across an opening read, so an open meanwhile waits for it and takes its list.
    opening: tokio::sync::Mutex<()>,
    following: Mutex<Option<FollowerAttachment>>,
}

// What the follower, the reading task and each subscription's detach share.
struct SharedFeed {
    state: Mutex<FeedState>,
    // Raised on each change named while the list is read or held.
    changed: Notify,
    /// Holds the reading task once it has taken a burst's changes, before it reads them.
    #[cfg(test)]
    burst_read_pause: sidekicks_std::pause_point::PausePoint,
}

#[derive(Default)]
struct FeedState {
    // Set from the opening read's start until the list drops, so changes are kept only then.
    is_collecting: bool,
    pending_projects: HashSet<ProjectId>,
    pending_sessions: HashSet<SessionId>,
    held: Option<HeldList>,
    outlets: HashMap<u64, LatestValueOutlet<ProjectList>>,
    next_outlet_id: u64,
    next_generation: u64,
}

// The held list, the project each counted session sat in at the last read, and the task that
// keeps the list current, which ends when it drops.
struct HeldList {
    generation: u64,
    projects: Vec<ListedProject>,
    session_projects: HashMap<SessionId, ProjectId>,
    _reading: AbortOnDropHandle<()>,
}

impl ProjectListFeed {
    /// The list read through `records`, kept current from `followers`' committed events.
    pub fn new(records: Arc<ProjectRecords>, followers: &Arc<SessionEventFollowers>) -> Self {
        let shared = Arc::new(SharedFeed {
            state: Mutex::new(FeedState::default()),
            changed: Notify::new(),
            #[cfg(test)]
            burst_read_pause: sidekicks_std::pause_point::PausePoint::default(),
        });
        let following = {
            let shared = Arc::clone(&shared);
            followers.follow_all(move |event| {
                let session_ids = sessions_named(event)?;
                if !session_ids.is_empty() {
                    shared.collect(&session_ids, &[]);
                }
                Ok(())
            })
        };
        Self {
            records,
            shared,
            opening: tokio::sync::Mutex::new(()),
            following: Mutex::new(Some(following)),
        }
    }

    /// Opens the list for one subscription: `outlet` is sent the whole list now and again on each
    /// change, and the answer is the detach its feed runs when it closes. Fails with the opening
    /// read's failure, with nothing opened.
    pub async fn open(
        &self,
        outlet: LatestValueOutlet<ProjectList>,
    ) -> Result<Box<dyn FnOnce() + Send>, HandlerError> {
        let _opening = self.opening.lock().await;
        {
            let mut state = self.shared.lock_state();
            if let Some(held) = &state.held {
                outlet.send(held.list());
                return Ok(state.attach(outlet, &self.shared));
            }
            state.is_collecting = true;
        }
        let read = self.records.read_list().await;
        let mut state = self.shared.lock_state();
        let listed = match read {
            Ok(listed) => listed,
            Err(error) => {
                state.drop_list();
                return Err(HandlerError::Internal(Box::new(error)));
            }
        };
        state.next_generation += 1;
        let generation = state.next_generation;
        let reading = AbortOnDropHandle::new(tokio::spawn(read_changes(
            Arc::clone(&self.shared),
            Arc::clone(&self.records),
            generation,
        )));
        let held = HeldList::new(generation, listed, reading);
        outlet.send(held.list());
        state.held = Some(held);
        // Changes named while the list was read are read again now that it is held.
        if !state.pending_projects.is_empty() || !state.pending_sessions.is_empty() {
            self.shared.changed.notify_one();
        }
        Ok(state.attach(outlet, &self.shared))
    }

    /// Reads those projects again and sends the list when it changed; a project whose row is gone
    /// leaves it. For a change written without an event, called after the write commits; nothing
    /// is read while no subscription is open.
    pub fn refresh(&self, project_ids: &[ProjectId]) {
        self.shared.collect(&[], project_ids);
    }

    /// Reads again the projects those sessions sat in at the last read and sit in now, and sends
    /// the list when it changed, so a session whose rows are already deleted still reaches its
    /// project. For a session change written without an event, called after the write commits.
    pub fn refresh_sessions(&self, session_ids: &[SessionId]) {
        self.shared.collect(session_ids, &[]);
    }

    /// Stops following the log, for the daemon's stop: every subscription's stream ends and the
    /// list drops.
    pub fn close(&self) {
        let following = lock(&self.following).take();
        drop(following);
        self.shared.lock_state().drop_list();
    }
}

impl SharedFeed {
    // Keeps the named changes for the reading task while a list is read or held, and wakes it.
    fn collect(&self, session_ids: &[SessionId], project_ids: &[ProjectId]) {
        {
            let mut state = self.lock_state();
            if !state.is_collecting {
                return;
            }
            state.pending_sessions.extend(session_ids.iter().copied());
            state.pending_projects.extend(project_ids.iter().copied());
        }
        // A wake with no task waiting is kept, so a change named while the task reads is not lost.
        self.changed.notify_one();
    }

    // Every waiting change as the projects to read again: those named, and for each named session
    // the project the held list holds it in, with the sessions to map to their projects now.
    // `None` once the list `generation` names is no longer held.
    fn take_changes(&self, generation: u64) -> Option<(Vec<SessionId>, Vec<ProjectId>)> {
        let mut state = self.lock_state();
        // Checked before taking, so a task its list outlived leaves the next list's changes.
        if !state
            .held
            .as_ref()
            .is_some_and(|held| held.generation == generation)
        {
            return None;
        }
        let session_ids = mem::take(&mut state.pending_sessions);
        let mut project_ids = mem::take(&mut state.pending_projects);
        let held = state.held.as_ref()?;
        project_ids.extend(
            session_ids
                .iter()
                .filter_map(|session_id| held.session_projects.get(session_id).copied()),
        );
        Some((
            session_ids.into_iter().collect(),
            project_ids.into_iter().collect(),
        ))
    }

    // Puts a read's projects into the list `generation` names and sends the list when it changed,
    // or ends every subscription when the read failed; answers whether that list is still held.
    fn apply(&self, generation: u64, read: Result<ProjectChanges, ProjectReadError>) -> bool {
        let mut state = self.lock_state();
        let FeedState { held, outlets, .. } = &mut *state;
        let Some(held) = held.as_mut().filter(|held| held.generation == generation) else {
            return false;
        };
        match read {
            Ok(changes) => {
                let before = held.list();
                held.apply(changes);
                let after = held.list();
                if after != before {
                    for outlet in outlets.values() {
                        outlet.send(after.clone());
                    }
                }
                true
            }
            // The daemon's stop closed the pool: each stream finishes as the list drops.
            Err(ProjectReadError::Pool(DatabaseReadError::Closed)) => {
                state.drop_list();
                false
            }
            Err(error) => {
                tracing::error!(
                    error = &error as &(dyn Error + 'static),
                    "reading the changed projects failed, so every projects list subscription was \
                     ended"
                );
                for outlet in outlets.values() {
                    outlet.fail(HandlerError::Internal(Box::new(ProjectListNotCurrent)));
                }
                state.drop_list();
                false
            }
        }
    }

    // A subscription leaves; the last one drops the list, so the next opening reads the rows again.
    fn detach(&self, outlet_id: u64) {
        let mut state = self.lock_state();
        if state.outlets.remove(&outlet_id).is_some() && state.outlets.is_empty() {
            state.drop_list();
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, FeedState> {
        // The state holds no invariant a panicking holder could break.
        lock(&self.state)
    }
}

impl FeedState {
    // Keeps `outlet` and answers the detach that removes it.
    fn attach(
        &mut self,
        outlet: LatestValueOutlet<ProjectList>,
        shared: &Arc<SharedFeed>,
    ) -> Box<dyn FnOnce() + Send> {
        let outlet_id = self.next_outlet_id;
        self.next_outlet_id += 1;
        self.outlets.insert(outlet_id, outlet);
        let shared: Weak<SharedFeed> = Arc::downgrade(shared);
        Box::new(move || {
            if let Some(shared) = shared.upgrade() {
                shared.detach(outlet_id);
            }
        })
    }

    // Drops the list, its reading task and every outlet, whose streams then end; changes are no
    // longer kept.
    fn drop_list(&mut self) {
        self.is_collecting = false;
        self.pending_projects.clear();
        self.pending_sessions.clear();
        self.outlets.clear();
        // This may run inside the reading task, which then ends at its next await.
        self.held = None;
    }
}

impl HeldList {
    fn new(generation: u64, listed: ListedProjects, reading: AbortOnDropHandle<()>) -> Self {
        Self {
            generation,
            session_projects: listed
                .sessions
                .iter()
                .map(|facts| (facts.session_id, facts.project_id))
                .collect(),
            projects: listed.projects,
            _reading: reading,
        }
    }

    // Replaces every project read again with what the read found, a project whose row is gone
    // leaving the list, and maps their sessions as read.
    fn apply(&mut self, changes: ProjectChanges) {
        let read: HashSet<ProjectId> = changes.read_project_ids.into_iter().collect();
        self.projects
            .retain(|listed| !read.contains(&listed.entry.project_id));
        self.session_projects
            .retain(|_, project_id| !read.contains(project_id));
        self.session_projects.extend(
            changes
                .listed
                .sessions
                .iter()
                .map(|facts| (facts.session_id, facts.project_id)),
        );
        self.projects.extend(changes.listed.projects);
        self.projects.sort_by(|left, right| {
            (left.created_at.as_str(), left.entry.project_id)
                .cmp(&(right.created_at.as_str(), right.entry.project_id))
        });
    }

    fn list(&self) -> ProjectList {
        ProjectList {
            projects: self
                .projects
                .iter()
                .map(|listed| listed.entry.clone())
                .collect(),
        }
    }
}

// Reads the waiting changes until the list drops, one read per wake however many changes waited.
async fn read_changes(shared: Arc<SharedFeed>, records: Arc<ProjectRecords>, generation: u64) {
    loop {
        shared.changed.notified().await;
        let Some((session_ids, project_ids)) = shared.take_changes(generation) else {
            return;
        };
        if session_ids.is_empty() && project_ids.is_empty() {
            continue;
        }
        #[cfg(test)]
        shared.burst_read_pause.pass().await;
        let read = records.read_project_changes(session_ids, project_ids).await;
        if !shared.apply(generation, read) {
            return;
        }
    }
}

// The sessions whose project's count, tally or running session `event` can move: its own session
// for a session or workspace lifecycle change, a run's lifecycle and a plan's card, and the
// removed sessions of a purge's receipt. Fails when a receipt's payload does not read.
fn sessions_named(event: &CommittedEvent) -> Result<Vec<SessionId>, serde_json::Error> {
    let envelope = &event.envelope;
    match envelope.event_type() {
        SessionEventType::SessionCreated
        | SessionEventType::SessionActivated
        | SessionEventType::SessionArchived
        | SessionEventType::SessionReactivated
        | SessionEventType::SessionClosed
        | SessionEventType::SessionConverted
        | SessionEventType::WorkspacePreparing
        | SessionEventType::WorkspacePrepared
        | SessionEventType::WorkspaceArchived
        | SessionEventType::AgentRunQueued
        | SessionEventType::AgentRunStarting
        | SessionEventType::AgentRunRunning
        | SessionEventType::AgentRunWaitingForApproval
        | SessionEventType::AgentRunWaitingForInput
        | SessionEventType::AgentRunPausing
        | SessionEventType::AgentRunPaused
        | SessionEventType::AgentRunCompleted
        | SessionEventType::AgentRunInterrupted
        | SessionEventType::AgentRunStopped
        | SessionEventType::AgentRunFailed
        | SessionEventType::AgentRunRolledBack
        | SessionEventType::AgentRunProviderInitialized
        | SessionEventType::AgentTurnStarted
        | SessionEventType::AgentTurnCompleted
        | SessionEventType::AgentTurnInterrupted
        | SessionEventType::AgentTurnFailed
        | SessionEventType::AgentRunWorkerShuttingDown
        | SessionEventType::AgentRunStepLimitReached
        | SessionEventType::AgentRunTokenLimitReached
        | SessionEventType::AgentRunRecoveryStepsAdded
        | SessionEventType::AgentRunRecoveryResolved
        | SessionEventType::AgentRunRefusalChoiceRequested
        | SessionEventType::AgentRunRefusalChoiceResolved
        | SessionEventType::AgentRunUsageCreditsChoiceRequested
        | SessionEventType::AgentRunUsageCreditsChoiceResolved
        | SessionEventType::PlanProposed
        | SessionEventType::PlanAccepted
        | SessionEventType::PlanHandedOff
        | SessionEventType::PlanKept
        | SessionEventType::PlanHoldEnded => Ok(vec![envelope.session_id()]),
        // A purge's receipt comes after its sessions' rows are deleted, so only the held map
        // still knows their projects.
        SessionEventType::SessionEventCompacted => {
            let receipt: SessionEventCompactedPayload =
                serde_json::from_value(serde_json::Value::Object(envelope.payload().clone()))?;
            Ok(receipt
                .removed_sessions
                .as_slice()
                .iter()
                .map(|removed| removed.session_id)
                .collect())
        }
        SessionEventType::AgentMessageSent
        | SessionEventType::AgentThinkingUpdated
        | SessionEventType::AgentToolCallInvoked
        | SessionEventType::AgentToolCallCompleted
        | SessionEventType::AgentToolCallFailed
        | SessionEventType::AgentSubagentStarted
        | SessionEventType::AgentSubagentCompleted
        | SessionEventType::AgentCommandEnded
        | SessionEventType::AgentQueueItemCreated
        | SessionEventType::AgentQueueItemAdmitted
        | SessionEventType::AgentQueueItemSuperseded
        | SessionEventType::AgentQueueItemCanceled
        | SessionEventType::AgentQueueItemNotDelivered
        | SessionEventType::AgentInterventionRequested
        | SessionEventType::AgentInterventionAccepted
        | SessionEventType::AgentInterventionApplied
        | SessionEventType::AgentInterventionRejected
        | SessionEventType::AgentInterventionDegraded
        | SessionEventType::AgentInterventionExpired
        | SessionEventType::AgentInterventionFailed
        | SessionEventType::UserMessageSent
        | SessionEventType::QuestionAsked
        | SessionEventType::QuestionOpened
        | SessionEventType::QuestionCanceled
        | SessionEventType::ArtifactPublished
        | SessionEventType::GitSettled
        | SessionEventType::SessionGoalUpdated
        | SessionEventType::SessionGoalCleared
        | SessionEventType::SessionProviderStatusReported
        | SessionEventType::SessionNoticePosted
        | SessionEventType::SessionRenamed
        | SessionEventType::SessionPinned
        | SessionEventType::SessionUnpinned
        | SessionEventType::SessionMuted
        | SessionEventType::SessionUnmuted
        | SessionEventType::SessionSideQuestionAnswered
        | SessionEventType::SessionSpendLimitReached
        | SessionEventType::SessionRestoreCompleted
        | SessionEventType::SessionAdvisorChanged
        | SessionEventType::SessionOutputStyleChanged
        | SessionEventType::AgentProviderBindingChanged
        | SessionEventType::AgentProviderBindingChangeFailed
        | SessionEventType::WorkspaceRootLost
        | SessionEventType::WorktreeCreated
        | SessionEventType::WorktreeBound
        | SessionEventType::WorktreeDirtied
        | SessionEventType::WorktreeMerged
        | SessionEventType::WorktreeRetired
        | SessionEventType::RepoMountHealthChanged
        | SessionEventType::SessionBranchChanged
        | SessionEventType::SessionSweptToCheckout
        | SessionEventType::TerminalControlChanged
        | SessionEventType::CloudTaskUpdated
        | SessionEventType::ApprovalRequested
        | SessionEventType::ApprovalApproved
        | SessionEventType::ApprovalRejected
        | SessionEventType::ApprovalCanceled
        | SessionEventType::ApprovalRuleRemembered
        | SessionEventType::ApprovalRuleRevoked
        | SessionEventType::ApprovalReviewerDenied
        | SessionEventType::ApprovalDenialOverridden
        | SessionEventType::ApprovalReviewerFlagged
        | SessionEventType::UsageTokenCountRecorded
        | SessionEventType::UsageCostUpdated
        | SessionEventType::UsageContextWindowUpdated
        | SessionEventType::UsageRateLimitUpdated
        | SessionEventType::UsageApiRequestRetried
        | SessionEventType::AgentRunContextCompacted
        | SessionEventType::AgentTurnRerouted
        | SessionEventType::DaemonRecoveryAttempted
        | SessionEventType::DaemonRecoverySucceeded
        | SessionEventType::DaemonRecoveryFailed
        | SessionEventType::SessionDamagedEventsSkipped
        | SessionEventType::RelayPinRefused
        | SessionEventType::DaemonBackupCompleted
        | SessionEventType::DaemonBackupFailed
        | SessionEventType::DaemonBackupRestored
        | SessionEventType::AgentRunRejected
        | SessionEventType::McpServerSignInCompleted
        | SessionEventType::WorkflowVersionCreated
        | SessionEventType::WorkflowRunStarted
        | SessionEventType::WorkflowGateReached
        | SessionEventType::WorkflowRunFailed
        | SessionEventType::WorkflowRunCompleted
        | SessionEventType::WorkflowRunResumed
        | SessionEventType::WorkflowRunCanceled
        | SessionEventType::WorkflowRunWaiting
        | SessionEventType::WorkflowRunDeleted
        | SessionEventType::WorkflowScheduleArmed
        | SessionEventType::WorkflowScheduleFired
        | SessionEventType::WorkflowTriggerArmed
        | SessionEventType::WorkflowTriggerFired
        | SessionEventType::WorkflowResultsPosted
        | SessionEventType::WorkflowPhaseAdmitted
        | SessionEventType::WorkflowPhaseWaitingOnPool
        | SessionEventType::WorkflowPhaseStarted
        | SessionEventType::WorkflowPhaseProgressed
        | SessionEventType::WorkflowPhaseCanceling
        | SessionEventType::WorkflowPhaseFailed
        | SessionEventType::WorkflowPhaseRetried
        | SessionEventType::WorkflowPhaseSuspended
        | SessionEventType::WorkflowPhaseResumed
        | SessionEventType::WorkflowPhaseCompleted
        | SessionEventType::WorkflowStepStarted
        | SessionEventType::WorkflowStepCompleted
        | SessionEventType::WorkflowStepFailed
        | SessionEventType::WorkflowStepCanceled
        | SessionEventType::WorkflowStepSkipped
        | SessionEventType::WorkflowParallelJoinBranchesCanceled
        | SessionEventType::WorkflowGateResolved => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use futures::FutureExt as _;
    use rusqlite::{Connection, params};
    use serde_json::json;
    use sidekicks_contracts::project::{ProjectId, ProjectList};
    use sidekicks_contracts::repo::mount::ExecutionMode;
    use sidekicks_contracts::session::directory::SessionActivity;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_ipc::stream::feed::Feed as _;
    use sidekicks_ipc::stream::latest_value::LatestValueFeed;
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_envelope, test_session_id,
    };
    use sidekicks_store::events::log_service::EventLogAppendOptions;
    use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
    use tokio::time::timeout;

    use crate::git::worktree::schema::schema_parts;
    use crate::project::list_feed::ProjectListFeed;
    use crate::project::records::{
        PROJECT_RECORDS_STATEMENT_CAPACITY, ProjectRecords, ProjectSessionActivity,
        ProjectSessionFacts,
    };
    use crate::project::test_doubles::OpenGate;
    use crate::test_rows::PARENT_ROWS_AT;

    // Long enough that a read the feed was going to make has made it.
    const QUIET: Duration = Duration::from_millis(200);
    const WAIT: Duration = Duration::from_secs(10);

    // The session directory's activity as the test sets it, counting each read and failing on
    // demand.
    #[derive(Default)]
    struct CountedActivity {
        reads: AtomicUsize,
        is_failing: AtomicBool,
        facts: Mutex<Vec<ProjectSessionFacts>>,
    }

    impl ProjectSessionActivity for CountedActivity {
        fn read_session_facts(
            &self,
            _reader: &Connection,
            project_ids: Option<&[ProjectId]>,
        ) -> rusqlite::Result<Vec<ProjectSessionFacts>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.is_failing.load(Ordering::SeqCst) {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(lock(&self.facts)
                .iter()
                .filter(|facts| project_ids.is_none_or(|ids| ids.contains(&facts.project_id)))
                .cloned()
                .collect())
        }
    }

    impl CountedActivity {
        fn reads(&self) -> usize {
            self.reads.load(Ordering::SeqCst)
        }

        fn set(&self, project_id: ProjectId, session_id: SessionId, activity: SessionActivity) {
            *lock(&self.facts) = vec![ProjectSessionFacts {
                project_id,
                session_id,
                activity,
            }];
        }
    }

    // A project and one of its sessions, the session found in it through its create request.
    fn insert_project_session(
        connection: &Connection,
        project_id: ProjectId,
        session_id: SessionId,
    ) {
        connection
            .execute(
                "INSERT INTO projects (id, name, slug, folder_path, state, setup, created_at, \
                 updated_at) VALUES (?1, 'app', ?1, '/repos/app', 'active', \
                 '{\"filesToCopy\":[],\"commands\":[]}', ?2, ?2)",
                params![project_id.text().as_str(), PARENT_ROWS_AT],
            )
            .expect("the test stores a project");
        insert_session_row(connection, session_id.text().as_str(), None, None);
        connection
            .execute(
                "INSERT INTO session_create_requests (client_idempotency_key, session_id, \
                 project_id, execution_mode) VALUES (?1, ?1, ?2, ?3)",
                params![
                    session_id.text().as_str(),
                    project_id.text().as_str(),
                    <&'static str>::from(ExecutionMode::ProvisionedWorktree)
                ],
            )
            .expect("the test stores the session's create request");
    }

    async fn append_archived(log: &TestLog, session_id: SessionId) {
        let event = serde_json::from_value(json!({
            "type": "session.archived",
            "payload": { "sessionId": session_id, "newState": "archived" },
        }))
        .expect("the test writes a session.archived event");
        log.service
            .append(
                test_envelope(session_id, &event),
                EventLogAppendOptions::default(),
            )
            .await
            .expect("the event is appended");
    }

    type ProjectListStream = LatestValueFeed<ProjectList, Box<dyn FnOnce() + Send>>;

    async fn open_list(feed: &Arc<ProjectListFeed>) -> Result<ProjectListStream, HandlerError> {
        let feed = Arc::clone(feed);
        LatestValueFeed::open(move |outlet| async move { feed.open(outlet).await }).await
    }

    fn running_count(list: &ProjectList) -> SafeInt<0> {
        list.projects
            .first()
            .expect("the list holds the project")
            .session_tally
            .running
    }

    // Kills a read per change (a fourth read reaches the third hold), a send of an unchanged list,
    // a failed read that leaves its subscription open, and a held list kept past a failure (the
    // reopen would answer without reading).
    #[tokio::test]
    async fn a_burst_reads_once_an_unchanged_list_is_not_sent_and_a_failed_read_ends_the_list() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let project_id =
            ProjectId::try_from(mint_uuid_v7()).expect("a minted UUID is a project id");
        let session_id = test_session_id();
        insert_project_session(&database.reader(), project_id, session_id);
        let activity = Arc::new(CountedActivity::default());
        activity.set(project_id, session_id, SessionActivity::Idle);
        let records = Arc::new(ProjectRecords::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                PROJECT_RECORDS_STATEMENT_CAPACITY,
            )),
            Arc::clone(&activity) as Arc<dyn ProjectSessionActivity>,
        ));
        let feed = Arc::new(ProjectListFeed::new(records, &log.followers));
        let gate = OpenGate;

        let mut list = open_list(&feed).await.expect("the list opens");
        let opened = list
            .next(&gate)
            .await
            .expect("the list reads")
            .expect("a list comes");
        assert_eq!(
            running_count(&opened),
            SafeInt::new(0).expect("zero is a safe integer")
        );
        assert_eq!(activity.reads(), 1);

        // The first change is held after its take, so the burst waits behind it.
        let first_hold = feed.shared.burst_read_pause.arm();
        let burst_hold = feed.shared.burst_read_pause.arm();
        feed.refresh(&[project_id]);
        first_hold.reached.await.expect("the first change is taken");
        activity.set(project_id, session_id, SessionActivity::Running);
        for _ in 0..3 {
            append_archived(&log, session_id).await;
        }
        feed.refresh(&[project_id]);
        first_hold.release.send(()).expect("the first read is held");

        let changed = timeout(WAIT, list.next(&gate))
            .await
            .expect("the changed list comes")
            .expect("the list reads")
            .expect("a list comes");
        assert_eq!(
            running_count(&changed),
            SafeInt::new(1).expect("one is a safe integer")
        );
        timeout(WAIT, burst_hold.reached)
            .await
            .expect("the burst is taken")
            .expect("the burst is held");
        let after_burst_hold = feed.shared.burst_read_pause.arm();
        burst_hold.release.send(()).expect("the burst read is held");
        let mut after_burst_reached = after_burst_hold.reached;
        assert!(
            timeout(QUIET, &mut after_burst_reached).await.is_err(),
            "three events and a refresh read once"
        );
        assert_eq!(activity.reads(), 3);
        assert!(
            list.next(&gate).now_or_never().is_none(),
            "an unchanged list is not sent"
        );

        activity.is_failing.store(true, Ordering::SeqCst);
        feed.refresh(&[project_id]);
        after_burst_reached
            .await
            .expect("the failing read is taken");
        after_burst_hold
            .release
            .send(())
            .expect("the failing read is held");
        assert!(
            timeout(WAIT, list.next(&gate))
                .await
                .expect("the stream answers")
                .is_err(),
            "a failed read ends the subscription"
        );

        activity.is_failing.store(false, Ordering::SeqCst);
        let reads_before_reopen = activity.reads();
        let mut reopened = open_list(&feed).await.expect("the list opens again");
        let reread = reopened
            .next(&gate)
            .await
            .expect("the list reads")
            .expect("a list comes");
        assert_eq!(
            activity.reads(),
            reads_before_reopen + 1,
            "the reopen reads the rows"
        );
        assert_eq!(
            running_count(&reread),
            SafeInt::new(1).expect("one is a safe integer")
        );
    }
}
