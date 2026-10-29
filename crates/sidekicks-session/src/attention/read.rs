//! The attention projection as `attention.subscribe` serves it: the stored entries, narrowed as the
//! request asks, each with its name, state word, delivery and seen fact composed when it is read,
//! and a named session's aggregate, derived from the session's open waits and unseen informational
//! entries and never stored. Nothing here reads an event's payload, so no entry carries a word of
//! what was said in a session; a Notify step's own notice is the one stored text served.
//!
//! An entry is seen when its source event's sequence is at or under its subject's seen mark: the
//! session's for an agent run's or a plan's entry, the workflow run's for a workflow's.

use std::borrow::Borrow;
use std::collections::HashMap;

use jiff::Timestamp;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension as _, Row, named_params};
use sidekicks_contracts::attention::{
    AttentionBannerState, AttentionId, AttentionItem, AttentionMomentItem, AttentionMomentTrigger,
    AttentionNotifyItem, AttentionProjection, AttentionSeverity, AttentionSubscribeRequest,
    AttentionSubscribeScope, AttentionTrigger, AttentionWebAddressState, InformationalSeverity,
    WorkflowNotifyTrigger,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};

use crate::attention::aggregate::{AttentionContributor, derive_session_aggregate};
use crate::attention::moment::AttentionMoment;

/// The statements the projection read prepares: a session's name, the entries and a workflow
/// run's name.
pub const ATTENTION_STATEMENT_CAPACITY: usize = 3;

/// An untitled chat's name, as the sessions list draws it.
const UNTITLED_CHAT: &str = "New chat";
/// An untitled project session's name, as the sessions list draws it.
const UNTITLED_PROJECT: &str = "New session";

const WAITING_WORD: &str = "Waiting on you";
const FINISHED_WORD: &str = "Finished";
const FAILED_WORD: &str = "Failed";

// A session's name, its first message's opening and its shape: the three its untitled name reads.
const SESSION_NAME_SQL: &str =
    "SELECT name, first_message_preview, shape FROM sessions WHERE id = @session_id";

// Every entry the request narrows to, newest first, with its delivery, its seen fact and its
// session's name. A NULL `@session_id` or `@run_id` narrows nothing; a run is an agent run or a
// workflow run.
const ENTRIES_SQL: &str = "SELECT entry.id, entry.moment_id, entry.session_id, entry.run_id,
    entry.workflow_run_id, entry.node_id, entry.trigger, entry.severity, entry.notice_text,
    entry.source_event_id, entry.created_at, entry.resolved_at, delivery.banner_state,
    delivery.web_address_state, delivery.web_address_attempt_count,
    COALESCE(seen.seen_through_sequence >= source.sequence, 0),
    session_row.name, session_row.first_message_preview, session_row.shape
  FROM attention_entries AS entry
  JOIN session_events AS source ON source.id = entry.source_event_id
  JOIN sessions AS session_row ON session_row.id = entry.session_id
  LEFT JOIN attention_deliveries AS delivery ON delivery.entry_id = entry.id
  LEFT JOIN attention_seen AS seen
    ON seen.session_id = entry.session_id AND seen.run_id = COALESCE(entry.workflow_run_id, '')
  WHERE (@session_id IS NULL OR entry.session_id = @session_id)
    AND (@run_id IS NULL OR entry.run_id = @run_id OR entry.workflow_run_id = @run_id)
  ORDER BY entry.created_at DESC, entry.id DESC";

// A workflow run's name, its pinned version's.
const WORKFLOW_NAME_SQL: &str = "SELECT json_extract(version.definition_body, '$.name')
  FROM workflow_runs AS run
  JOIN workflow_versions AS version ON version.id = run.workflow_version_id
  WHERE run.id = @workflow_run_id";

/// Why the attention projection could not be read.
#[derive(Debug, thiserror::Error)]
pub enum AttentionReadError {
    /// The named session is not one this daemon holds (`session.notFound`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused the read, or a stored value does not read as its column's.
    #[error("a read of the attention entries failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// A stored Notify entry lacks a member every Notify entry is written with.
    #[error("the stored Notify entry {entry_id} has no {member}")]
    IncompleteNotifyEntry {
        /// The entry.
        entry_id: String,
        /// The member it lacks.
        member: &'static str,
    },
    /// A workflow run an entry names has no row, or its pinned version no name.
    #[error("the workflow run {workflow_run_id} has no name to read")]
    UnnamedWorkflowRun {
        /// The run.
        workflow_run_id: String,
    },
}

