//! The steps a session takes from `provisioning` to `active`: the bind to the mount it works in,
//! the level and mode its provider starts it at, and `session.activated`. A create runs them at
//! once; a project's clone runs them for the sessions made while it cloned; the daemon's start
//! runs them for every session a stop left provisioning, after removing the workspace of each chat
//! whose create stopped before the chat was born.

use std::borrow::Cow;
use std::error::Error;
use std::path::PathBuf;
use std::sync::LazyLock;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{OptionalExtension, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::AgentProviderBinding;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::project::{ProjectId, ProjectState};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, RepoMountState};
use sidekicks_contracts::repo::workspace::WorkspaceBindRequest;
use sidekicks_contracts::session::events::SessionLifecycleChangePayload;
use sidekicks_contracts::session::groups::SessionGroupId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_provider::driver::session_control::StartingLevelParams;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::settle_all::settle_all;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_store::events::session::appender::{SessionEventDraft, SessionEventLinkage};
use sidekicks_workspace::clone::service::CloneAttachedListener;
use sidekicks_workspace::schema::MountOrigin;

use crate::console_state::session_mode_change_statement;
use crate::create::{SessionCreateError, SessionCreation, project_folder_not_attached};
use crate::groups::store::session_group_placement_statement;
use crate::permission_level::permission_level_change_statement;

// `session.activated`'s first statement, which holds only while the session is still provisioning,
// so a session archived or closed meanwhile is never set active.
const PROVISIONING_GUARD_INDEX: usize = 0;

// The sessions left provisioning with the key that made each, those of one project when
// `@projectId` names it.
static SELECT_PROVISIONING_CREATES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT request.client_idempotency_key, request.session_id
   FROM session_create_requests AS request
   JOIN sessions AS session ON session.id = request.session_id
  WHERE session.state = '{provisioning}'
    AND (@projectId IS NULL OR request.project_id = @projectId)
  ORDER BY request.session_id",
        provisioning = <&'static str>::from(SessionState::Provisioning),
    )
});

// The mount a session binds to: a chat's own managed mount, or its project's attached one, which a
// project still cloning has not yet.
static SELECT_SESSION_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, canonical_root FROM repo_mounts
  WHERE state = '{attached}'
    AND CASE WHEN @projectId IS NULL THEN managed_session_id = @sessionId
             ELSE origin = '{attached_origin}' AND project_id = @projectId END",
        attached = <&'static str>::from(RepoMountState::Attached),
        attached_origin = <&'static str>::from(MountOrigin::Attached),
    )
});

static PROVISIONING_GUARD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM sessions WHERE id = @sessionId AND state = '{}'",
        <&'static str>::from(SessionState::Provisioning)
    )
});

const SELECT_SESSION_STATE_SQL: &str = "SELECT state FROM sessions WHERE id = @sessionId";

static SELECT_PROJECT_CLONING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT EXISTS (SELECT 1 FROM projects WHERE id = @projectId AND state = '{}')",
        <&'static str>::from(ProjectState::Cloning)
    )
});

// Holds for a session whose create never wrote `session.created`: it has no directory row, no
// recorded create and no event, each of which that write leaves.
fn never_born_sql(session_id_sql: &str) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM sessions WHERE id = {session_id_sql})
     AND NOT EXISTS (SELECT 1 FROM session_create_requests WHERE session_id = {session_id_sql})
     AND NOT EXISTS (SELECT 1 FROM session_events WHERE session_id = {session_id_sql})"
    )
}

// The chats whose managed workspace was made but whose create stopped before the chat was born.
static SELECT_UNBORN_CHATS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT mount.managed_session_id FROM repo_mounts AS mount
  WHERE mount.origin = '{managed}' AND {}
  ORDER BY mount.managed_session_id",
        never_born_sql("mount.managed_session_id"),
        managed = <&'static str>::from(MountOrigin::Managed),
    )
});

static SELECT_SESSION_NEVER_BORN_SQL: LazyLock<String> =
    LazyLock::new(|| format!("SELECT {}", never_born_sql("@sessionId")));

/// A session a create made, with what its finish binds and starts it on.
pub(crate) struct SessionToFinish {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Its project, `None` for a chat.
    pub(crate) project_id: Option<ProjectId>,
    /// Where in the mount it works.
    pub(crate) execution_mode: ExecutionMode,
    /// The group of its project it asked for.
    pub(crate) group_id: Option<SessionGroupId>,
    /// Its lead.
    pub(crate) agent_id: AgentId,
    /// The binding its lead was born on.
    pub(crate) lead: AgentProviderBinding,
    /// The account its lead was born on.
    pub(crate) provider_account_id: ProviderAccountId,
}

/// One session a stopped create's finish, or one chat workspace's removal, could not complete.
#[derive(Debug, thiserror::Error)]
#[error("session {session_id}'s stopped create could not be finished")]
pub struct SessionFinishFailure {
    /// The session.
    pub session_id: SessionId,
    /// Why.
    #[source]
    pub failure: Box<SessionCreateError>,
}

