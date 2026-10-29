//! Converting a chat to a project in place. The typed folder is attached as a project, or the
//! project already holding it found, and the conversion recorded under the request's idempotency
//! key; the chat's files are copied into the working tree the folder sits in without replacing
//! anything the repository holds, each outcome recorded as it lands; the session binds to that
//! working tree; and `session.converted` makes it a project. A conversion that stopped part way
//! resumes from its records, and the files not copied are read back page by page. The session
//! keeps its id and transcript, and its managed workspace stays with its history.
//!
//! - A convert holds its key's lock, then the session's transition lock, for its whole run, so a
//!   second session sees the first's conversion under one key and is refused before it attaches.
//! - A failure after the attach answers `session.conversion.incomplete`, naming what was done.

mod copy;
mod skipped_files;
#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::collections::HashSet;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::folders::{RepoMountAttachRequest, RepoMountRootResolutionReason};
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId};
use sidekicks_contracts::repo::workspace::WorkspaceBindRequest;
use sidekicks_contracts::session::convert::{
    SessionConversionIncompleteDetails, SessionConversionRefusedDetails,
    SessionConversionRefusedReason, SessionConvertRequest, SessionConvertResponse,
    SessionConvertedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_platforms::{PathRules, distribution_of};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::schema::session_directory::ConvertedFileOutcome;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_workspace::project::service::{ProjectService, ProjectServiceError};
use sidekicks_workspace::repo::errors::RepoRefusal;
use sidekicks_workspace::repo::mount::service::{RepoMountService, RepoMountServiceError};
use sidekicks_workspace::repo::root_resolver::RepoRootResolver;
use sidekicks_workspace::service::{WorkspaceService, WorkspaceServiceError};

use crate::changes::{SessionChanges, refuse_provisioning_session, refuse_unchangeable_session};
use crate::convert::copy::{ConversionFolders, copy_workspace_files, remove_stopped_copy};
use crate::directory::lookups::ENDED_SESSION_STATES_SQL;
use crate::run::state_change::refused_statement_index;

/// The statements the conversion's reads keep prepared on each read connection: the session's
/// facts, the conversion a key runs under, a session's stopped conversion, every stopped
/// conversion, the files a conversion dealt with, its counts, a page of its skipped files and
/// whether the session exists.
pub const SESSION_CONVERSION_STATEMENT_CAPACITY: usize = 8;

const SELECT_SESSION_FACTS_SQL: &str =
    "SELECT shape, state, place FROM sessions WHERE id = @session_id";

// The conversion this key runs under, of whichever session, with its counts once its
// `session.converted` has landed.
static SELECT_CONVERSION_BY_KEY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT request.session_id,
        json_extract(event.payload, '$.copiedCount'),
        json_extract(event.payload, '$.skippedCount')
   FROM session_convert_requests AS request
   LEFT JOIN session_events AS event
     ON event.session_id = request.session_id AND event.type = '{converted}'
  WHERE request.client_idempotency_key = @key",
        converted = SessionEventType::SessionConverted.as_str(),
    )
});

// A chat's conversion, with the working tree it copies into; only one without its
// `session.converted` is ever read, since a converted session is no chat.
const SELECT_CONVERSION_SQL: &str = "SELECT repo_mount_id, working_tree
   FROM session_convert_requests WHERE session_id = @session_id";

// Every chat's conversion that has not landed its `session.converted`, with its working tree.
static SELECT_STOPPED_CONVERSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT request.session_id, request.working_tree
   FROM session_convert_requests AS request
  WHERE NOT EXISTS (SELECT 1 FROM session_events AS event
                     WHERE event.session_id = request.session_id AND event.type = '{converted}')
  ORDER BY request.session_id",
        converted = SessionEventType::SessionConverted.as_str(),
    )
});

const SELECT_FILES_DEALT_WITH_SQL: &str =
    "SELECT path FROM session_convert_files WHERE session_id = @session_id";

