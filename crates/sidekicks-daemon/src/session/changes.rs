//! The changes made to one session: a person's rename, archive, reactivate, close, pin and mute,
//! and the naming pass's name for a session still unnamed. Each reads the session's facts, decides,
//! and appends its event with a guard that those facts still hold, so a change that raced another
//! is decided again on what landed. A change that finds the session already as it asks appends
//! nothing; a closed session, or one being purged, takes no change.

use std::error::Error;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension as _};
use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::events::{
    SessionLifecycleChangePayload, SessionMarkChangePayload, SessionRenameOrigin,
    SessionRenamedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionRenameRequest, SessionRenameResponse, SessionState,
};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{FreeFormText, TextError, is_ecmascript_whitespace};
use tokio_util::task::TaskTracker;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::stored_column::{closed_word, optional_text_column, text_column};
use crate::events::log_service::EventLogService;
use crate::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::keyed_lock::KeyedLock;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::session_control::CloseSessionParams;
use crate::session::not_found::session_not_found;
use crate::session::run::ids::read_session_run_ids;
use crate::session::run::state_change::refused_statement_index;
use crate::text_cut::cut_to_code_points;

/// The statements the session changes prepare on a read connection: the session's facts, its
/// runs, and the providers their bindings name.
pub(crate) const SESSION_CHANGES_STATEMENT_CAPACITY: usize = 3;

const SELECT_FACTS_SQL: &str =
    "SELECT state, name, pinned_at, muted_at FROM sessions WHERE id = ?1";

// Holds only while every fact the change was decided from is as it was read.
const FACTS_UNCHANGED_SQL: &str = "SELECT 1 FROM sessions
  WHERE id = @sessionId AND state = @state AND name IS @name
    AND pinned_at IS @pinnedAt AND muted_at IS @mutedAt";

// The provider each binding of the runs names, by run, then oldest first; only the name is read,
// so a binding's other columns never stop a close or a name's push.
const PROVIDERS_OF_RUNS_SQL: &str = "SELECT provider_name FROM runtime_bindings
  WHERE run_id IN (SELECT value FROM json_each(?1)) ORDER BY run_id, created_at, id";

// The guard is the first statement of each change's write.
const FACTS_GUARD_INDEX: usize = 0;

