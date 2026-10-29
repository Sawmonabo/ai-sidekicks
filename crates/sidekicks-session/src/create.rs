//! Creating a session: its lead as the request names it, on its provider's current account, bound
//! where it works. A chat's managed workspace is made before the chat exists, so a workspace that
//! cannot be made leaves no chat, and a chat that is not born takes its workspace with it; a
//! project session binds to its project's attached mount.
//!
//! - The session is born `provisioning` with `session.created`, whose write also records the
//!   request's idempotency key with where the session works, re-checks the lead's account, the
//!   project and its group, and writes a picked advisor; it reads `active` once bound.
//! - A session made in a project still cloning stays `provisioning` until the clone attaches.
//! - Creates of one key run one at a time, each whole in a task of its own: a create with a
//!   recorded key answers the session that key made, finishing it first when it was left
//!   `provisioning`.

mod account;
mod provisioning;
#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::collections::HashSet;
use std::error::Error;
use std::sync::{Arc, LazyLock, Mutex};

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::json;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::{AgentProviderBinding, ProviderToken};
use sidekicks_contracts::agent::methods::AgentSubscribeEntry;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::{ProjectId, ProjectState};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountState};
use sidekicks_contracts::session::directory::{
    SessionCreateRequest, SessionCreateResponse, SessionLead,
};
use sidekicks_contracts::session::events::SessionCreatedPayload;
use sidekicks_contracts::session::groups::SessionGroupId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};
use sidekicks_contracts::wire::id::{ClientUuid, UuidText, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::params_and_results::ListModelsParams;
use sidekicks_provider::driver::error_causes::ProviderAxisInvalid;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
#[cfg(test)]
use sidekicks_std::pause_point::PausePoint;
use sidekicks_std::settle_all::SettleFailures;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::managed::service::{ManagedWorkspaceError, ManagedWorkspaceService};
use sidekicks_workspace::repo::errors::RepoRefusal;
use sidekicks_workspace::schema::MountOrigin;
use sidekicks_workspace::service::{WorkspaceService, WorkspaceServiceError};
use tokio::task::JoinError;

use crate::console_state::INSERT_CONSOLE_STATE_SQL;
use crate::create::account::{ResolvedAccount, read_current_account};
use crate::create::provisioning::{SessionFinishFailure, SessionToFinish};

/// The statements the creation's reads keep prepared on each read connection: a recorded create,
/// the current account and whether any is registered, a project's target, the sessions left
/// provisioning, a session's mount, whether a project clones, the unborn chats, whether one chat
/// is unborn and a session's state.
pub const SESSION_CREATION_STATEMENT_CAPACITY: usize = 10;

// Each statement's position in `session.created`'s write: the request's record, then the account
// guard; a project session's project and folder guards and its group guard follow.
const ACCOUNT_GUARD_INDEX: usize = 1;
const PROJECT_GUARD_INDEX: usize = 2;
const FOLDER_GUARD_INDEX: usize = 3;
const GROUP_GUARD_INDEX: usize = 4;

const RECORD_CREATE_REQUEST_SQL: &str = "INSERT INTO session_create_requests
  (client_idempotency_key, session_id, project_id, execution_mode, group_id)
  VALUES (@key, @sessionId, @projectId, @executionMode, @groupId)";

// A create's record joined with the session it made as it reads now, and the lead it was born on
// with its account.
static SELECT_RECORDED_CREATE_SQL: LazyLock<String> = LazyLock::new(|| {
    let session_created = SessionEventType::SessionCreated.as_str();
    format!(
        "SELECT request.session_id, request.project_id, request.execution_mode, request.group_id,
        session.shape, session.state, session.place,
        json_extract(created.payload, '$.mainAgent.binding'),
        json_extract(created.payload, '$.mainAgent.agentId'),
        json_extract(created.payload, '$.mainAgent.binding.providerAccountId')
   FROM session_create_requests AS request
   JOIN sessions AS session ON session.id = request.session_id
   JOIN session_events AS created
     ON created.session_id = request.session_id AND created.type = '{session_created}'
  WHERE request.client_idempotency_key = @key"
    )
});

// The project a session is made in: whether it clones, whether a folder of it is attached, and
// where it is, by its attached folder's place, else its own.
static SELECT_PROJECT_TARGET_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT project.state = '{cloning}', mount.id IS NOT NULL,
        coalesce(mount.place, project.place)
   FROM projects AS project
   LEFT JOIN repo_mounts AS mount
     ON mount.project_id = project.id AND {ATTACHED_PROJECT_MOUNT}
  WHERE project.id = @projectId
  LIMIT 1",
        cloning = <&'static str>::from(ProjectState::Cloning),
        ATTACHED_PROJECT_MOUNT = *ATTACHED_PROJECT_MOUNT_SQL,
    )
});

