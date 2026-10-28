//! A session's activity: `waiting` while any of its runs in `runs` or a plan's card waits on the
//! person, else `running` while any of its runs works, else how its last run ended, which each
//! run's end event writes to `sessions.last_run_outcome`. A run reads as it does until its state
//! changes. The project list reads each project session's activity through
//! [`ProjectSessionActivityReader`].

use rusqlite::{Connection, Row, named_params};
use serde_json::{Map, Value};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::directory::SessionActivity;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_workspace::project::records::{
    ProjectSessionActivity, ProjectSessionFacts, session_project_sql,
};

use crate::plan_holds::PlanHolds;

/// The statements [`ProjectSessionActivityReader`] prepares: every project's sessions, and the
/// sessions of the projects named.
pub const PROJECT_SESSION_ACTIVITY_STATEMENT_CAPACITY: usize = 2;

// The run states a session reads as waiting on the person, and those it reads as working.
const WAITING_RUN_STATES: [RunState; 2] = [RunState::WaitingForApproval, RunState::WaitingForInput];
const WORKING_RUN_STATES: [RunState; 3] =
    [RunState::Starting, RunState::Running, RunState::Pausing];

/// How a run event that ends a run's working time leaves its session, read from the event's
/// payload; `None` for every other event type. A paused run can go on, but its session reads idle
/// until it does.
pub(crate) fn run_outcome_of(
    event_type: SessionEventType,
    payload: &Map<String, Value>,
) -> Option<SessionActivity> {
    match event_type {
        SessionEventType::AgentRunCompleted => Some(SessionActivity::Done),
        // A terminal the daemon's own close produced is never read as a crash.
        SessionEventType::AgentRunFailed => Some(
            if payload.get("intendedClose") == Some(&Value::Bool(true)) {
                SessionActivity::Idle
            } else {
                SessionActivity::Failed
            },
        ),
        SessionEventType::AgentRunInterrupted
        | SessionEventType::AgentRunStopped
        | SessionEventType::AgentRunPaused => Some(SessionActivity::Idle),
        SessionEventType::AgentRunQueued
        | SessionEventType::AgentRunStarting
        | SessionEventType::AgentRunRunning
        | SessionEventType::AgentRunWaitingForApproval
        | SessionEventType::AgentRunWaitingForInput
        | SessionEventType::AgentRunPausing
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
        | SessionEventType::AgentMessageSent
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
        | SessionEventType::SessionCreated
        | SessionEventType::SessionActivated
        | SessionEventType::SessionArchived
        | SessionEventType::SessionReactivated
        | SessionEventType::SessionClosed
        | SessionEventType::SessionGoalUpdated
        | SessionEventType::SessionGoalCleared
        | SessionEventType::SessionProviderStatusReported
        | SessionEventType::SessionNoticePosted
        | SessionEventType::SessionRenamed
        | SessionEventType::SessionPinned
        | SessionEventType::SessionUnpinned
        | SessionEventType::SessionMuted
        | SessionEventType::SessionUnmuted
        | SessionEventType::SessionConverted
        | SessionEventType::SessionSideQuestionAnswered
        | SessionEventType::SessionSpendLimitReached
        | SessionEventType::SessionRestoreCompleted
        | SessionEventType::SessionAdvisorChanged
        | SessionEventType::SessionOutputStyleChanged
        | SessionEventType::AgentProviderBindingChanged
        | SessionEventType::AgentProviderBindingChangeFailed
        | SessionEventType::WorkspacePreparing
        | SessionEventType::WorkspacePrepared
        | SessionEventType::WorkspaceRootLost
        | SessionEventType::WorkspaceArchived
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
        | SessionEventType::PlanProposed
        | SessionEventType::PlanAccepted
        | SessionEventType::PlanHandedOff
        | SessionEventType::PlanKept
        | SessionEventType::PlanHoldEnded
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
        | SessionEventType::SessionEventCompacted
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
        | SessionEventType::WorkflowGateResolved => None,
    }
}