impl From<AttentionReadError> for HandlerError {
    /// A session the daemon does not hold answers by its code; a failed read is a fault in the
    /// daemon.
    fn from(error: AttentionReadError) -> Self {
        match error {
            AttentionReadError::Refused(refusal) => Self::Refused(refusal),
            fault @ (AttentionReadError::Database(_)
            | AttentionReadError::Pool(_)
            | AttentionReadError::IncompleteNotifyEntry { .. }
            | AttentionReadError::UnnamedWorkflowRun { .. }) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The projection `request` asks for, read on `reader` in one snapshot: with no session, every
/// stored entry; a session alone, its entries and its aggregate; a session's `session` scope, the
/// aggregate alone; its `run` scope, that run's entries. Fails with
/// [`AttentionReadError::Refused`] (`session.notFound`) for a named session this daemon holds
/// no row for.
pub fn read_attention_projection(
    reader: &Connection,
    request: &AttentionSubscribeRequest,
) -> Result<AttentionProjection, AttentionReadError> {
    let snapshot = reader.unchecked_transaction()?;
    let session_name = request
        .session_id
        .map(|session_id| {
            read_session_name(&snapshot, &session_id)?
                .map(|name| (session_id, name))
                .ok_or_else(|| AttentionReadError::from(session_not_found(&session_id)))
        })
        .transpose()?;
    // The request's checks hold a run id exactly to the run scope.
    let entries = read_entries(
        &snapshot,
        request.session_id.as_ref(),
        request.run_id.as_ref(),
    )?;
    let mut items = Vec::new();
    if let Some((session_id, name)) = &session_name
        && request.scope != Some(AttentionSubscribeScope::Run)
    {
        items.extend(session_aggregate(*session_id, name, &entries).map(AttentionItem::Moment));
    }
    if request.scope != Some(AttentionSubscribeScope::Session) {
        let mut workflow_names = HashMap::new();
        for entry in entries {
            items.push(item_of(&snapshot, &mut workflow_names, entry)?);
        }
    }
    snapshot.commit()?;
    Ok(AttentionProjection { items })
}

/// The three columns a session's name is composed from.
struct SessionName {
    name: Option<String>,
    first_message_preview: Option<String>,
    shape: SessionShape,
}

impl SessionName {
    /// The columns starting at `first`: the name, the first message's opening and the shape.
    fn of_row(row: &Row<'_>, first: usize) -> rusqlite::Result<Self> {
        Ok(Self {
            name: row.get(first)?,
            first_message_preview: row.get(first + 1)?,
            shape: text_column(row, first + 2, closed_word)?,
        })
    }

    /// The session's name, else its first message's opening, else its shape's untitled word.
    fn display_name(&self) -> NonEmptyText {
        [&self.name, &self.first_message_preview]
            .into_iter()
            .flatten()
            .find_map(|text| NonEmptyText::new(text.clone()))
            .unwrap_or_else(|| {
                let untitled = match self.shape {
                    SessionShape::Chat => UNTITLED_CHAT,
                    SessionShape::Project => UNTITLED_PROJECT,
                };
                NonEmptyText::new(untitled.to_owned()).expect("an untitled word is not empty")
            })
    }
}

/// One stored entry, with its delivery and its seen fact.
struct StoredEntry {
    id: AttentionId,
    moment_id: AttentionId,
    session_id: SessionId,
    run_id: Option<AttentionId>,
    workflow_run_id: Option<AttentionId>,
    node_id: Option<String>,
    trigger: AttentionTrigger,
    severity: AttentionSeverity,
    notice_text: Option<String>,
    source_event_id: AttentionId,
    created_at: WireInstant,
    created_instant: Timestamp,
    resolved_at: Option<WireInstant>,
    banner_state: Option<AttentionBannerState>,
    web_address_state: Option<AttentionWebAddressState>,
    web_address_attempt_count: Option<SafeInt<0>>,
    is_seen: bool,
    session_name: SessionName,
}

impl StoredEntry {
    /// A row of [`ENTRIES_SQL`].
    fn of_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: text_column(row, 0, FreeFormText::new)?,
            moment_id: text_column(row, 1, FreeFormText::new)?,
            session_id: text_column(row, 2, |text| SessionId::new(&text))?,
            run_id: optional_text_column(row, 3, FreeFormText::new)?,
            workflow_run_id: optional_text_column(row, 4, FreeFormText::new)?,
            node_id: row.get(5)?,
            trigger: text_column(row, 6, closed_word)?,
            severity: text_column(row, 7, closed_word)?,
            notice_text: row.get(8)?,
            source_event_id: text_column(row, 9, FreeFormText::new)?,
            created_at: text_column(row, 10, WireInstant::try_from)?,
            created_instant: text_column(row, 10, |text| text.parse::<Timestamp>())?,
            resolved_at: optional_text_column(row, 11, WireInstant::try_from)?,
            banner_state: optional_text_column(row, 12, closed_word)?,
            web_address_state: optional_text_column(row, 13, closed_word)?,
            web_address_attempt_count: match row.get_ref(14)? {
                ValueRef::Null => None,
                ValueRef::Integer(_)
                | ValueRef::Real(_)
                | ValueRef::Text(_)
                | ValueRef::Blob(_) => Some(safe_int_column(row, 14)?),
            },
            is_seen: row.get(15)?,
            session_name: SessionName::of_row(row, 16)?,
        })
    }