/// Why a session change was refused or not kept; a refused change keeps nothing.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionChangeError {
    /// The session is unknown (`session.notFound`), closed (`session.alreadyClosed`), or in a
    /// state that takes no such change (`session.changeRefused`); or a close found a run on a
    /// provider no registered driver answers (`provider.notFound`) and ended nothing.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused a read of the session, or a stored fact did not read.
    #[error("reading the session failed")]
    Read(#[from] rusqlite::Error),
    /// No read connection could be had.
    #[error("reading the session failed")]
    ReadPool(#[from] DatabaseReadError),
    /// A name for the naming pass that no session can hold: it holds a NUL.
    #[error("the session name cannot be stored")]
    Name(#[source] TextError),
    /// The change's event broke a check of its type.
    #[error("the session change's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the change.
    #[error("the session change was not appended")]
    Append(#[from] SessionEventAppendError),
    /// A driver did not end the session's provider leg; the session is not closed.
    #[error("a provider driver did not close the session")]
    Driver(#[from] DriverError),
}

impl From<SessionChangeError> for HandlerError {
    /// A refusal answers by its code and a driver's error as the driver's mapping says; a failed
    /// read or append is a fault in the daemon.
    fn from(error: SessionChangeError) -> Self {
        match error {
            SessionChangeError::Refused(refusal) => Self::Refused(refusal),
            SessionChangeError::Driver(driver) => driver.into(),
            fault @ (SessionChangeError::Read(_)
            | SessionChangeError::ReadPool(_)
            | SessionChangeError::Name(_)
            | SessionChangeError::Draft(_)
            | SessionChangeError::Append(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The facts of a session's row a change decides from, and its guard holds to.
#[derive(Debug)]
struct SessionFacts {
    state: SessionState,
    name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    pinned_at: Option<String>,
    muted_at: Option<String>,
}

/// A mark a session is set or cleared on.
#[derive(Clone, Copy, Debug)]
enum SessionMark {
    Pin,
    Mute,
}

/// Renames, archives, reactivates, closes, pins and mutes sessions, reading through the daemon's
/// read pool and appending through the event log.
pub(crate) struct SessionChanges {
    /// Where the session's facts and the providers of its runs are read.
    pool: Arc<DatabaseReadPool>,
    /// The append path each change's event goes through.
    appender: SessionEventAppender,
    /// The live drivers a close ends the session's legs through and a new name is told to.
    providers: Arc<ProviderRegistry>,
    /// The session-wide transition lock; see [`SessionChanges::transition_lock`].
    lock: Arc<KeyedLock<SessionId>>,
    /// Orders the pushes of one session's name, apart from the transition lock so no archive or
    /// close waits on a provider; each push reads the name under it, so the last carries the
    /// newest.
    name_push_lock: Arc<KeyedLock<SessionId>>,
    /// Every push of a person's new name to the session's providers, so the stop waits for each.
    name_pushes: TaskTracker,
}

impl SessionChanges {
    /// The changes reading through `pool`, appending through `event_log` and reaching the
    /// session's providers through the drivers `providers` registered.
    pub(crate) fn new(
        pool: Arc<DatabaseReadPool>,
        event_log: Arc<EventLogService>,
        providers: Arc<ProviderRegistry>,
    ) -> Self {
        Self {
            pool,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
            providers,
            lock: Arc::new(KeyedLock::new()),
            name_push_lock: Arc::new(KeyedLock::new()),
            name_pushes: TaskTracker::new(),
        }
    }

    /// Settles once every push of a new name to the providers under way has ended; a rename after
    /// it pushes nothing the stop waits for.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's stop waits for the session name pushes"
        )
    )]
    pub(crate) async fn stop(&self) {
        self.name_pushes.close();
        self.name_pushes.wait().await;
    }

    /// The lock every session-wide transition holds for its whole run, keyed by session id:
    /// archive, reactivate and close take it, and the queue's opening of a provider session, its
    /// run bindings and level moves, the person's restart, the session conversion and the purge
    /// take the same one through this, so no two of them interleave on one session.
    pub(crate) fn transition_lock(&self) -> &Arc<KeyedLock<SessionId>> {
        &self.lock
    }

    /// The lock each push of a session's name takes, so a test can hold the pushes back.
    #[cfg(test)]
    pub(crate) fn name_push_lock(&self) -> &Arc<KeyedLock<SessionId>> {
        &self.name_push_lock
    }

    /// The person's rename: `None` clears the name, which the session's self-naming then names
    /// again and tells its providers, and a rename to the name the session holds appends nothing.
    /// It answers once the name is written; the session's name as it then reads is told to each
    /// provider that ran the session on a task of its own, a failed telling logged once and never
    /// failing the rename. Refused as [`SessionChangeError::Refused`] says; fails with the read or
    /// append that failed.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session rename handler answers a person's rename through it"
        )
    )]
    pub(crate) async fn rename(
        &self,
        request: SessionRenameRequest,
    ) -> Result<SessionRenameResponse, SessionChangeError> {
        let SessionRenameRequest { session_id, name } = request;
        let is_written = self
            .change(session_id, None, |facts| {
                refuse_unchangeable_session(&session_id, facts.state)?;
                Ok((facts.name != name).then(|| {
                    renamed_event(
                        session_id,
                        name.clone(),
                        facts.name.clone(),
                        SessionRenameOrigin::User,
                    )
                }))
            })
            .await?;
        // The person's answer waits on no provider: the name is pushed on a task of its own. A
        // cleared name is pushed by the naming pass that names the session again.
        if is_written && name.is_some() {
            let pool = Arc::clone(&self.pool);
            let providers = Arc::clone(&self.providers);
            let name_push_lock = Arc::clone(&self.name_push_lock);
            self.name_pushes.spawn(async move {
                push_current_name(&pool, &providers, &name_push_lock, session_id).await;
            });
        }
        Ok(SessionRenameResponse { session_id, name })
    }

    /// Names the session only while it is unnamed and takes changes, deciding that inside the
    /// write, so a name written in the meantime always wins; the name is trimmed of whitespace and
    /// cut to the name bound, and one left empty writes nothing. Returns whether it named the
    /// session, once each provider that ran the session was told the session's name as it then
    /// reads, a failed telling logged. Fails with [`SessionChangeError::Name`] for a name holding
    /// a NUL, else as `rename` does but never refused for the session's state.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the naming pass after a session's first exchange names it through it"
        )
    )]
    pub(crate) async fn name_unnamed(
        &self,
        session_id: SessionId,
        name: &str,
    ) -> Result<bool, SessionChangeError> {
        let trimmed = name.trim_matches(is_ecmascript_whitespace);
        let cut = cut_to_code_points(trimmed, SESSION_NAME_MAX_LEN)
            .trim_end_matches(is_ecmascript_whitespace);
        let name = match FreeFormText::<SESSION_NAME_MAX_LEN>::new(cut.to_owned()) {
            Ok(name) => name,
            Err(TextError::Blank) => return Ok(false),
            Err(error @ (TextError::HoldsNul | TextError::OverCap { .. })) => {
                return Err(SessionChangeError::Name(error));
            }
        };
        let is_written = self
            .change(session_id, None, |facts| {
                Ok(
                    (!is_unchangeable(facts.state) && facts.name.is_none()).then(|| {
                        renamed_event(
                            session_id,
                            Some(name.clone()),
                            None,
                            SessionRenameOrigin::Auto,
                        )
                    }),
                )
            })
            .await?;
        if is_written {
            push_current_name(
                &self.pool,
                &self.providers,
                &self.name_push_lock,
                session_id,
            )
            .await;
        }
        Ok(is_written)
    }

    /// Moves an active session into the archived ones, leaving its provider process as it was.
    /// Refuses a session still `provisioning` with `session.changeRefused`, else as
    /// [`SessionChangeError::Refused`] says.
    #[expect(
        dead_code,
        reason = "the session archive handler answers a person's archive through it"
    )]
    pub(crate) async fn archive(&self, session_id: SessionId) -> Result<(), SessionChangeError> {
        self.archive_in_state(session_id, false).await
    }

    /// Archives a session of a project being forgotten: an active one as
    /// [`SessionChanges::archive`] does, and one still `provisioning`, whose bind can never come
    /// now. Refuses a closed or purging session as [`SessionChangeError::Refused`] says.
    #[expect(
        dead_code,
        reason = "forgetting a project archives each of its sessions through it"
    )]
    pub(crate) async fn archive_of_forgotten_project(
        &self,
        session_id: SessionId,
    ) -> Result<(), SessionChangeError> {
        self.archive_in_state(session_id, true).await
    }

    async fn archive_in_state(
        &self,
        session_id: SessionId,
        is_provisioning_archived: bool,
    ) -> Result<(), SessionChangeError> {
        let _hold = self.lock.acquire(session_id).await;
        self.change(session_id, None, |facts| {
            refuse_unchangeable_session(&session_id, facts.state)?;
            if !is_provisioning_archived {
                refuse_provisioning_session(&session_id, facts.state)?;
            }
            Ok((facts.state != SessionState::Archived).then(|| {
                lifecycle_event(
                    SessionEvent::SessionArchived,
                    session_id,
                    facts.state,
                    SessionState::Archived,
                )
            }))
        })
        .await?;
        Ok(())
    }

    /// Returns an archived session to the live list; any other session it leaves as it is.
    /// Refused as [`SessionChangeError::Refused`] says.
    #[expect(
        dead_code,
        reason = "the session reactivate handler answers a person's reactivate through it"
    )]
    pub(crate) async fn reactivate(&self, session_id: SessionId) -> Result<(), SessionChangeError> {
        let _hold = self.lock.acquire(session_id).await;
        self.change(session_id, None, |facts| {
            refuse_unchangeable_session(&session_id, facts.state)?;
            Ok((facts.state == SessionState::Archived).then(|| {
                lifecycle_event(
                    SessionEvent::SessionReactivated,
                    session_id,
                    SessionState::Archived,
                    SessionState::Active,
                )
            }))
        })
        .await?;
        Ok(())
    }

    /// Closes the session: ends its provider leg through each driver that ran one of its runs,
    /// then appends `session.closed`, holding the transition lock across both, so no opening or
    /// restart brings a process up in between; the session stays readable. Closing a closed
    /// session does nothing. Refuses one still `provisioning` or being purged with
    /// `session.changeRefused`, and one with a run on a provider no registered driver answers with
    /// `provider.notFound` before any leg is ended, so it never reads closed while that provider
    /// may still run it. Fails with [`SessionChangeError::Driver`] when a driver did not end its
    /// leg.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session close handler answers a person's close through it"
        )
    )]
    pub(crate) async fn close(&self, session_id: SessionId) -> Result<(), SessionChangeError> {
        let _hold = self.lock.acquire(session_id).await;
        let facts = self.read_facts(session_id).await?;
        if facts.state == SessionState::Closed {
            return Ok(());
        }
        refuse_unchangeable_session(&session_id, facts.state)?;
        refuse_provisioning_session(&session_id, facts.state)?;
        // The legs end first, so a session never reads closed while its provider still runs it.
        let drivers = session_providers(&self.pool, session_id)
            .await?
            .iter()
            .map(|provider| self.providers.lookup(provider))
            .collect::<Result<Vec<_>, DomainError>>()?;
        for driver in drivers {
            driver
                .close_session(CloseSessionParams { session_id })
                .await?;
        }
        self.change(session_id, None, |current| {
            if current.state == SessionState::Closed {
                return Ok(None);
            }
            // A purge may mark the session while its legs end.
            refuse_unchangeable_session(&session_id, current.state)?;
            Ok(Some(lifecycle_event(
                SessionEvent::SessionClosed,
                session_id,
                current.state,
                SessionState::Closed,
            )))
        })
        .await?;
        Ok(())
    }

    /// Pins the session to the top of its group; a pinned session keeps its first pin time.
    /// Refused as [`SessionChangeError::Refused`] says.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session pin handler answers a person's pin through it"
        )
    )]
    pub(crate) async fn pin(&self, session_id: SessionId) -> Result<(), SessionChangeError> {
        self.set_mark(session_id, SessionMark::Pin, true).await
    }

    /// Unpins the session. Refused as [`SessionChangeError::Refused`] says.
    #[expect(
        dead_code,
        reason = "the session unpin handler answers a person's unpin through it"
    )]
    pub(crate) async fn unpin(&self, session_id: SessionId) -> Result<(), SessionChangeError> {
        self.set_mark(session_id, SessionMark::Pin, false).await
    }

    /// Mutes the session's notifications. Refused as [`SessionChangeError::Refused`] says.
    #[expect(
        dead_code,
        reason = "the session mute handler answers a person's mute through it"
    )]
    pub(crate) async fn mute(&self, session_id: SessionId) -> Result<(), SessionChangeError> {
        self.set_mark(session_id, SessionMark::Mute, true).await
    }

    /// Unmutes the session's notifications. Refused as [`SessionChangeError::Refused`] says.
    #[expect(
        dead_code,
        reason = "the session unmute handler answers a person's unmute through it"
    )]
    pub(crate) async fn unmute(&self, session_id: SessionId) -> Result<(), SessionChangeError> {
        self.set_mark(session_id, SessionMark::Mute, false).await
    }

    async fn set_mark(
        &self,
        session_id: SessionId,
        mark: SessionMark,
        is_set: bool,
    ) -> Result<(), SessionChangeError> {
        // One instant for the payload and the envelope, so the row and its event agree.
        let at = WireInstant::now();
        self.change(session_id, Some(at.clone()), |facts| {
            refuse_unchangeable_session(&session_id, facts.state)?;
            let marked_at = match mark {
                SessionMark::Pin => &facts.pinned_at,
                SessionMark::Mute => &facts.muted_at,
            };
            if marked_at.is_some() == is_set {
                return Ok(None);
            }
            let payload = SessionMarkChangePayload {
                session_id,
                at: at.clone(),
            };
            Ok(Some(match (mark, is_set) {
                (SessionMark::Pin, true) => SessionEvent::SessionPinned(payload),
                (SessionMark::Pin, false) => SessionEvent::SessionUnpinned(payload),
                (SessionMark::Mute, true) => SessionEvent::SessionMuted(payload),
                (SessionMark::Mute, false) => SessionEvent::SessionUnmuted(payload),
            }))
        })
        .await?;
        Ok(())
    }

    // Decides on the session's facts and appends what was decided, guarded on those facts. A
    // refused guard means another change landed first, so the change is decided again on what
    // landed. Returns whether an event was appended.
    async fn change(
        &self,
        session_id: SessionId,
        occurred_at: Option<WireInstant>,
        decide: impl Fn(&SessionFacts) -> Result<Option<SessionEvent>, SessionChangeError>,
    ) -> Result<bool, SessionChangeError> {
        loop {
            let facts = self.read_facts(session_id).await?;
            let Some(event) = decide(&facts)? else {
                return Ok(false);
            };
            let draft = SessionEventDraft::of_session(session_id, &event)?;
            let linkage = SessionEventLinkage {
                occurred_at: occurred_at.clone(),
                transactional_prelude: vec![facts_unchanged_statement(&session_id, &facts)],
                ..SessionEventLinkage::default()
            };
            match self.appender.append(draft, linkage).await {
                Ok(_receipt) => return Ok(true),
                Err(error) if refused_statement_index(&error) == Some(FACTS_GUARD_INDEX) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }

    async fn read_facts(&self, session_id: SessionId) -> Result<SessionFacts, SessionChangeError> {
        read_session_facts(&self.pool, session_id).await
    }
}

// The session's facts as they read now; refused `session.notFound` for an unknown session.
async fn read_session_facts(
    pool: &DatabaseReadPool,
    session_id: SessionId,
) -> Result<SessionFacts, SessionChangeError> {
    pool.read(
        ReadLength::Short,
        move |reader| -> Result<_, SessionChangeError> {
            reader
                .prepare_cached(SELECT_FACTS_SQL)?
                .query_row([session_id.text().as_str()], |row| {
                    Ok(SessionFacts {
                        state: text_column(row, 0, closed_word)?,
                        name: optional_text_column(row, 1, FreeFormText::new)?,
                        pinned_at: row.get(2)?,
                        muted_at: row.get(3)?,
                    })
                })
                .optional()?
                .ok_or_else(|| session_not_found(&session_id).into())
        },
    )
    .await
}

// The providers that ran one of the session's runs, each once, in the order first met.
async fn session_providers(
    pool: &DatabaseReadPool,
    session_id: SessionId,
) -> Result<Vec<ProviderId>, SessionChangeError> {
    pool.read(ReadLength::Long, move |reader| {
        Ok::<_, SessionChangeError>(read_session_providers(reader, &session_id)?)
    })
    .await
}

// Pushes the session's name as it reads under the session's push lock to each provider that ran
// it, so pushes run one at a time and the last carries the newest name; a session with no name
// pushes nothing, since no provider takes an empty one and the naming pass pushes the next.
async fn push_current_name(
    pool: &DatabaseReadPool,
    providers: &ProviderRegistry,
    name_push_lock: &KeyedLock<SessionId>,
    session_id: SessionId,
) {
    let _hold = name_push_lock.acquire(session_id).await;
    let name = match read_session_facts(pool, session_id).await {
        Ok(SessionFacts {
            name: Some(name), ..
        }) => name,
        Ok(SessionFacts { name: None, .. }) => return,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                session_id = session_id.text().as_str(),
                "the session's name was told to no provider: the session did not read"
            );
            return;
        }
    };
    tell_providers_name(pool, providers, session_id, &name).await;
}

