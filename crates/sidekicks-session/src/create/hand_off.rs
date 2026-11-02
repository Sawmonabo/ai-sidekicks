//! A plan handed to a fresh session: the record its verdict writes of what it fixed, the fresh
//! session's birth under the id the verdict fixed, and its finish.
//!
//! - The birth runs the create's own steps in the planning session's project, or in the planning
//!   chat's folder, which it never makes anew, and names the session after the plan's first
//!   heading. It never binds or activates the session.
//! - The finish, under the create's key, binds the session in the folder its create recorded (the
//!   mount's root once that folder is no longer a live tree of the mount), has the daemon's
//!   seeding port write the planning transcript's file and the seed plan, and activates it at the
//!   verdict's level in mode `build`, each failure naming its step. Nothing else finishes a
//!   session a hand-off names.
//! - The daemon's start hands each hand-off whose seed no run has taken to the port, which takes
//!   the plan's lock and then runs the finish, so the plan's lock is always taken before the key.

#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::error::Error;
use std::sync::{Arc, LazyLock, Weak};

use futures::future::BoxFuture;
use rusqlite::{Connection, OptionalExtension, Row, named_params};
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::plan::{PlanHandOffStep, PlanId};
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::mount::ExecutionMode;
use sidekicks_contracts::run::queue::PlanMessageKind;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::directory::SessionLead;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};
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
use tokio::sync::SetOnceError;

use crate::changes::session_name_of;
use crate::create::provisioning::failed_at;
use crate::create::{CreateTarget, SessionCreateError, SessionCreation};
use crate::queue_store::{QueueItemReader, RecordedQueueItemState};

const INSERT_HAND_OFF_SQL: &str = "INSERT INTO session_hand_offs
  (session_id, client_idempotency_key, plan_id, planning_session_id, lead, permission_level,
   title, device_id)
  VALUES (@sessionId, @key, @planId, @planningSessionId, @lead, @permissionLevel, @title,
          @deviceId)";

// Every hand-off, in the columns `hand_off_of_row` reads.
const SELECT_HAND_OFFS_SQL: &str = "SELECT session_id, client_idempotency_key, plan_id,
        planning_session_id, lead, permission_level, title, device_id
   FROM session_hand_offs";

static SELECT_HAND_OFF_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{SELECT_HAND_OFFS_SQL}\n  WHERE client_idempotency_key = @key"));

static SELECT_HAND_OFFS_IN_ORDER_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{SELECT_HAND_OFFS_SQL}\n  ORDER BY session_id"));

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