static SELECT_FILE_COUNTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT count(*) FILTER (WHERE outcome = '{copied}'),
        count(*) FILTER (WHERE outcome <> '{copied}')
   FROM session_convert_files WHERE session_id = @session_id",
        copied = <&'static str>::from(ConvertedFileOutcome::Copied),
    )
});

const RECORD_CONVERSION_SQL: &str = "INSERT INTO session_convert_requests
  (client_idempotency_key, session_id, repo_mount_id, working_tree)
  VALUES (@key, @session_id, @repo_mount_id, @working_tree)";

// The request resuming a conversion takes it over: its key answers the conversion from here on, on
// the mount the folder is attached as now.
const TAKE_OVER_CONVERSION_SQL: &str = "UPDATE session_convert_requests
  SET client_idempotency_key = @key, repo_mount_id = @repo_mount_id
  WHERE session_id = @session_id";

// Holds only while the session is still a chat that takes changes, inside the write that makes it
// a project.
static OPEN_CHAT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM sessions
  WHERE id = @session_id AND shape = '{chat}' AND state NOT IN ({ended})",
        chat = <&'static str>::from(SessionShape::Chat),
        ended = ENDED_SESSION_STATES_SQL.as_str(),
    )
});

// The open-chat guard is the first statement of `session.converted`'s write.
const OPEN_CHAT_GUARD_INDEX: usize = 0;

/// What converting a chat reads, locks, attaches, binds and appends through.
pub struct SessionConversionDeps {
    /// The read pool, sized with [`SESSION_CONVERSION_STATEMENT_CAPACITY`].
    pub reads: Arc<DatabaseReadPool>,
    /// The writer the conversion and each file's outcome are recorded through.
    pub writer: Arc<DatabaseWriter>,
    /// The append path `session.converted` goes through.
    pub appender: SessionEventAppender,
    /// The owner of the session-wide transition lock a conversion holds for its whole run.
    pub changes: Arc<SessionChanges>,
    /// Resolves the typed folder, and knows where the chat's managed workspace is.
    pub mounts: Arc<RepoMountService>,
    /// Attaches the typed folder as a project, or finds the project already holding it.
    pub projects: Arc<ProjectService>,
    /// Binds the session to the working tree its files were copied into.
    pub workspaces: Arc<WorkspaceService>,
    /// Reads the working tree the typed folder sits in, as git resolves it.
    pub resolver: Arc<RepoRootResolver>,
}

/// Turns chats into projects in place and reads back the files a conversion did not copy. See the
/// module doc.
pub struct SessionConversion {
    reads: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    appender: SessionEventAppender,
    changes: Arc<SessionChanges>,
    mounts: Arc<RepoMountService>,
    projects: Arc<ProjectService>,
    workspaces: Arc<WorkspaceService>,
    resolver: Arc<RepoRootResolver>,
    // Serializes converts that carry one key across sessions; always taken before the session's
    // transition lock.
    key_lock: KeyedLock<ClientUuid>,
}