// Tells each provider that ran the session its new name. The name is already written, so a
// provider that did not take it is logged and the rest are still told.
async fn tell_providers_name(
    pool: &DatabaseReadPool,
    providers: &ProviderRegistry,
    session_id: SessionId,
    name: &FreeFormText<SESSION_NAME_MAX_LEN>,
) {
    let session_providers = match session_providers(pool, session_id).await {
        Ok(session_providers) => session_providers,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                session_id = session_id.text().as_str(),
                "the session's new name was told to no provider: its providers did not read"
            );
            return;
        }
    };
    for provider in session_providers {
        let told = match providers.lookup(&provider) {
            Ok(driver) => {
                driver
                    .tell_session_name(session_id, name.as_str().to_owned())
                    .await
            }
            Err(refusal) => Err(DriverError::Refused(refusal)),
        };
        if let Err(error) = told {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                session_id = session_id.text().as_str(),
                provider = provider.as_str(),
                "a provider was not told the session's new name"
            );
        }
    }
}

/// Refuses a change to a session that takes none: a closed one with `session.alreadyClosed`, and
/// one being purged with `session.changeRefused`.
pub(crate) fn refuse_unchangeable_session(
    session_id: &SessionId,
    state: SessionState,
) -> Result<(), DomainError> {
    match state {
        SessionState::Closed => Err(DomainError::new(
            "The session is closed and cannot be changed.",
            RefusalCode::SessionAlreadyClosed,
        )
        .with_detail(json!({ "sessionId": session_id }))),
        SessionState::PurgeRequested => Err(change_refused(session_id, state)),
        SessionState::Provisioning | SessionState::Active | SessionState::Archived => Ok(()),
    }
}