/// The daemon's part of a hand-off's finish: the writes into the fresh session that need the
/// plan's stored bytes and the planning session's log, and the finish of a hand-off a stop left,
/// which takes the plan's lock before the create's key. The daemon sets it once with
/// [`SessionCreation::set_hand_off_seeding`]; a finish that finds it unset or dropped fails with
/// [`SessionCreateError::HandOffSeeding`], since skipping it would activate a fresh session that
/// has no seed plan.
pub trait HandOffSeeding: Send + Sync {
    /// Writes the planning session's transcript into a file of the fresh session, skipped when
    /// the file is already there. Fails as the read or the write fails.
    fn write_transcript_file<'a>(
        &'a self,
        hand_off: &'a SessionHandOff,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Writes the plan into the fresh session as its seed plan, once for the session and the
    /// plan. Fails as the write fails.
    fn write_seed_plan<'a>(
        &'a self,
        hand_off: &'a SessionHandOff,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Finishes a hand-off a stop left whose seed no run has taken, under the plan's lock: its
    /// end when the fresh session is gone, else the steps it has not done. Fails as a step fails.
    fn finish_hand_off(
        &self,
        hand_off: SessionHandOff,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// A hand-off's finish that stopped, with the step it stopped at.
#[derive(Debug, thiserror::Error)]
#[error("the hand-off's {step:?} step did not finish")]
pub struct HandOffStepFailure {
    /// The step that did not finish.
    pub step: PlanHandOffStep,
    /// Why.
    #[source]
    pub failure: SessionCreateError,
}

/// The seeding port read while it is unset, or after the daemon's side of it was dropped.
#[derive(Debug, thiserror::Error)]
#[error("the hand-off seeding port is not set")]
struct HandOffSeedingUnset;

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
        .prepare_cached(&SELECT_HAND_OFF_SQL)?
        .query_row(named_params! { "@key": key.as_str() }, hand_off_of_row)
        .optional()
}

// Every hand-off whose seed no run has taken: no seed in the fresh session's queue, or one still
// waiting or never delivered.
fn query_unseeded_hand_offs(reader: &Connection) -> rusqlite::Result<Vec<SessionHandOff>> {
    let hand_offs = reader
        .prepare_cached(&SELECT_HAND_OFFS_IN_ORDER_SQL)?
        .query_map([], hand_off_of_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let queue = QueueItemReader::new(reader);
    let mut unseeded = Vec::new();
    for hand_off in hand_offs {
        let seed = queue.get_plan_message(
            &hand_off.session_id,
            &hand_off.plan_id,
            PlanMessageKind::Seed,
        )?;
        if seed.is_none_or(|seed| seed.state != RecordedQueueItemState::Admitted) {
            unseeded.push(hand_off);
        }
    }
    Ok(unseeded)
}

fn hand_off_of_row(row: &Row<'_>) -> rusqlite::Result<SessionHandOff> {
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
}

/// What a hand-off's birth reads in one go: its record, where the planning session works and the
/// project the fresh session is made in, `None` for a chat.
struct HandOffBirth {
    hand_off: SessionHandOff,
    planning_folder: SessionWorkingFolder,
    project_id: Option<ProjectId>,
}

impl SessionCreation {
    /// Hands the creation the daemon's seeding port, once, while the daemon wires its services and
    /// before its start pass. Fails with the handle when one was handed already.
    pub fn set_hand_off_seeding(
        &self,
        seeding: Weak<dyn HandOffSeeding>,
    ) -> Result<(), SetOnceError<Weak<dyn HandOffSeeding>>> {
        self.hand_off_seeding.set(seeding)
    }

    /// The seeding port; fails with [`SessionCreateError::HandOffSeeding`] while it is unset or
    /// once the daemon's side of it was dropped.
    pub(super) fn hand_off_seeding(&self) -> Result<Arc<dyn HandOffSeeding>, SessionCreateError> {
        self.hand_off_seeding
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| SessionCreateError::HandOffSeeding(Box::new(HandOffSeedingUnset)))
    }

    /// Every hand-off whose seed no run has taken, for the daemon's start to hand to the port.
    pub(super) async fn read_unseeded_hand_offs(
        &self,
    ) -> Result<Vec<SessionHandOff>, SessionCreateError> {
        self.reads
            .read(ReadLength::Short, |reader| {
                Ok::<_, SessionCreateError>(query_unseeded_hand_offs(reader)?)
            })
            .await
    }

    /// Finishes the fresh session of the hand-off whose create ran under `key`, the whole finish in
    /// a task of its own under the key, answering the state it reads after: `active` once
    /// activated, `provisioning` with nothing bound while its project is still cloning, and as it
    /// reads for a session no longer `provisioning`. Binds it in its create's folder, or at the
    /// mount's root once that folder is no longer a live tree of the mount; has the seeding port
    /// write the planning transcript's file and the seed plan while it is still `provisioning`;
    /// then activates it at the hand-off's level in mode `build`. A session whose hand-off ended
    /// is finished as any create, at its driver's starting level. Each failure names its step:
    /// `birth` refusing `session.notFound` for a key that made no session, `bind`, `transcriptFile`
    /// and `seedPlan` for the port, unset as [`SessionCreateError::HandOffSeeding`], and
    /// `activation`. The key's task ending with no answer fails at `bind`, the finish's first
    /// step.
    pub async fn finish_handed_off(
        self: &Arc<Self>,
        key: ClientUuid,
    ) -> Result<SessionState, HandOffStepFailure> {
        let creation = Arc::clone(self);
        let held_key = key.clone();
        self.key_lock
            .run_held(
                key.clone(),
                async move { creation.finish_handed_off_held(&held_key).await },
                move |answer: &Result<SessionState, HandOffStepFailure>| match answer {
                    Ok(_) => tracing::info!(
                        client_idempotency_key = key.as_str(),
                        "a hand-off's finish ended after its caller stopped waiting"
                    ),
                    Err(error) => tracing::error!(
                        client_idempotency_key = key.as_str(),
                        error = error as &(dyn Error + 'static),
                        "a hand-off's finish failed after its caller stopped waiting"
                    ),
                },
            )
            .await
            .map_err(failed_at(PlanHandOffStep::Bind))?
    }

    // The finish `finish_handed_off` describes, run while its key is held.
    async fn finish_handed_off_held(
        &self,
        key: &ClientUuid,
    ) -> Result<SessionState, HandOffStepFailure> {
        let Some(recorded) = self
            .read_recorded(key.clone())
            .await
            .map_err(failed_at(PlanHandOffStep::Birth))?
        else {
            return Err(failed_at(PlanHandOffStep::Birth)(
                hand_off_session_not_found(key),
            ));
        };
        if recorded.state != SessionState::Provisioning {
            return Ok(recorded.state);
        }
        let read_key = key.clone();
        let hand_off = self
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, SessionCreateError>(read_hand_off(reader, &read_key)?)
            })
            .await
            .map_err(failed_at(PlanHandOffStep::Birth))?;
        let session = &recorded.session;
        // Only after the hand-off ended does its row go.
        let Some(hand_off) = hand_off else {
            return self.finish_at_starting_level(session).await;
        };
        if self
            .bind_session(session)
            .await
            .map_err(failed_at(PlanHandOffStep::Bind))?
            .is_none()
        {
            return Ok(SessionState::Provisioning);
        }
        let seeding = self
            .hand_off_seeding()
            .map_err(failed_at(PlanHandOffStep::TranscriptFile))?;
        seeding
            .write_transcript_file(&hand_off)
            .await
            .map_err(SessionCreateError::HandOffSeeding)
            .map_err(failed_at(PlanHandOffStep::TranscriptFile))?;
        seeding
            .write_seed_plan(&hand_off)
            .await
            .map_err(SessionCreateError::HandOffSeeding)
            .map_err(failed_at(PlanHandOffStep::SeedPlan))?;
        self.activate(session, hand_off.permission_level, SessionMode::Build)
            .await
            .map_err(failed_at(PlanHandOffStep::Activation))
    }

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
        return Err(hand_off_session_not_found(key).into());
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

// `session.notFound` for the fresh session a hand-off's key names, which it does not hold.
fn hand_off_session_not_found(key: &ClientUuid) -> DomainError {
    DomainError::session_not_found(
        "This daemon holds no such session.",
        json!({ "sessionId": key }),
    )
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