/// Why a conversion, a read of its skipped files or the removal of stopped copies failed.
#[derive(Debug, thiserror::Error)]
pub enum SessionConversionError {
    /// A refusal sent with its code before anything was attached: `session.notFound`,
    /// `session.alreadyClosed`, `session.changeRefused`, `session.conversion.refused` or
    /// `repoMount.rootResolutionFailed`.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The typed folder could not be resolved, or the chat's workspace read.
    #[error(transparent)]
    Mount(#[from] RepoMountServiceError),
    /// The typed folder's attach was refused or failed; nothing was attached.
    #[error(transparent)]
    Project(#[from] ProjectServiceError),
    /// The conversion stopped after the repository was attached; the session is still a chat.
    #[error(
        "converting session {} stopped after its repository was attached as mount {}",
        details.session_id,
        details.repo_mount_id
    )]
    Incomplete {
        /// What was done.
        details: Box<SessionConversionIncompleteDetails>,
        /// Why it stopped.
        #[source]
        cause: Box<SessionConversionError>,
    },
    /// The database could not be read.
    #[error("the conversion's rows could not be read")]
    Read(#[from] DatabaseReadError),
    /// A stored row could not be read into its typed facts.
    #[error("a conversion's row could not be read")]
    Row(#[from] rusqlite::Error),
    /// A record of the conversion could not be written.
    #[error("the conversion's record could not be written")]
    Write(#[from] WriteError),
    /// The session could not be bound to the working tree.
    #[error(transparent)]
    Workspace(#[from] WorkspaceServiceError),
    /// `session.converted` broke a check of its type.
    #[error("the session's conversion could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// `session.converted` was not kept.
    #[error("the session's conversion could not be recorded")]
    Append(#[from] SessionEventAppendError),
    /// The session stopped being an open chat while it converted.
    #[error("session {session_id} stopped being an open chat while it converted")]
    NoLongerOpenChat {
        /// The session.
        session_id: SessionId,
    },
    /// A file or folder of the copy could not be read or written.
    #[error("a file of the chat's workspace could not be copied")]
    File(#[source] io::Error),
    /// A copy failed, beside any failure removing what it had written.
    #[error(transparent)]
    Copy(#[from] CleanupFailures<io::Error>),
    /// One or more stopped conversions' copies could not be removed; every other was.
    #[error(transparent)]
    StoppedCopies(#[from] SettleFailures<StoppedCopyFailure>),
}

/// One stopped conversion whose leftover copy could not be removed.
#[derive(Debug, thiserror::Error)]
#[error("the copy session {session_id}'s stopped conversion left could not be removed")]
pub struct StoppedCopyFailure {
    /// The session.
    pub session_id: SessionId,
    /// Why.
    #[source]
    pub failure: Box<SessionConversionError>,
}

impl From<SessionConversionError> for HandlerError {
    /// A refusal answers its code, a folder's refusal as the mounts and the projects answer it,
    /// and a conversion stopped part way `session.conversion.incomplete`; anything else is a fault
    /// in the daemon.
    fn from(error: SessionConversionError) -> Self {
        match error {
            SessionConversionError::Refused(refusal) => Self::Refused(refusal),
            SessionConversionError::Mount(RepoMountServiceError::Refused(refusal)) => {
                Self::Refused(refusal.into())
            }
            SessionConversionError::Project(project) => project.into(),
            SessionConversionError::Incomplete { details, cause } => {
                Self::Refused(conversion_incomplete(&details).with_source(cause))
            }
            fault @ (SessionConversionError::Mount(_)
            | SessionConversionError::Read(_)
            | SessionConversionError::Row(_)
            | SessionConversionError::Write(_)
            | SessionConversionError::Workspace(_)
            | SessionConversionError::Draft(_)
            | SessionConversionError::Append(_)
            | SessionConversionError::NoLongerOpenChat { .. }
            | SessionConversionError::File(_)
            | SessionConversionError::Copy(_)
            | SessionConversionError::StoppedCopies(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// A chat's stored facts a convert decides from.
struct ChatFacts {
    shape: SessionShape,
    state: SessionState,
    place: Option<Place>,
}

/// A chat's recorded conversion.
struct RecordedConversion {
    repo_mount_id: RepoMountId,
    working_tree: PathBuf,
}

/// The conversion a key runs under: its session, and its counts once it landed.
struct KeyedConversion {
    session_id: SessionId,
    counts: Option<SessionConvertResponse>,
}

impl SessionConversion {
    /// The conversion over `deps`.
    pub fn new(deps: SessionConversionDeps) -> Self {
        Self {
            reads: deps.reads,
            writer: deps.writer,
            appender: deps.appender,
            changes: deps.changes,
            mounts: deps.mounts,
            projects: deps.projects,
            workspaces: deps.workspaces,
            resolver: deps.resolver,
            key_lock: KeyedLock::new(),
        }
    }

    /// `session.convert`: converts the chat into the repository at `request.path` and answers what
    /// was and was not copied. A key that already converted this session answers that
    /// conversion's counts and copies nothing; a conversion that stopped part way resumes under
    /// the request's key when the path names the folder it copies into, its counts the whole
    /// conversion's. Refuses, before anything is attached, as [`SessionConversionError::Refused`]
    /// names, and as the attach refuses; a failure after the attach answers
    /// [`SessionConversionError::Incomplete`].
    pub async fn convert(
        &self,
        request: &SessionConvertRequest,
    ) -> Result<SessionConvertResponse, SessionConversionError> {
        let _key_hold = self
            .key_lock
            .acquire(request.client_idempotency_key.clone())
            .await;
        let session_hold = self
            .changes
            .transition_lock()
            .acquire(request.session_id)
            .await;
        self.convert_held(&session_hold, request).await
    }

    async fn convert_held(
        &self,
        session_hold: &KeyHold<'_, SessionId>,
        request: &SessionConvertRequest,
    ) -> Result<SessionConvertResponse, SessionConversionError> {
        let session_id = *session_hold.key();
        if let Some(keyed) = self
            .read_conversion_by_key(request.client_idempotency_key.clone())
            .await?
        {
            if keyed.session_id != session_id {
                return Err(conversion_refused(
                    "This idempotency key belongs to another session's conversion.",
                    refused_for(SessionConversionRefusedReason::IdempotencyKeyReused),
                )
                .into());
            }
            if let Some(counts) = keyed.counts {
                return Ok(counts);
            }
        }
        let facts = self.require_open_chat(session_id).await?;
        let Some(workspace_root) = self.mounts.read_managed_root(session_id).await? else {
            return Err(conversion_refused(
                "The chat has no managed workspace to convert.",
                refused_for(SessionConversionRefusedReason::NoManagedWorkspace),
            )
            .into());
        };
        if !is_in_place(request.path.as_str(), facts.place.as_ref()) {
            return Err(conversion_refused(
                "The chat's project folder must be in the chat's own place.",
                SessionConversionRefusedDetails {
                    place: facts.place,
                    ..refused_for(SessionConversionRefusedReason::FolderInAnotherPlace)
                },
            )
            .into());
        }
        let attach = RepoMountAttachRequest {
            local_path: request.path.clone(),
            place: None,
        };
        let stopped = self.read_conversion(session_id).await?;
        if let Some(stopped) = &stopped {
            // Resolved as the attach resolves it first, so a path that is no repository is refused
            // as the attach refuses it.
            self.mounts.resolve_folder(&attach).await?;
            if self.working_tree_of(&request.path).await? != stopped.working_tree {
                return Err(conversion_refused(
                    "The chat's conversion into another folder stopped part way.",
                    SessionConversionRefusedDetails {
                        repo_mount_id: Some(stopped.repo_mount_id),
                        ..refused_for(SessionConversionRefusedReason::ConversionUnfinished)
                    },
                )
                .into());
            }
        }
        let repo_mount_id = self
            .projects
            .attach_or_find(&attach)
            .await?
            .mount
            .repo_mount_id;
        let mut is_bound = false;
        let converted = self
            .convert_attached(
                request,
                session_id,
                repo_mount_id,
                &workspace_root,
                stopped.is_some(),
                &mut is_bound,
            )
            .await;
        match converted {
            Ok(counts) => Ok(counts),
            Err(cause) => Err(self
                .incomplete(session_id, repo_mount_id, is_bound, cause)
                .await),
        }
    }

    // Everything after the attach: the record, the copy, the bind and `session.converted`.
    async fn convert_attached(
        &self,
        request: &SessionConvertRequest,
        session_id: SessionId,
        repo_mount_id: RepoMountId,
        workspace_root: &Path,
        is_resumed: bool,
        is_bound: &mut bool,
    ) -> Result<SessionConvertResponse, SessionConversionError> {
        // The files go into the working tree of the path typed, and the session binds there, never
        // into another checkout of the repository.
        let working_tree = self.working_tree_of(&request.path).await?;
        let record = conversion_record_statement(
            &request.client_idempotency_key,
            session_id,
            repo_mount_id,
            &working_tree,
            is_resumed,
        );
        self.writer.write(vec![record]).await?;
        let folders = ConversionFolders {
            session_id,
            workspace_root: workspace_root.to_path_buf(),
            working_tree: working_tree.clone(),
        };
        let dealt_with = self.read_files_dealt_with(session_id).await?;
        copy_workspace_files(&folders, &dealt_with, &self.writer).await?;
        self.workspaces
            .bind(&WorkspaceBindRequest {
                session_id,
                repo_mount_id,
                execution_mode: ExecutionMode::BoundRoot,
                directory: Some(
                    FilesystemPath::new(working_tree.to_string_lossy().into_owned())
                        .map_err(|error| SessionConversionError::File(io::Error::other(error)))?,
                ),
            })
            .await?;
        *is_bound = true;
        let counts = self.read_file_counts(session_id).await?;
        self.append_converted(SessionConvertedPayload {
            session_id,
            repo_mount_id,
            copied_count: counts.copied_count,
            skipped_count: counts.skipped_count,
        })
        .await?;
        Ok(counts)
    }

    // `cause` as `session.conversion.incomplete`, with every copy recorded so far counted; a
    // failed count read is answered in its place, the stop's cause logged.
    async fn incomplete(
        &self,
        session_id: SessionId,
        repo_mount_id: RepoMountId,
        is_bound: bool,
        cause: SessionConversionError,
    ) -> SessionConversionError {
        match self.read_file_counts(session_id).await {
            Ok(counts) => SessionConversionError::Incomplete {
                details: Box::new(SessionConversionIncompleteDetails {
                    session_id,
                    repo_mount_id,
                    copied_count: counts.copied_count,
                    skipped_count: counts.skipped_count,
                    is_bound,
                }),
                cause: Box::new(cause),
            },
            Err(count_failure) => {
                tracing::warn!(
                    error = &cause as &(dyn Error + 'static),
                    session_id = session_id.text().as_str(),
                    "a conversion stopped part way, and its counts could not be read"
                );
                count_failure
            }
        }
    }

    /// Removes the copy each conversion the daemon stopped part way was writing, which sits in the
    /// repository under the daemon's own name for it. Run at the daemon's start; each conversion
    /// is held under its session's transition lock meanwhile, and every one is tried. Fails with
    /// every conversion whose copy could not be removed.
    pub async fn remove_stopped_copies(&self) -> Result<(), SessionConversionError> {
        let mut outcomes = Vec::new();
        for (session_id, working_tree) in self.read_stopped_conversions().await? {
            let _session_hold = self.changes.transition_lock().acquire(session_id).await;
            let removed = self.remove_stopped_copy_of(session_id, working_tree).await;
            outcomes.push(removed.map_err(|failure| StoppedCopyFailure {
                session_id,
                failure: Box::new(failure),
            }));
        }
        settle_all(outcomes, "removing the copies stopped conversions left")?;
        Ok(())
    }

    async fn remove_stopped_copy_of(
        &self,
        session_id: SessionId,
        working_tree: PathBuf,
    ) -> Result<(), SessionConversionError> {
        let Some(workspace_root) = self.mounts.read_managed_root(session_id).await? else {
            return Ok(());
        };
        let folders = ConversionFolders {
            session_id,
            workspace_root,
            working_tree,
        };
        let dealt_with = self.read_files_dealt_with(session_id).await?;
        remove_stopped_copy(&folders, &dealt_with).await
    }

    // The session's facts when it is an open chat; refuses `session.notFound`, a closed, purging
    // or provisioning session as the session changes refuse it, and a session that is no chat.
    async fn require_open_chat(
        &self,
        session_id: SessionId,
    ) -> Result<ChatFacts, SessionConversionError> {
        let facts = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_session_facts(connection, session_id)
            })
            .await?;
        let Some(facts) = facts else {
            return Err(session_not_found(&session_id).into());
        };
        refuse_unchangeable_session(&session_id, facts.state)?;
        refuse_provisioning_session(&session_id, facts.state)?;
        if facts.shape != SessionShape::Chat {
            return Err(conversion_refused(
                "Only a chat converts to a project.",
                SessionConversionRefusedDetails {
                    reason: None,
                    repo_mount_id: None,
                    place: None,
                },
            )
            .into());
        }
        Ok(facts)
    }

    // The working tree `folder` sits in; refuses `repoMount.rootResolutionFailed` (`notARepository`)
    // for a folder in none, and as git's read refuses.
    async fn working_tree_of(
        &self,
        folder: &FilesystemPath,
    ) -> Result<PathBuf, SessionConversionError> {
        let working_tree = self
            .resolver
            .read_working_tree_root(Path::new(folder.as_str()))
            .await
            .map_err(DomainError::from)?;
        working_tree.ok_or_else(|| {
            DomainError::from(RepoRefusal::RootResolutionFailed {
                reason: RepoMountRootResolutionReason::NotARepository,
                detail: None,
            })
            .into()
        })
    }

    async fn read_conversion_by_key(
        &self,
        key: ClientUuid,
    ) -> Result<Option<KeyedConversion>, SessionConversionError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_CONVERSION_BY_KEY_SQL)?
                    .query_row(named_params! { "@key": key.as_str() }, |row| {
                        let counts = if row.get_ref(1)?.data_type() == rusqlite::types::Type::Null {
                            None
                        } else {
                            Some(SessionConvertResponse {
                                copied_count: safe_int_column::<0>(row, 1)?,
                                skipped_count: safe_int_column::<0>(row, 2)?,
                            })
                        };
                        Ok(KeyedConversion {
                            session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                            counts,
                        })
                    })
                    .optional()?)
            })
            .await
    }

    async fn read_conversion(
        &self,
        session_id: SessionId,
    ) -> Result<Option<RecordedConversion>, SessionConversionError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_CONVERSION_SQL)?
                    .query_row(
                        named_params! { "@session_id": session_id.text().as_str() },
                        |row| {
                            Ok(RecordedConversion {
                                repo_mount_id: text_column(row, 0, |text| RepoMountId::new(&text))?,
                                working_tree: PathBuf::from(row.get::<_, String>(1)?),
                            })
                        },
                    )
                    .optional()?)
            })
            .await
    }

    async fn read_stopped_conversions(
        &self,
    ) -> Result<Vec<(SessionId, PathBuf)>, SessionConversionError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_STOPPED_CONVERSIONS_SQL)?
                    .query_map([], |row| {
                        Ok((
                            text_column(row, 0, |text| SessionId::new(&text))?,
                            PathBuf::from(row.get::<_, String>(1)?),
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    async fn read_files_dealt_with(
        &self,
        session_id: SessionId,
    ) -> Result<HashSet<String>, SessionConversionError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_FILES_DEALT_WITH_SQL)?
                    .query_map(
                        named_params! { "@session_id": session_id.text().as_str() },
                        |row| row.get::<_, String>(0),
                    )?
                    .collect::<rusqlite::Result<HashSet<_>>>()?)
            })
            .await
    }