/// Refuses, with `session.changeRefused`, a session still `provisioning`: only an active or
/// archived session is archived, closed or converted, and a provisioning one is finished by its
/// create instead.
pub(crate) fn refuse_provisioning_session(
    session_id: &SessionId,
    state: SessionState,
) -> Result<(), DomainError> {
    match state {
        SessionState::Provisioning => Err(change_refused(session_id, state)),
        SessionState::Active
        | SessionState::Archived
        | SessionState::Closed
        | SessionState::PurgeRequested => Ok(()),
    }
}

fn is_unchangeable(state: SessionState) -> bool {
    match state {
        SessionState::Closed | SessionState::PurgeRequested => true,
        SessionState::Provisioning | SessionState::Active | SessionState::Archived => false,
    }
}

fn change_refused(session_id: &SessionId, state: SessionState) -> DomainError {
    DomainError::new(
        "The session's state does not take that change.",
        RefusalCode::SessionChangeRefused,
    )
    .with_detail(json!({ "sessionId": session_id, "state": state }))
}

fn lifecycle_event(
    into_event: fn(SessionLifecycleChangePayload) -> SessionEvent,
    session_id: SessionId,
    previous_state: SessionState,
    new_state: SessionState,
) -> SessionEvent {
    into_event(SessionLifecycleChangePayload {
        session_id,
        previous_state: Some(previous_state),
        new_state,
        actor: None,
    })
}

