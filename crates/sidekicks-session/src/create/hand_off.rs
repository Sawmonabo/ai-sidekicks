//! A plan handed to a fresh session: the record its verdict writes of what it fixed, and the
//! fresh session's birth under the id the verdict fixed. The birth runs the create's own steps in
//! the planning session's project, or in the planning chat's folder, which it never makes anew,
//! and names the session after the plan's first heading. It never binds or activates the session;
//! that is its finish.

#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::error::Error;
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::mount::ExecutionMode;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::directory::SessionLead;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_workspace::project::records::session_project_sql;
use sidekicks_workspace::working_folder::{
    SessionWorkingFolder, WorkingFolderReadError, read_working_folder,
};

use crate::changes::session_name_of;
use crate::create::{CreateTarget, SessionCreateError, SessionCreation};

const INSERT_HAND_OFF_SQL: &str = "INSERT INTO session_hand_offs
  (session_id, client_idempotency_key, plan_id, planning_session_id, lead, permission_level,
   title, device_id)
  VALUES (@sessionId, @key, @planId, @planningSessionId, @lead, @permissionLevel, @title,
          @deviceId)";

const SELECT_HAND_OFF_SQL: &str = "SELECT session_id, client_idempotency_key, plan_id,
        planning_session_id, lead, permission_level, title, device_id
   FROM session_hand_offs
  WHERE client_idempotency_key = @key";

// The planning session's project as it reads now, and the one its create record names, which
// outlives a project forgotten since.
static SELECT_PLANNING_PROJECT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {live},
        (SELECT project_id FROM session_create_requests WHERE session_id = @sessionId)",
        live = session_project_sql("@sessionId"),
    )
});

/// What a plan's verdict fixed for the fresh session it hands the plan to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionHandOff {
    /// The fresh session, under the id the verdict fixed.
    pub session_id: SessionId,
    /// The key of the fresh session's create: its id as a client UUID.
    pub client_idempotency_key: ClientUuid,
    /// The plan handed off.
    pub plan_id: PlanId,
    /// The session the plan was made in.
    pub planning_session_id: SessionId,
    /// The fresh session's lead, as a create request names one.
    pub lead: SessionLead,
    /// The level the fresh session starts at.
    pub permission_level: PermissionLevel,
    /// The plan's first heading, which names the fresh session.
    pub title: String,
    /// The device whose verdict handed the plan off.
    pub device_id: DeviceId,
}

/// The insert of `hand_off`'s record, for the write that settles the plan's verdict.
pub fn record_hand_off_statement(hand_off: &SessionHandOff) -> WriteStatement {
    let lead = serde_json::to_string(&hand_off.lead).expect("a session lead serializes to JSON");
    WriteStatement {
        sql: Cow::Borrowed(INSERT_HAND_OFF_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", hand_off.session_id.text().as_str()),
            text_binding("@key", hand_off.client_idempotency_key.as_str()),
            text_binding("@planId", hand_off.plan_id.text().as_str()),
            text_binding(
                "@planningSessionId",
                hand_off.planning_session_id.text().as_str(),
            ),
            text_binding("@lead", &lead),
            text_binding("@permissionLevel", hand_off.permission_level.into()),
            text_binding("@title", &hand_off.title),
            text_binding("@deviceId", hand_off.device_id.as_str()),
        ]),
        expected_row_count: None,
    }
}

/// The hand-off whose fresh session's create runs under `key`, read on `reader`; `None` for a key
/// no hand-off holds. Fails for a stored row that does not read, its lead among them.
pub fn read_hand_off(
    reader: &Connection,
    key: &ClientUuid,
) -> rusqlite::Result<Option<SessionHandOff>> {
    reader
        .prepare_cached(SELECT_HAND_OFF_SQL)?
        .query_row(named_params! { "@key": key.as_str() }, |row| {
            Ok(SessionHandOff {
                session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                client_idempotency_key: text_column(row, 1, closed_word::<ClientUuid>)?,
                plan_id: text_column(row, 2, |text| PlanId::new(&text))?,
                planning_session_id: text_column(row, 3, |text| SessionId::new(&text))?,
                lead: text_column(row, 4, |text| serde_json::from_str::<SessionLead>(&text))?,
                permission_level: text_column(row, 5, closed_word::<PermissionLevel>)?,
                title: row.get(6)?,
                device_id: text_column(row, 7, closed_word::<DeviceId>)?,
            })
        })
        .optional()
}

/// What a hand-off's birth reads in one go: its record, where the planning session works and the
/// project the fresh session is made in, `None` for a chat.
struct HandOffBirth {
    hand_off: SessionHandOff,
    planning_folder: SessionWorkingFolder,
    project_id: Option<ProjectId>,
}