    // A count with no GROUP BY answers exactly one row.
    async fn read_file_counts(
        &self,
        session_id: SessionId,
    ) -> Result<SessionConvertResponse, SessionConversionError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_FILE_COUNTS_SQL)?
                    .query_row(
                        named_params! { "@session_id": session_id.text().as_str() },
                        |row| {
                            Ok(SessionConvertResponse {
                                copied_count: safe_int_column::<0>(row, 0)?,
                                skipped_count: safe_int_column::<0>(row, 1)?,
                            })
                        },
                    )?)
            })
            .await
    }

    async fn append_converted(
        &self,
        payload: SessionConvertedPayload,
    ) -> Result<(), SessionConversionError> {
        let session_id = payload.session_id;
        let draft =
            SessionEventDraft::of_session(session_id, &SessionEvent::SessionConverted(payload))?;
        let linkage = SessionEventLinkage {
            transactional_prelude: vec![WriteStatement {
                sql: Cow::Borrowed(OPEN_CHAT_SQL.as_str()),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@session_id",
                    session_id.text().as_str(),
                )]),
                expected_row_count: Some(1),
            }],
            ..SessionEventLinkage::default()
        };
        match self.appender.append(draft, linkage).await {
            Ok(_receipt) => Ok(()),
            Err(error) if refused_statement_index(&error) == Some(OPEN_CHAT_GUARD_INDEX) => {
                Err(SessionConversionError::NoLongerOpenChat { session_id })
            }
            Err(error) => Err(error.into()),
        }
    }
}