fn renamed_event(
    session_id: SessionId,
    name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    previous_name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    origin: SessionRenameOrigin,
) -> SessionEvent {
    SessionEvent::SessionRenamed(SessionRenamedPayload {
        session_id,
        name,
        previous_name,
        origin,
        actor: None,
    })
}

fn facts_unchanged_statement(session_id: &SessionId, facts: &SessionFacts) -> WriteStatement {
    WriteStatement {
        sql: FACTS_UNCHANGED_SQL.into(),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@state", <&'static str>::from(facts.state)),
            nullable_text_binding("@name", facts.name.as_ref().map(FreeFormText::as_str)),
            nullable_text_binding("@pinnedAt", facts.pinned_at.as_deref()),
            nullable_text_binding("@mutedAt", facts.muted_at.as_deref()),
        ]),
        expected_row_count: Some(1),
    }
}

// The providers of the session's runs' bindings, superseded bindings included, in one read
// snapshot, each once in the order first met.
fn read_session_providers(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Vec<ProviderId>> {
    let snapshot = reader.unchecked_transaction()?;
    let run_ids = read_session_run_ids(&snapshot, session_id)?;
    let run_ids_json = serde_json::Value::from(
        run_ids
            .iter()
            .map(|run_id| run_id.text().as_str().to_owned())
            .collect::<Vec<_>>(),
    )
    .to_string();
    let mut statement = snapshot.prepare_cached(PROVIDERS_OF_RUNS_SQL)?;
    let mut providers: Vec<ProviderId> = Vec::new();
    for provider in statement.query_map([run_ids_json], |row| {
        text_column(row, 0, closed_word::<ProviderId>)
    })? {
        let provider = provider?;
        if !providers.contains(&provider) {
            providers.push(provider);
        }
    }
    Ok(providers)
}

#[cfg(test)]
mod tests;