// A project's own attached folder, as `mount` reads it.
static ATTACHED_PROJECT_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "mount.origin = '{attached_origin}' AND mount.state = '{attached}'",
        attached_origin = <&'static str>::from(MountOrigin::Attached),
        attached = <&'static str>::from(RepoMountState::Attached),
    )
});

// Holds only while the project a session is made in exists.
const PROJECT_GUARD_SQL: &str = "SELECT 1 FROM projects WHERE id = @projectId";

// Holds only while the project clones or has an attached folder to bind to.
static FOLDER_GUARD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM projects AS project
  WHERE project.id = @projectId
    AND (project.state = '{cloning}'
         OR EXISTS (SELECT 1 FROM repo_mounts AS mount
                     WHERE mount.project_id = project.id AND {attached}))",
        cloning = <&'static str>::from(ProjectState::Cloning),
        attached = *ATTACHED_PROJECT_MOUNT_SQL,
    )
});

// Holds only while the group belongs to the project the session is made in.
const GROUP_GUARD_SQL: &str =
    "SELECT 1 FROM session_groups WHERE id = @groupId AND project_id = @projectId";

/// What creating a session reads, appends and binds through.
pub struct SessionCreationDeps {
    /// The read pool, sized with [`SESSION_CREATION_STATEMENT_CAPACITY`].
    pub reads: Arc<DatabaseReadPool>,
    /// Appends the session's `session.created` and `session.activated`.
    pub appender: Arc<SessionEventAppender>,
    /// The drivers, which name the lead and read its starting level and advisor.
    pub providers: Arc<ProviderRegistry>,
    /// Binds the session to the mount it works in.
    pub workspaces: Arc<WorkspaceService>,
    /// Makes a chat's managed workspace, and removes it when the chat is not born.
    pub managed_workspaces: Arc<ManagedWorkspaceService>,
    /// The machine's settings, whose provider rows hold the advisor the app picked.
    pub settings: Arc<dyn MachineSettingsReader>,
}

/// Creates sessions as the person asks for them, one create at a time for each idempotency key.
/// See the module doc.
pub struct SessionCreation {
    reads: Arc<DatabaseReadPool>,
    appender: Arc<SessionEventAppender>,
    providers: Arc<ProviderRegistry>,
    workspaces: Arc<WorkspaceService>,
    managed_workspaces: Arc<ManagedWorkspaceService>,
    settings: Arc<dyn MachineSettingsReader>,
    key_lock: Arc<KeyedLock<ClientUuid>>,
    // The chats whose workspace is made or being made and whose `session.created` has not settled,
    // so the removal of unborn chats' workspaces never takes one of theirs.
    chats_being_created: Mutex<HashSet<SessionId>>,
    /// Where a test holds a create just before it appends `session.created`.
    #[cfg(test)]
    pub(crate) created_append_pause: PausePoint,
    /// Where a test holds a finish just before it appends `session.activated`.
    #[cfg(test)]
    pub(crate) activated_append_pause: PausePoint,
}