impl SessionCreation {
    /// Births the fresh session of the hand-off whose create runs under `key`: `session.created`
    /// under the id the verdict fixed, in `provisioning`, with the create's record, in the planning
    /// session's project at its folder (or the planning chat's folder), on the lead's provider's
    /// current account, named after the plan's first heading. A key that already made its session
    /// answers at once, leaving it as it reads; the birth runs whole in a task of its own under the
    /// key. Refuses `session.notFound` for a key no hand-off holds or a planning session gone,
    /// `project.notFound` for a planning project forgotten, and as `create` refuses for the lead,
    /// its account and the project's folder.
    pub async fn create_handed_off(
        self: &Arc<Self>,
        key: ClientUuid,
    ) -> Result<(), SessionCreateError> {
        let creation = Arc::clone(self);
        let held_key = key.clone();
        self.key_lock
            .run_held(
                key.clone(),
                async move { creation.create_handed_off_held(&held_key).await },
                move |answer: &Result<(), SessionCreateError>| match answer {
                    Ok(()) => tracing::info!(
                        client_idempotency_key = key.as_str(),
                        "a hand-off's birth finished after its caller stopped waiting"
                    ),
                    Err(error) => tracing::error!(
                        client_idempotency_key = key.as_str(),
                        error = error as &(dyn Error + 'static),
                        "a hand-off's birth failed after its caller stopped waiting"
                    ),
                },
            )
            .await?
    }

    // The birth `create_handed_off` describes, run while its key is held.
    async fn create_handed_off_held(&self, key: &ClientUuid) -> Result<(), SessionCreateError> {
        if self.read_recorded(key.clone()).await?.is_some() {
            return Ok(());
        }
        let read_key = key.clone();
        let HandOffBirth {
            hand_off,
            planning_folder,
            project_id,
        } = self
            .reads
            .read(ReadLength::Short, move |reader| {
                read_hand_off_birth(reader, &read_key)
            })
            .await?;
        let target = CreateTarget {
            key,
            lead: &hand_off.lead,
            shape: planning_folder.shape,
            project_id,
            execution_mode: ExecutionMode::BoundRoot,
            group_id: None,
            directory: directory_in_mount(&planning_folder),
        };
        let (mut new_session, account) = self.prepare_birth(target, hand_off.session_id).await?;
        // A title that makes no name, blank or holding a NUL, leaves the session for the naming
        // pass to name after its first exchange.
        new_session.name = session_name_of(&hand_off.title).unwrap_or_default();
        new_session.place = match project_id {
            Some(project_id) => self.read_project_place(project_id).await?,
            None => planning_folder.place,
        };
        self.append_created(&new_session, account).await?;
        Ok(())
    }
}

// The hand-off `key` holds, its planning session's working folder and the project the fresh
// session is made in, read in one snapshot.
fn read_hand_off_birth(
    reader: &Connection,
    key: &ClientUuid,
) -> Result<HandOffBirth, SessionCreateError> {
    let snapshot = reader.unchecked_transaction()?;
    let Some(hand_off) = read_hand_off(&snapshot, key)? else {
        return Err(DomainError::session_not_found(
            "This daemon holds no such session.",
            json!({ "sessionId": key }),
        )
        .into());
    };
    let planning_session_id = hand_off.planning_session_id;
    let planning_folder =
        read_working_folder(&snapshot, &planning_session_id).map_err(|error| match error {
            WorkingFolderReadError::Refused(refusal) => SessionCreateError::Refused(refusal),
            WorkingFolderReadError::Database(database) => SessionCreateError::Row(database),
        })?;
    let (live_project, recorded_project) = snapshot
        .prepare_cached(&SELECT_PLANNING_PROJECT_SQL)?
        .query_row(
        named_params! { "@sessionId": planning_session_id.text().as_str() },
        |row| {
            Ok((
                optional_text_column(row, 0, |text| ProjectId::new(&text))?,
                optional_text_column(row, 1, |text| ProjectId::new(&text))?,
            ))
        },
    )?;
    // A project forgotten since leaves its id on the create record, whose place read refuses it.
    let project_id = match (planning_folder.shape, live_project.or(recorded_project)) {
        (SessionShape::Chat, _) => None,
        (SessionShape::Project, Some(project_id)) => Some(project_id),
        // A chat converted into a project keeps no project on its create record.
        (SessionShape::Project, None) => {
            return Err(DomainError::new(
                "The planning session's project is no longer here.",
                RefusalCode::ProjectNotFound,
            )
            .with_detail(json!({ "sessionId": planning_session_id }))
            .into());
        }
    };
    Ok(HandOffBirth {
        hand_off,
        planning_folder,
        project_id,
    })
}

// Where in its mount the planning session works: its folder's text, `None` at the repository's own
// root or while no folder is in place.
fn directory_in_mount(planning_folder: &SessionWorkingFolder) -> Option<String> {
    let working_folder = planning_folder.working_folder.as_ref()?;
    match &planning_folder.repository {
        Some(repository) if *working_folder == repository.repository_root => None,
        Some(_) | None => Some(working_folder.to_string_lossy().into_owned()),
    }
}