fn read_session_facts(
    connection: &Connection,
    session_id: SessionId,
) -> Result<Option<ChatFacts>, SessionConversionError> {
    Ok(connection
        .prepare_cached(SELECT_SESSION_FACTS_SQL)?
        .query_row(
            named_params! { "@session_id": session_id.text().as_str() },
            |row| {
                Ok(ChatFacts {
                    shape: text_column(row, 0, closed_word)?,
                    state: text_column(row, 1, closed_word)?,
                    place: optional_text_column(row, 2, |text| {
                        serde_json::from_str::<Place>(&text)
                    })?,
                })
            },
        )
        .optional()?)
}

// The conversion's record under the request's key: a new one, or, for a conversion that stopped
// part way, its own taken over on the mount its repository is attached as now.
fn conversion_record_statement(
    key: &ClientUuid,
    session_id: SessionId,
    repo_mount_id: RepoMountId,
    working_tree: &Path,
    is_resumed: bool,
) -> WriteStatement {
    let mut bindings = vec![
        text_binding("@key", key.as_str()),
        text_binding("@session_id", session_id.text().as_str()),
        text_binding("@repo_mount_id", repo_mount_id.text().as_str()),
    ];
    if is_resumed {
        return WriteStatement {
            sql: Cow::Borrowed(TAKE_OVER_CONVERSION_SQL),
            bindings: StatementBindings::Named(bindings),
            expected_row_count: Some(1),
        };
    }
    bindings.push(text_binding(
        "@working_tree",
        &working_tree.to_string_lossy(),
    ));
    WriteStatement {
        sql: Cow::Borrowed(RECORD_CONVERSION_SQL),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: Some(1),
    }
}