/// The SQL of a session's activity, from the session id's SQL, its `last_run_outcome`'s and the
/// condition under which a plan's card waits on the person: such a session reads waiting too,
/// since no run waits on the plan. Each run read is an indexed lookup of the session's runs.
pub fn session_activity_sql(
    session_id_sql: &str,
    last_run_outcome_sql: &str,
    waiting_plan_sql: &str,
) -> String {
    let is_any_run_in = |states: &[RunState]| {
        format!(
            "EXISTS (SELECT 1 FROM runs WHERE runs.session_id = {session_id_sql}
                AND runs.state IN ({}))",
            sql_list_of(states.iter().map(<&'static str>::from))
        )
    };
    let waiting = <&'static str>::from(SessionActivity::Waiting);
    let running = <&'static str>::from(SessionActivity::Running);
    format!(
        "CASE WHEN {} OR {waiting_plan_sql} THEN '{waiting}'
               WHEN {} THEN '{running}'
               ELSE {last_run_outcome_sql} END",
        is_any_run_in(&WAITING_RUN_STATES),
        is_any_run_in(&WORKING_RUN_STATES),
    )
}

/// The activity of each project session, a session being purged left out, which the project list
/// counts and tallies; its two reads are composed once.
pub struct ProjectSessionActivityReader {
    every: String,
    named: String,
}

impl ProjectSessionActivityReader {
    /// The reader, a session reading waiting while `plan_holds` has a plan of its waiting on the
    /// person, as the sessions list reads it.
    pub fn new(plan_holds: &dyn PlanHolds) -> Self {
        let project = <&'static str>::from(SessionShape::Project);
        let purge_requested = <&'static str>::from(SessionState::PurgeRequested);
        let facts_of = |sessions_sql: &str| {
            format!(
                "SELECT facts.project_id, facts.session_id, facts.activity
                   FROM (SELECT {} AS project_id, s.id AS session_id, {} AS activity
                           FROM {sessions_sql}
                          WHERE s.shape = '{project}' AND s.state <> '{purge_requested}') AS facts",
                session_project_sql("s.id"),
                session_activity_sql(
                    "s.id",
                    "s.last_run_outcome",
                    &plan_holds.waiting_plan_sql("s.id")
                ),
            )
        };
        Self {
            every: format!(
                "{} WHERE facts.project_id IS NOT NULL",
                facts_of("sessions AS s")
            ),
            // From the projects' side over their mounts' workspaces and their sessions' create
            // requests; each candidate's project is then read as for every project, so a session
            // whose newest workspace sits on another project's mount drops out.
            named: format!(
                "WITH named(project_id) AS (SELECT value FROM json_each(@project_ids)),
                      candidates(session_id) AS (
                        SELECT workspace.session_id FROM named
                          JOIN repo_mounts AS mount ON mount.project_id = named.project_id
                          JOIN workspaces AS workspace ON workspace.repo_mount_id = mount.id
                        UNION
                        SELECT request.session_id FROM named
                          JOIN session_create_requests AS request
                            ON request.project_id = named.project_id)
                 {} WHERE facts.project_id IN (SELECT project_id FROM named)",
                facts_of("candidates JOIN sessions AS s ON s.id = candidates.session_id")
            ),
        }
    }
}

impl ProjectSessionActivity for ProjectSessionActivityReader {
    fn read_session_facts(
        &self,
        reader: &Connection,
        project_ids: Option<&[ProjectId]>,
    ) -> rusqlite::Result<Vec<ProjectSessionFacts>> {
        match project_ids {
            None => reader
                .prepare_cached(&self.every)?
                .query_map([], project_session_facts_of)?
                .collect(),
            Some(project_ids) => {
                let project_ids =
                    serde_json::to_string(project_ids).expect("a list of ids serializes to JSON");
                reader
                    .prepare_cached(&self.named)?
                    .query_map(
                        named_params! { "@project_ids": project_ids },
                        project_session_facts_of,
                    )?
                    .collect()
            }
        }
    }
}

fn project_session_facts_of(row: &Row<'_>) -> rusqlite::Result<ProjectSessionFacts> {
    Ok(ProjectSessionFacts {
        project_id: text_column(row, 0, |text| ProjectId::new(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        activity: text_column(row, 2, closed_word)?,
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};
    use sidekicks_contracts::project::ProjectId;
    use sidekicks_contracts::repo::mount::ExecutionMode;
    use sidekicks_contracts::run::state::RunState;
    use sidekicks_contracts::session::directory::SessionActivity;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::{SessionShape, SessionState};
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_workspace::project::records::{ProjectSessionActivity as _, ProjectSessionFacts};
    use sidekicks_workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

    use super::ProjectSessionActivityReader;
    use crate::plan_holds::NoPlanHolds;
    use crate::questions::schema::schema_parts;

    // Stores a session of `shape` in `state`, made in `project_id`, whose last run ended `outcome`.
    fn store_session(
        connection: &Connection,
        project_id: ProjectId,
        shape: SessionShape,
        state: SessionState,
        outcome: SessionActivity,
    ) -> SessionId {
        let session_id = test_session_id();
        insert_session_row(connection, session_id.text().as_str(), None, None);
        connection
            .execute(
                "UPDATE sessions SET shape = ?2, state = ?3, last_run_outcome = ?4 WHERE id = ?1",
                params![
                    session_id.text().as_str(),
                    <&'static str>::from(shape),
                    <&'static str>::from(state),
                    <&'static str>::from(outcome)
                ],
            )
            .expect("the test stores the session's facts");
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
        session_id
    }

    fn store_run(connection: &Connection, session_id: SessionId, state: RunState) {
        connection
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?1, ?2, ?3, 0)",
                params![
                    mint_uuid_v7().to_string(),
                    session_id.text().as_str(),
                    <&'static str>::from(state)
                ],
            )
            .expect("the test stores the run");
    }

    fn sorted(mut facts: Vec<ProjectSessionFacts>) -> Vec<ProjectSessionFacts> {
        facts.sort_by_key(|facts| facts.session_id.to_string());
        facts
    }

    // A project with a running, a waiting and a done session, a chat and a session being purged
    // made in it, and another project's session. Kills: the purge-state filter dropped (the
    // purged session counts), the shape filter dropped (the chat counts), and a named read that
    // reaches no session through its project's mount or reaches another project's.
    #[test]
    fn the_facts_list_a_projects_sessions_but_a_chat_and_one_being_purged() {
        let database = TestDatabase::new(schema_parts());
        let connection = database.reader();
        let project_id =
            ProjectId::try_from(mint_uuid_v7()).expect("a minted UUID is a project id");
        let other_id = ProjectId::try_from(mint_uuid_v7()).expect("a minted UUID is a project id");
        let [project_row, mount_row] = project_and_mount_rows(project_id.text().as_str(), None);
        let [other_row, _] = project_and_mount_rows(other_id.text().as_str(), None);
        for row in [project_row, mount_row, other_row] {
            connection
                .execute_batch(&row)
                .expect("a project row is stored");
        }
        let session = |project_id, shape, state, outcome| {
            store_session(&connection, project_id, shape, state, outcome)
        };
        let (project, active) = (SessionShape::Project, SessionState::Active);
        let running = session(project_id, project, active, SessionActivity::Idle);
        store_run(&connection, running, RunState::Running);
        let waiting = session(project_id, project, active, SessionActivity::Done);
        store_run(&connection, waiting, RunState::WaitingForInput);
        let done = session(
            project_id,
            project,
            SessionState::Archived,
            SessionActivity::Done,
        );
        session(
            project_id,
            SessionShape::Chat,
            active,
            SessionActivity::Done,
        );
        session(
            project_id,
            project,
            SessionState::PurgeRequested,
            SessionActivity::Done,
        );
        let elsewhere = session(other_id, project, active, SessionActivity::Idle);
        // The running session reaches its project through its workspace on the project's mount
        // alone.
        connection
            .execute(
                "DELETE FROM session_create_requests WHERE session_id = ?1",
                [running.text().as_str()],
            )
            .expect("the test drops the running session's create request");
        connection
            .execute(
                "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, \
                 created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![
                    mint_uuid_v7().to_string(),
                    running.text().as_str(),
                    project_id.text().as_str(),
                    <&'static str>::from(ExecutionMode::ProvisionedWorktree),
                    PARENT_ROWS_AT
                ],
            )
            .expect("the test stores the running session's workspace");

        let reader = ProjectSessionActivityReader::new(&NoPlanHolds);
        let facts = |session_id, project_id, activity| ProjectSessionFacts {
            project_id,
            session_id,
            activity,
        };
        let projects = sorted(vec![
            facts(running, project_id, SessionActivity::Running),
            facts(waiting, project_id, SessionActivity::Waiting),
            facts(done, project_id, SessionActivity::Done),
        ]);
        let mut every = projects.clone();
        every.push(facts(elsewhere, other_id, SessionActivity::Idle));

        let named = reader
            .read_session_facts(&connection, Some(&[project_id]))
            .expect("the project's facts read");
        let all = reader
            .read_session_facts(&connection, None)
            .expect("every project's facts read");

        assert_eq!(sorted(named), projects);
        assert_eq!(sorted(all), sorted(every));
    }
}