impl SessionCreation {
    /// Finishes what a stop left of the creates: the managed workspace of each chat never born is
    /// removed with its mount, but for one whose create runs now, then every session left
    /// `provisioning` is finished as a retry of its create would. Every one is tried, and the
    /// failures are answered together as [`SessionCreateError::Finish`]; what failed is left for
    /// the next start or a retry of its create.
    pub async fn finish_stopped_creates(&self) -> Result<(), SessionCreateError> {
        let mut outcomes = Vec::new();
        for session_id in self.read_unborn_chats().await? {
            outcomes.push(
                self.remove_unborn_chat_workspace(session_id)
                    .await
                    .map_err(|failure| finish_failure(session_id, failure)),
            );
        }
        outcomes.extend(self.finish_each_provisioning(None).await?);
        settle_all(outcomes, "finishing the creates a stop left part way")?;
        Ok(())
    }

    /// The bind and the activation of a session left provisioning, answering the state it reads
    /// after: `provisioning`, with nothing done, while its project is still cloning; `active` once
    /// activated; and as it reads now when it left `provisioning` meanwhile, an archive among
    /// them, which nothing binds or activates. Runs while its create's key is held, which it never
    /// takes. Fails with [`SessionCreateError::ChatWithoutMount`] for a chat with no managed mount,
    /// refuses `repoMount.notFound` for a project with no attached folder,
    /// `agent.providerAxisInvalid` for a lead whose provider no driver answers now and
    /// `session.notFound` for a session purged meanwhile, and fails as the bind, the starting
    /// level's read and the append fail.
    pub(crate) async fn finish(
        &self,
        session: &SessionToFinish,
    ) -> Result<SessionState, SessionCreateError> {
        let session_id = session.session_id;
        let project_id = session.project_id;
        let driver = self.lead_driver(session.agent_id, &session.lead.provider_name)?;
        // A session that left provisioning meanwhile is answered as it reads, with nothing bound.
        let state = self.read_session_state(session_id).await?;
        if state != SessionState::Provisioning {
            return Ok(state);
        }
        let Some((repo_mount_id, working_folder)) =
            self.read_session_mount(session_id, project_id).await?
        else {
            return match project_id {
                None => Err(SessionCreateError::ChatWithoutMount { session_id }),
                Some(project_id) if self.is_project_cloning(project_id).await? => {
                    Ok(SessionState::Provisioning)
                }
                Some(project_id) => Err(project_folder_not_attached(project_id).into()),
            };
        };
        self.workspaces
            .bind(&WorkspaceBindRequest {
                session_id,
                repo_mount_id,
                execution_mode: session.execution_mode,
                directory: None,
            })
            .await?;
        let lead = &session.lead;
        let starting = driver
            .read_starting_level(StartingLevelParams::new(
                working_folder,
                lead.model_id.clone(),
                session.provider_account_id.clone(),
            ))
            .await?;

        let activated_at = WireInstant::now();
        let mut transactional_prelude = vec![WriteStatement {
            sql: Cow::Borrowed(PROVISIONING_GUARD_SQL.as_str()),
            bindings: StatementBindings::Named(vec![text_binding(
                "@sessionId",
                session_id.text().as_str(),
            )]),
            expected_row_count: Some(1),
        }];
        // A group removed since the create took its sessions out with it, so a placement that
        // matches no group leaves this one out too.
        if let Some(group_id) = &session.group_id {
            let mut placement = session_group_placement_statement(&session_id, group_id);
            placement.expected_row_count = None;
            transactional_prelude.push(placement);
        }
        transactional_prelude.push(permission_level_change_statement(
            &session_id,
            starting.level(),
        ));
        transactional_prelude.push(session_mode_change_statement(
            &session_id,
            starting.session_mode(),
            activated_at.as_str(),
        ));
        let draft = SessionEventDraft::of_session(
            session_id,
            &SessionEvent::SessionActivated(SessionLifecycleChangePayload {
                session_id,
                previous_state: Some(SessionState::Provisioning),
                new_state: SessionState::Active,
                actor: None,
            }),
        )?;
        #[cfg(test)]
        self.activated_append_pause.pass().await;
        let appended = self
            .appender
            .append(
                draft,
                SessionEventLinkage {
                    occurred_at: Some(activated_at),
                    transactional_prelude,
                    ..SessionEventLinkage::default()
                },
            )
            .await;
        match appended {
            Ok(_) => Ok(SessionState::Active),
            // The session already left provisioning, so there is nothing to activate.
            Err(error) if error.refused_statement_index() == Some(PROVISIONING_GUARD_INDEX) => {
                self.read_session_state(session_id).await
            }
            Err(error) => Err(SessionCreateError::Append(error)),
        }
    }