/// Why a create, or the finish of a session left provisioning, failed.
#[derive(Debug, thiserror::Error)]
pub enum SessionCreateError {
    /// A refusal sent with its code: `project.notFound`, `repoMount.notFound`,
    /// `session.group.refused`, `session.notFound`, `provider.account.notRegistered` or
    /// `provider.account.current.notSet`.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The lead's driver refused or failed, `agent.providerAxisInvalid` among its refusals.
    #[error(transparent)]
    Driver(#[from] DriverError),
    /// The bind of the session to its mount was refused or failed.
    #[error(transparent)]
    Workspace(#[from] WorkspaceServiceError),
    /// The chat's managed workspace could not be made.
    #[error(transparent)]
    ManagedWorkspace(#[from] ManagedWorkspaceError),
    /// The chat was not born, and removing its managed workspace failed too.
    #[error(transparent)]
    WorkspaceNotRemoved(Box<CleanupFailures<SessionCreateError, ManagedWorkspaceError>>),
    /// The machine's settings could not be read.
    #[error("the machine's settings could not be read")]
    Settings(#[source] Box<dyn Error + Send + Sync>),
    /// The database could not be read.
    #[error("the session's create could not be read")]
    Read(#[from] DatabaseReadError),
    /// A stored row could not be read into its typed facts.
    #[error("a row the session's create reads could not be read")]
    Row(#[from] rusqlite::Error),
    /// An event breaks one of its type's checks.
    #[error("the session's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// An event and the rows it carries were not kept.
    #[error("the session's event was not appended")]
    Append(#[source] SessionEventAppendError),
    /// A chat has no managed mount to bind to, which its create always makes first.
    #[error("chat {session_id} has no managed mount to bind to")]
    ChatWithoutMount {
        /// The chat.
        session_id: SessionId,
    },
    /// The create was skipped, since its caller stopped waiting before its key was held.
    #[error("the session's create was skipped once its caller stopped waiting")]
    Unanswered,
    /// The task that ran the create ended before the create finished.
    #[error("the session's create ended before it finished")]
    Interrupted(#[source] JoinError),
    /// Some stopped creates could not be finished; every other one was.
    #[error(transparent)]
    Finish(#[from] SettleFailures<SessionFinishFailure>),
}

impl From<SessionCreateError> for HandlerError {
    /// A refusal answers its code, a driver's or a bind's as they answer it; anything else is a
    /// fault in the daemon.
    fn from(error: SessionCreateError) -> Self {
        match error {
            SessionCreateError::Refused(refusal) => Self::Refused(refusal),
            SessionCreateError::Driver(driver) => driver.into(),
            SessionCreateError::Workspace(workspace) => workspace.into(),
            fault @ (SessionCreateError::ManagedWorkspace(_)
            | SessionCreateError::WorkspaceNotRemoved(_)
            | SessionCreateError::Settings(_)
            | SessionCreateError::Read(_)
            | SessionCreateError::Row(_)
            | SessionCreateError::Draft(_)
            | SessionCreateError::Append(_)
            | SessionCreateError::ChatWithoutMount { .. }
            | SessionCreateError::Unanswered
            | SessionCreateError::Interrupted(_)
            | SessionCreateError::Finish(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// What a request asks for, whichever shape it has.
struct CreateTarget<'request> {
    key: &'request ClientUuid,
    lead: &'request SessionLead,
    shape: SessionShape,
    project_id: Option<ProjectId>,
    execution_mode: ExecutionMode,
    group_id: Option<SessionGroupId>,
}

/// A session about to be born, as `session.created` records it.
struct NewSession<'request> {
    session_id: SessionId,
    target: CreateTarget<'request>,
    agent_id: AgentId,
    agent_name: &'static str,
    place: Option<Place>,
    #[expect(
        clippy::option_option,
        reason = "a pick the app never made differs from one set to no advisor"
    )]
    advisor_pick: Option<Option<String>>,
}

/// A create's record with the session it made, as that session reads now.
pub(crate) struct RecordedCreate {
    /// What its finish needs.
    pub(crate) session: SessionToFinish,
    shape: SessionShape,
    state: SessionState,
    place: Option<Place>,
}

impl SessionCreation {
    /// The creation over `deps`.
    pub fn new(deps: SessionCreationDeps) -> Self {
        Self {
            reads: deps.reads,
            appender: deps.appender,
            providers: deps.providers,
            workspaces: deps.workspaces,
            managed_workspaces: deps.managed_workspaces,
            settings: deps.settings,
            key_lock: Arc::new(KeyedLock::new()),
            chats_being_created: Mutex::new(HashSet::new()),
            #[cfg(test)]
            created_append_pause: PausePoint::default(),
            #[cfg(test)]
            activated_append_pause: PausePoint::default(),
        }
    }

    /// `session.create`: makes the session and answers once it is bound and active, or
    /// `provisioning` in a project still cloning, with the lead's binding on its provider's
    /// current account. A request whose key already made a session answers that session as it
    /// reads now, binding and activating it first when it was left `provisioning`; one sent while
    /// its key's create runs waits for it. The create runs whole in a task of its own under its
    /// key, so a caller that stops waiting never leaves it part made. Refuses, writing nothing,
    /// `agent.providerAxisInvalid` for a provider no driver answers or a model, effort or session
    /// option the lead's driver does not offer, `provider.account.notRegistered` or
    /// `provider.account.current.notSet` for a lead with no current account, `project.notFound`,
    /// `repoMount.notFound` for a project with no attached folder that is not cloning, and
    /// `session.group.refused` for a group of another project; fails as the driver's catalog read
    /// fails. A failure after `session.created` leaves the session `provisioning` for a retry or
    /// the daemon's next start to finish.
    pub async fn create(
        self: &Arc<Self>,
        request: SessionCreateRequest,
    ) -> Result<SessionCreateResponse, SessionCreateError> {
        let key = target_of(&request).key.clone();
        let creation = Arc::clone(self);
        let landed = self
            .key_lock
            .run_held(
                key.clone(),
                async move { creation.create_held(&request).await },
                move |answer: &Result<SessionCreateResponse, SessionCreateError>| match answer {
                    Ok(created) => tracing::info!(
                        session_id = %created.session_id,
                        client_idempotency_key = key.as_str(),
                        "a session's create finished after its caller stopped waiting"
                    ),
                    Err(error) => tracing::error!(
                        client_idempotency_key = key.as_str(),
                        error = error as &(dyn Error + 'static),
                        "a session's create failed after its caller stopped waiting"
                    ),
                },
            )
            .await;
        match landed {
            Ok(Some(answer)) => answer,
            Ok(None) => Err(SessionCreateError::Unanswered),
            Err(interrupted) => Err(SessionCreateError::Interrupted(interrupted)),
        }
    }

    // The create `create` describes, run while its key is held.
    async fn create_held(
        &self,
        request: &SessionCreateRequest,
    ) -> Result<SessionCreateResponse, SessionCreateError> {
        let target = target_of(request);
        if let Some(recorded) = self.read_recorded(target.key.clone()).await? {
            return self.answer_recorded(recorded).await;
        }
        let lead = target.lead;
        let agent_id = AgentId::try_from(mint_uuid_v7()).expect("a minted UUID is an agent id");
        let driver = self.lead_driver(agent_id, &lead.provider_name)?;
        let agent_name = self.providers.descriptor(&lead.provider_name)?.name();
        let account = self.resolve_account(&lead.provider_name).await?;
        check_lead_offered(&*driver, agent_id, lead, &account.provider_account_id).await?;
        let settings = self
            .settings
            .read_machine_settings()
            .await
            .map_err(SessionCreateError::Settings)?;
        let app_values = settings
            .provider_settings
            .as_map()
            .get(&lead.provider_name)
            .cloned()
            .unwrap_or_else(ProviderRowValues::default);
        let advisor_pick = driver.session_advisor_pick(&app_values);
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");

        let mut new_session = NewSession {
            session_id,
            target,
            agent_id,
            agent_name,
            place: None,
            advisor_pick,
        };
        let (lead_binding, provider_account_id) = match new_session.target.project_id {
            None => self.create_chat(&mut new_session, account).await?,
            Some(project_id) => {
                new_session.place = self.read_project_place(project_id).await?;
                self.append_created(&new_session, account).await?
            }
        };
        let session = SessionToFinish {
            session_id,
            project_id: new_session.target.project_id,
            execution_mode: new_session.target.execution_mode,
            group_id: new_session.target.group_id,
            agent_id,
            lead: lead_binding.clone(),
            provider_account_id,
        };
        let state = self.finish(&session).await?;
        Ok(SessionCreateResponse {
            session_id,
            shape: new_session.target.shape,
            state,
            place: new_session.place,
            lead: lead_binding,
        })
    }

    // The lead's driver; a provider no driver answers is refused `agent.providerAxisInvalid` on
    // the lead's provider axis, for the lead `agent_id`.
    fn lead_driver(
        &self,
        agent_id: AgentId,
        provider: &ProviderId,
    ) -> Result<Arc<dyn ProviderDriver>, SessionCreateError> {
        // The registry's one refusal is a provider no driver answers.
        let Ok(driver) = self.providers.lookup(provider) else {
            return Err(
                DriverError::from(ProviderAxisInvalid::provider_not_registered(
                    agent_id, provider,
                ))
                .into(),
            );
        };
        Ok(driver)
    }

    // Makes the chat's workspace, then the chat; a chat not born takes its workspace with it.
    async fn create_chat(
        &self,
        new_session: &mut NewSession<'_>,
        account: ResolvedAccount,
    ) -> Result<(AgentProviderBinding, ProviderAccountId), SessionCreateError> {
        let session_id = new_session.session_id;
        let _being_created = ChatBeingCreated::enter(&self.chats_being_created, session_id);
        let workspace = self.managed_workspaces.create(session_id).await?;
        new_session.place = workspace.place;
        match self.append_created(new_session, account).await {
            Ok(born) => Ok(born),
            Err(creation) => match self.managed_workspaces.delete(session_id).await {
                Ok(()) => Err(creation),
                Err(removal) => Err(SessionCreateError::WorkspaceNotRemoved(Box::new(
                    CleanupFailures::new(creation, vec![removal], "creating a chat"),
                ))),
            },
        }
    }

    // Appends `session.created` with the request's record and its guards, answering the binding
    // the lead was born on and its account. A refused account guard means the current account moved since it was
    // read, so it is read again and the write tried again.
    async fn append_created(
        &self,
        new_session: &NewSession<'_>,
        mut account: ResolvedAccount,
    ) -> Result<(AgentProviderBinding, ProviderAccountId), SessionCreateError> {
        let session_id = new_session.session_id;
        let target = &new_session.target;
        let lead = target.lead;
        loop {
            let created_at = WireInstant::now();
            let lead_binding = AgentProviderBinding {
                provider_name: lead.provider_name.clone(),
                model_id: lead.model_id.clone(),
                provider_account_id: Some(account.provider_account_id.clone()),
                effort: lead.effort.clone(),
                output_speed: lead.output_speed.clone(),
                options: lead.options.clone(),
                larger_window: lead.larger_window,
            };
            let payload = SessionCreatedPayload {
                session_id,
                shape: target.shape,
                main_agent: AgentSubscribeEntry {
                    agent_id: new_session.agent_id,
                    name: FreeFormText::new(new_session.agent_name.to_owned())
                        .expect("a provider's name is short, visible text"),
                    binding: lead_binding.clone(),
                    observed_output_speed: None,
                    observed_options: None,
                    pending_switch: None,
                    resolved_configuration: None,
                    ancestry: Vec::new(),
                    created_at: created_at.clone(),
                },
                parent: None,
                scratch_for_definition_id: None,
                actor: None,
                place: new_session.place.clone(),
            };
            let draft = SessionEventDraft::of_session(
                session_id,
                &SessionEvent::SessionCreated(Box::new(payload)),
            )?;
            let transactional_prelude =
                created_prelude(new_session, account.guard.clone(), &created_at);
            #[cfg(test)]
            self.created_append_pause.pass().await;
            let appended = self
                .appender
                .append(
                    draft,
                    SessionEventLinkage {
                        occurred_at: Some(created_at),
                        transactional_prelude,
                        ..SessionEventLinkage::default()
                    },
                )
                .await;
            let Err(error) = appended else {
                return Ok((lead_binding, account.provider_account_id));
            };
            let refused_index = error.refused_statement_index();
            let project_id = target.project_id;
            return Err(match (refused_index, project_id, target.group_id) {
                (Some(ACCOUNT_GUARD_INDEX), _, _) => {
                    account = self.resolve_account(&lead.provider_name).await?;
                    continue;
                }
                (Some(PROJECT_GUARD_INDEX), Some(project_id), _) => {
                    DomainError::from(RepoRefusal::ProjectNotFound { project_id }).into()
                }
                (Some(FOLDER_GUARD_INDEX), Some(project_id), _) => {
                    project_folder_not_attached(project_id).into()
                }
                (Some(GROUP_GUARD_INDEX), Some(_), Some(group_id)) => DomainError::new(
                    "The session cannot sit in that group.",
                    RefusalCode::SessionGroupRefused,
                )
                .with_detail(json!({ "groupId": group_id }))
                .into(),
                _ => SessionCreateError::Append(error),
            });
        }
    }

    // The session a recorded create made, finished first when it was left provisioning.
    async fn answer_recorded(
        &self,
        recorded: RecordedCreate,
    ) -> Result<SessionCreateResponse, SessionCreateError> {
        let state = if recorded.state == SessionState::Provisioning {
            self.finish(&recorded.session).await?
        } else {
            recorded.state
        };
        Ok(SessionCreateResponse {
            session_id: recorded.session.session_id,
            shape: recorded.shape,
            state,
            place: recorded.place,
            lead: recorded.session.lead,
        })
    }

    async fn resolve_account(
        &self,
        provider: &ProviderId,
    ) -> Result<ResolvedAccount, SessionCreateError> {
        let provider = provider.clone();
        self.reads
            .read(ReadLength::Short, move |connection| {
                read_current_account(connection, &provider)
            })
            .await
    }

    /// The create `key` recorded, joined with the session it made; `None` before one landed.
    pub(crate) async fn read_recorded(
        &self,
        key: ClientUuid,
    ) -> Result<Option<RecordedCreate>, SessionCreateError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                read_recorded_create(connection, &key)
            })
            .await
    }

    // Where a project session runs. Refuses `project.notFound`, and `repoMount.notFound` for a
    // project neither cloning nor with an attached folder.
    async fn read_project_place(
        &self,
        project_id: ProjectId,
    ) -> Result<Option<Place>, SessionCreateError> {
        let target = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, SessionCreateError>(
                    connection
                        .prepare_cached(&SELECT_PROJECT_TARGET_SQL)?
                        .query_row(
                            named_params! { "@projectId": project_id.text().as_str() },
                            |row| {
                                Ok((
                                    row.get::<_, bool>(0)?,
                                    row.get::<_, bool>(1)?,
                                    optional_text_column(row, 2, |text| {
                                        serde_json::from_str::<Place>(&text)
                                    })?,
                                ))
                            },
                        )
                        .optional()?,
                )
            })
            .await?;
        match target {
            None => Err(DomainError::from(RepoRefusal::ProjectNotFound { project_id }).into()),
            Some((false, false, _)) => Err(project_folder_not_attached(project_id).into()),
            Some((_, _, place)) => Ok(place),
        }
    }
}

/// Keeps a chat among those being created until it is dropped, whatever ends the create.
struct ChatBeingCreated<'creation> {
    chats: &'creation Mutex<HashSet<SessionId>>,
    session_id: SessionId,
}

impl<'creation> ChatBeingCreated<'creation> {
    fn enter(chats: &'creation Mutex<HashSet<SessionId>>, session_id: SessionId) -> Self {
        lock(chats).insert(session_id);
        Self { chats, session_id }
    }
}

impl Drop for ChatBeingCreated<'_> {
    fn drop(&mut self) {
        lock(self.chats).remove(&self.session_id);
    }
}

fn target_of(request: &SessionCreateRequest) -> CreateTarget<'_> {
    match request {
        SessionCreateRequest::Project(project) => CreateTarget {
            key: &project.client_idempotency_key,
            lead: &project.lead,
            shape: SessionShape::Project,
            project_id: Some(project.binding.project_id),
            execution_mode: project.binding.execution_mode,
            group_id: project.group_id,
        },
        SessionCreateRequest::Chat(chat) => CreateTarget {
            key: &chat.client_idempotency_key,
            lead: &chat.lead,
            shape: SessionShape::Chat,
            project_id: None,
            execution_mode: ExecutionMode::BoundRoot,
            group_id: None,
        },
    }
}

// `session.created`'s prelude, in the order the guard indexes name: the request's record, the
// account guard, a project session's project, folder and group guards, then a picked advisor.
fn created_prelude(
    new_session: &NewSession<'_>,
    account_guard: WriteStatement,
    created_at: &WireInstant,
) -> Vec<WriteStatement> {
    let session_id = new_session.session_id;
    let target = &new_session.target;
    let project_text = target.project_id.map(|project_id| project_id.text());
    let project = project_text.as_ref().map(UuidText::as_str);
    let group_text = target.group_id.map(|group_id| group_id.text());
    let mut prelude = vec![
        WriteStatement {
            sql: Cow::Borrowed(RECORD_CREATE_REQUEST_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@key", target.key.as_str()),
                text_binding("@sessionId", session_id.text().as_str()),
                (
                    Cow::Borrowed("@projectId"),
                    project.map_or(Value::Null, |project| Value::Text(project.to_owned())),
                ),
                text_binding("@executionMode", target.execution_mode.into()),
                (
                    Cow::Borrowed("@groupId"),
                    group_text
                        .as_ref()
                        .map_or(Value::Null, |group| Value::Text(group.as_str().to_owned())),
                ),
            ]),
            expected_row_count: None,
        },
        account_guard,
    ];
    if let Some(project) = project {
        prelude.push(project_guard(PROJECT_GUARD_SQL, project, None));
        prelude.push(project_guard(FOLDER_GUARD_SQL.as_str(), project, None));
        if let Some(group) = &group_text {
            prelude.push(project_guard(
                GROUP_GUARD_SQL,
                project,
                Some(group.as_str()),
            ));
        }
    }
    if let Some(advisor) = &new_session.advisor_pick {
        prelude.push(WriteStatement {
            sql: Cow::Borrowed(INSERT_CONSOLE_STATE_SQL),
            bindings: StatementBindings::Positional(vec![
                Value::Text(session_id.to_string()),
                advisor.clone().map_or(Value::Null, Value::Text),
                Value::Text(created_at.as_str().to_owned()),
            ]),
            expected_row_count: None,
        });
    }
    prelude
}

// A guard on the project bound as `@projectId`, and the group as `@groupId` where one is given,
// that holds while `sql` answers one row.
fn project_guard(sql: &'static str, project: &str, group: Option<&str>) -> WriteStatement {
    let mut bindings = vec![text_binding("@projectId", project)];
    if let Some(group) = group {
        bindings.push(text_binding("@groupId", group));
    }
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: Some(1),
    }
}

/// `repoMount.notFound` for a project session: the project is not cloning and none of its folders
/// is attached, so the session has nowhere to work.
pub(crate) fn project_folder_not_attached(project_id: ProjectId) -> DomainError {
    DomainError::new(
        "The project's folder is no longer attached.",
        RefusalCode::RepoMountNotFound,
    )
    .with_detail(json!({ "projectId": project_id }))
}

// Refuses `agent.providerAxisInvalid` for the lead `agent_id` when its model, effort or session
// options are not what its driver offers on `provider_account_id` now; fails as the reads fail.
async fn check_lead_offered(
    driver: &dyn ProviderDriver,
    agent_id: AgentId,
    lead: &SessionLead,
    provider_account_id: &ProviderAccountId,
) -> Result<(), SessionCreateError> {
    let (models, options) = futures::future::try_join(
        driver.list_models(ListModelsParams {
            session_id: None,
            provider_account_id: Some(provider_account_id.clone()),
        }),
        driver.session_options(),
    )
    .await?;
    ProviderAxisInvalid::check_offered(
        agent_id,
        lead.model_id.as_str(),
        lead.effort.as_ref().map(ProviderToken::as_str),
        lead.options.as_ref(),
        &models,
        &options,
    )
    .map_err(DriverError::from)?;
    Ok(())
}

fn read_recorded_create(
    connection: &Connection,
    key: &ClientUuid,
) -> Result<Option<RecordedCreate>, SessionCreateError> {
    Ok(connection
        .prepare_cached(&SELECT_RECORDED_CREATE_SQL)?
        .query_row(named_params! { "@key": key.as_str() }, |row| {
            Ok(RecordedCreate {
                session: SessionToFinish {
                    session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                    project_id: optional_text_column(row, 1, |text| ProjectId::new(&text))?,
                    execution_mode: text_column(row, 2, closed_word)?,
                    group_id: optional_text_column(row, 3, |text| SessionGroupId::new(&text))?,
                    agent_id: text_column(row, 8, |text| AgentId::new(&text))?,
                    lead: text_column(row, 7, |text| {
                        serde_json::from_str::<AgentProviderBinding>(&text)
                    })?,
                    provider_account_id: text_column(row, 9, closed_word::<ProviderAccountId>)?,
                },
                shape: text_column(row, 4, closed_word)?,
                state: text_column(row, 5, closed_word)?,
                place: optional_text_column(row, 6, |text| serde_json::from_str::<Place>(&text))?,
            })
        })
        .optional()?)
}