// Whether `path` is written in `place`'s own form: a chat in Windows reads no distribution's share,
// and a chat in a distribution reads a Linux path. A chat with no place, every chat on macOS and
// Linux, reads any path.
fn is_in_place(path: &str, place: Option<&Place>) -> bool {
    match place {
        None => true,
        Some(Place::Windows(_)) => distribution_of(Path::new(path)).is_none(),
        Some(Place::Wsl(_)) => PathRules::Posix.is_absolute(path),
    }
}

fn refused_for(reason: SessionConversionRefusedReason) -> SessionConversionRefusedDetails {
    SessionConversionRefusedDetails {
        reason: Some(reason),
        repo_mount_id: None,
        place: None,
    }
}

/// `session.conversion.refused` with `details` as its fields; nothing was attached or copied.
fn conversion_refused(message: &str, details: SessionConversionRefusedDetails) -> DomainError {
    DomainError::new(message, RefusalCode::SessionConversionRefused).with_detail(details)
}

/// `session.conversion.incomplete` naming what a conversion did before it stopped.
fn conversion_incomplete(details: &SessionConversionIncompleteDetails) -> DomainError {
    let bound = if details.is_bound {
        "was bound to it but "
    } else {
        ""
    };
    DomainError::new(
        format!(
            "Converting the chat stopped part way: the repository is attached, {} files were \
             copied into it and {} were not, and the session {bound}is still a chat.",
            details.copied_count.get(),
            details.skipped_count.get(),
        ),
        RefusalCode::SessionConversionIncomplete,
    )
    .with_detail(details)
}