    /// The trigger of a run's or a session's own moment, `None` for a Notify step's.
    fn moment_trigger(&self) -> Option<AttentionMomentTrigger> {
        match self.trigger {
            AttentionTrigger::PendingApproval => Some(AttentionMomentTrigger::PendingApproval),
            AttentionTrigger::PendingInput => Some(AttentionMomentTrigger::PendingInput),
            AttentionTrigger::RunCompleted => Some(AttentionMomentTrigger::RunCompleted),
            AttentionTrigger::RunFailed => Some(AttentionMomentTrigger::RunFailed),
            AttentionTrigger::WorkflowNotify => None,
        }
    }
}

/// An entry's place among the aggregate's contributors, as the session-level choice reads it.
struct Contributor<'entry> {
    contributor: AttentionContributor,
    entry: &'entry StoredEntry,
}

impl Borrow<AttentionContributor> for Contributor<'_> {
    fn borrow(&self) -> &AttentionContributor {
        &self.contributor
    }
}

fn read_session_name(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<SessionName>> {
    reader
        .prepare_cached(SESSION_NAME_SQL)?
        .query_row(
            named_params! { "@session_id": session_id.text().as_str() },
            |row| SessionName::of_row(row, 0),
        )
        .optional()
}

fn read_entries(
    reader: &Connection,
    session_id: Option<&SessionId>,
    run_id: Option<&AttentionId>,
) -> rusqlite::Result<Vec<StoredEntry>> {
    let session_id = session_id.map(|session_id| session_id.text());
    reader
        .prepare_cached(ENTRIES_SQL)?
        .query_map(
            named_params! {
                "@session_id": session_id.as_ref().map(|text| text.as_str()),
                "@run_id": run_id.map(AttentionId::as_str),
            },
            StoredEntry::of_row,
        )?
        .collect()
}

/// The session's aggregate: its representative's trigger, source event and time, the severity of
/// its open waits and unseen informational entries, no banner state, and `None` when nothing
/// contributes. A Notify step's entry never contributes: it never waits on the person, and the
/// aggregate is a moment of the session's own.
fn session_aggregate(
    session_id: SessionId,
    name: &SessionName,
    entries: &[StoredEntry],
) -> Option<AttentionMomentItem> {
    let contributors: Vec<Contributor<'_>> = entries
        .iter()
        .filter(|entry| {
            entry.session_id == session_id
                && entry.resolved_at.is_none()
                && entry.moment_trigger().is_some()
                && (entry.severity == AttentionSeverity::Actionable || !entry.is_seen)
        })
        .map(|entry| Contributor {
            contributor: AttentionContributor {
                id: entry.id.clone(),
                severity: entry.severity,
                created_at: entry.created_instant,
            },
            entry,
        })
        .collect();
    let (representative, severity) = derive_session_aggregate(&contributors)?;
    let representative = representative.entry;
    let trigger = representative
        .moment_trigger()
        .expect("every contributor is a moment's entry");
    let moment_id = AttentionMoment::Session(session_id).id();
    Some(AttentionMomentItem {
        id: moment_id.clone(),
        moment_id,
        session_id,
        run_id: None,
        trigger,
        severity,
        step_id: None,
        display_name: name.display_name(),
        state_word: moment_word(trigger),
        source_event_id: representative.source_event_id.clone(),
        created_at: representative.created_at.clone(),
        resolved_at: None,
        banner_state: None,
        web_address_state: None,
        web_address_attempt_count: None,
        seen: contributors
            .iter()
            .all(|contributor| contributor.entry.is_seen),
    })
}

/// The wire item of a stored entry, its name read from its workflow run's pinned version for a
/// workflow's entry, through `workflow_names`, and from its session for any other.
fn item_of(
    reader: &Connection,
    workflow_names: &mut HashMap<AttentionId, NonEmptyText>,
    entry: StoredEntry,
) -> Result<AttentionItem, AttentionReadError> {
    let display_name = match &entry.workflow_run_id {
        Some(workflow_run_id) => workflow_name(reader, workflow_names, workflow_run_id)?,
        None => entry.session_name.display_name(),
    };
    let Some(trigger) = entry.moment_trigger() else {
        let incomplete = |member| AttentionReadError::IncompleteNotifyEntry {
            entry_id: entry.id.as_str().to_owned(),
            member,
        };
        let run_id = entry
            .workflow_run_id
            .clone()
            .ok_or_else(|| incomplete("workflow run"))?;
        let step_id = entry
            .node_id
            .clone()
            .and_then(WorkflowNodeId::new)
            .ok_or_else(|| incomplete("node"))?;
        let state_word = entry
            .notice_text
            .clone()
            .and_then(NonEmptyText::new)
            .ok_or_else(|| incomplete("notice"))?;
        return Ok(AttentionItem::Notify(AttentionNotifyItem {
            id: entry.id,
            moment_id: entry.moment_id,
            session_id: entry.session_id,
            run_id,
            trigger: WorkflowNotifyTrigger::Value,
            severity: InformationalSeverity::Value,
            step_id,
            display_name,
            state_word,
            source_event_id: entry.source_event_id,
            created_at: entry.created_at,
            resolved_at: entry.resolved_at,
            banner_state: entry.banner_state,
            web_address_state: entry.web_address_state,
            web_address_attempt_count: entry.web_address_attempt_count,
            seen: entry.is_seen,
        }));
    };
    Ok(AttentionItem::Moment(AttentionMomentItem {
        id: entry.id,
        moment_id: entry.moment_id,
        session_id: entry.session_id,
        run_id: entry.run_id.or(entry.workflow_run_id),
        trigger,
        severity: entry.severity,
        step_id: None,
        display_name,
        state_word: moment_word(trigger),
        source_event_id: entry.source_event_id,
        created_at: entry.created_at,
        resolved_at: entry.resolved_at,
        banner_state: entry.banner_state,
        web_address_state: entry.web_address_state,
        web_address_attempt_count: entry.web_address_attempt_count,
        seen: entry.is_seen,
    }))
}

/// The workflow run's name, read once per projection read.
fn workflow_name(
    reader: &Connection,
    workflow_names: &mut HashMap<AttentionId, NonEmptyText>,
    workflow_run_id: &AttentionId,
) -> Result<NonEmptyText, AttentionReadError> {
    if let Some(name) = workflow_names.get(workflow_run_id) {
        return Ok(name.clone());
    }
    let name = reader
        .prepare_cached(WORKFLOW_NAME_SQL)?
        .query_row(
            named_params! { "@workflow_run_id": workflow_run_id.as_str() },
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .and_then(NonEmptyText::new)
        .ok_or_else(|| AttentionReadError::UnnamedWorkflowRun {
            workflow_run_id: workflow_run_id.as_str().to_owned(),
        })?;
    workflow_names.insert(workflow_run_id.clone(), name.clone());
    Ok(name)
}

/// What follows the name of a run's or a session's moment.
fn moment_word(trigger: AttentionMomentTrigger) -> NonEmptyText {
    let word = match trigger {
        AttentionMomentTrigger::PendingApproval | AttentionMomentTrigger::PendingInput => {
            WAITING_WORD
        }
        AttentionMomentTrigger::RunCompleted => FINISHED_WORD,
        AttentionMomentTrigger::RunFailed => FAILED_WORD,
    };
    NonEmptyText::new(word.to_owned()).expect("a state word is not empty")
}

#[cfg(test)]
mod tests;