    async fn read_session_state(
        &self,
        session_id: SessionId,
    ) -> Result<SessionState, SessionCreateError> {
        let state = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, SessionCreateError>(
                    connection
                        .prepare_cached(SELECT_SESSION_STATE_SQL)?
                        .query_row(
                            named_params! { "@sessionId": session_id.text().as_str() },
                            |row| text_column(row, 0, closed_word),
                        )
                        .optional()?,
                )
            })
            .await?;
        state.ok_or_else(|| session_not_found(&session_id).into())
    }

    // Finishes each session left provisioning, `project_id`'s alone when given, each under its
    // key as a retry would, answering each one's outcome.
    async fn finish_each_provisioning(
        &self,
        project_id: Option<ProjectId>,
    ) -> Result<Vec<Result<(), SessionFinishFailure>>, SessionCreateError> {
        let mut outcomes = Vec::new();
        for (key, session_id) in self.read_provisioning_creates(project_id).await? {
            let finished = self.finish_recorded_key(key).await;
            outcomes.push(finished.map_err(|failure| finish_failure(session_id, failure)));
        }
        Ok(outcomes)
    }

    // Finishes the session `key` made when it still reads provisioning under the key's hold.
    async fn finish_recorded_key(&self, key: ClientUuid) -> Result<(), SessionCreateError> {
        let _hold = self.key_lock.acquire(key.clone()).await;
        if let Some(recorded) = self.read_recorded(key).await?
            && recorded.state == SessionState::Provisioning
        {
            self.finish(&recorded.session).await?;
        }
        Ok(())
    }

    // A chat counts as being created from before its workspace is made until its
    // `session.created` write settles, and is checked as born again just before the removal.
    async fn remove_unborn_chat_workspace(
        &self,
        session_id: SessionId,
    ) -> Result<(), SessionCreateError> {
        if lock(&self.chats_being_created).contains(&session_id)
            || !self.is_never_born(session_id).await?
        {
            return Ok(());
        }
        self.managed_workspaces.delete(session_id).await?;
        Ok(())
    }

    async fn read_provisioning_creates(
        &self,
        project_id: Option<ProjectId>,
    ) -> Result<Vec<(ClientUuid, SessionId)>, SessionCreateError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                let project = project_id.map(|project_id| project_id.text().as_str().to_owned());
                Ok(connection
                    .prepare_cached(&SELECT_PROVISIONING_CREATES_SQL)?
                    .query_map(named_params! { "@projectId": project }, |row| {
                        Ok((
                            text_column(row, 0, ClientUuid::new)?,
                            text_column(row, 1, |text| SessionId::new(&text))?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    async fn read_session_mount(
        &self,
        session_id: SessionId,
        project_id: Option<ProjectId>,
    ) -> Result<Option<(RepoMountId, PathBuf)>, SessionCreateError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                let project = project_id.map(|project_id| project_id.text().as_str().to_owned());
                Ok(connection
                    .prepare_cached(&SELECT_SESSION_MOUNT_SQL)?
                    .query_row(
                        named_params! {
                            "@projectId": project,
                            "@sessionId": session_id.text().as_str(),
                        },
                        |row| {
                            Ok((
                                text_column(row, 0, |text| RepoMountId::new(&text))?,
                                PathBuf::from(row.get::<_, String>(1)?),
                            ))
                        },
                    )
                    .optional()?)
            })
            .await
    }

    async fn is_project_cloning(&self, project_id: ProjectId) -> Result<bool, SessionCreateError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_PROJECT_CLONING_SQL)?
                    .query_row(
                        named_params! { "@projectId": project_id.text().as_str() },
                        |row| row.get::<_, bool>(0),
                    )?)
            })
            .await
    }

    async fn read_unborn_chats(&self) -> Result<Vec<SessionId>, SessionCreateError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_UNBORN_CHATS_SQL)?
                    .query_map([], |row| text_column(row, 0, |text| SessionId::new(&text)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    async fn is_never_born(&self, session_id: SessionId) -> Result<bool, SessionCreateError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_SESSION_NEVER_BORN_SQL)?
                    .query_row(
                        named_params! { "@sessionId": session_id.text().as_str() },
                        |row| row.get::<_, bool>(0),
                    )?)
            })
            .await
    }
}

impl CloneAttachedListener for SessionCreation {
    /// Finishes every session made in the project while it cloned; each is tried, and the
    /// failures are answered together.
    fn clone_attached(
        &self,
        project_id: ProjectId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let outcomes = self.finish_each_provisioning(Some(project_id)).await?;
            settle_all(
                outcomes,
                "finishing the sessions made while the project cloned",
            )?;
            Ok(())
        }
        .boxed()
    }
}

fn finish_failure(session_id: SessionId, failure: SessionCreateError) -> SessionFinishFailure {
    SessionFinishFailure {
        session_id,
        failure: Box::new(failure),
    }
}
