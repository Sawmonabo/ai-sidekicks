//! The envelope build and single append every daemon-authored session event shares. Each producer
//! builds its own payload and passes it here; this module owns the envelope's members.
//!
//! - One append per call: no retry, no fan-out.
//! - No sequence: the append path mints it inside the write.
//! - The append receipt is returned as is.

use std::sync::Arc;

use jiff::Timestamp;
use serde::Serialize;
use serde_json::{Map, Value};
use sidekicks_contracts::event::envelope::{EventEnvelopeType, EventOccurredAt};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::version::{EVENT_FIELD_MAX_LEN, EventEnvelopeVersion};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::statement::WriteStatement;
use crate::events::canonicalizer::{OccurredAtNormalizationRefusal, normalize_occurred_at};
use crate::events::log_service::{
    EventAppendError, EventLogAppendOptions, EventLogAppendReceipt, EventLogService,
    UnsequencedEventEnvelope,
};
use crate::uuid_v7::mint_uuid_v7;

/// A payload the appender stores: it names the session it belongs to and who acted, so the
/// envelope reads both from it and the two cannot disagree.
pub(crate) trait AppendedPayload: Serialize {
    /// The session the event belongs to.
    fn session_id(&self) -> &SessionId;

    /// The person's or agent's id that acted; `None` when the daemon itself did.
    fn actor(&self) -> Option<&FreeFormText<EVENT_FIELD_MAX_LEN>>;
}

/// An event built to go in another event's write, just before it: its type, and its payload with
/// the session and actor read from it.
#[derive(Clone, Debug)]
pub(crate) struct SessionEventDraft {
    event_type: SessionEventType,
    session_id: SessionId,
    actor: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    payload: Map<String, Value>,
}

impl SessionEventDraft {
    /// The draft of a `event_type` event carrying `payload`. Fails when the payload does not
    /// serialize to a JSON object.
    pub(crate) fn new(
        event_type: SessionEventType,
        payload: &impl AppendedPayload,
    ) -> Result<Self, serde_json::Error> {
        Ok(Self {
            event_type,
            session_id: payload.session_id().clone(),
            actor: payload.actor().cloned(),
            payload: payload_members(payload)?,
        })
    }
}

/// The envelope linkage and the atomic table write one append carries.
#[derive(Debug, Default)]
pub(crate) struct SessionEventLinkage {
    /// The instant the event records, for a producer whose rows in the same write carry it too;
    /// the clock's when `None`.
    pub(crate) occurred_at: Option<WireInstant>,
    /// The id that ties this event to others of one operation.
    pub(crate) correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The id of what caused this event.
    pub(crate) causation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// Statements committed in the same write just before the rows; see
    /// [`EventLogAppendOptions::transactional_prelude`].
    pub(crate) transactional_prelude: Vec<WriteStatement>,
    /// A body-bearing event's prose, kept beside its payload.
    pub(crate) content_body: Option<String>,
    /// Events committed in the same write, in order, just before this one.
    pub(crate) preceding_events: Vec<SessionEventDraft>,
    /// Whether someone waits on the write, so its batch goes to the database at once.
    pub(crate) is_waited_on: bool,
}

/// Why an append through the appender was not kept; none of its events is stored.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionEventAppendError {
    /// The linkage's `occurredAt` cannot take the stored form, one finer than a millisecond among
    /// them.
    #[error("the event's occurredAt cannot be stored")]
    OccurredAt(#[from] OccurredAtNormalizationRefusal),
    /// The payload does not serialize to a JSON object.
    #[error("the event's payload is not a JSON object")]
    Payload(#[from] serde_json::Error),
    /// The event log refused or did not keep the append.
    #[error(transparent)]
    Append(#[from] EventAppendError),
}

/// Builds one session event envelope from a built payload and appends it to the event log.
pub(crate) struct SessionEventAppender {
    event_log: Arc<EventLogService>,
    version: EventEnvelopeVersion,
}

impl SessionEventAppender {
    /// An appender writing envelopes of `version` to `event_log`.
    pub(crate) fn new(event_log: Arc<EventLogService>, version: EventEnvelopeVersion) -> Self {
        Self { event_log, version }
    }

    /// Appends an `event_type` event with `payload`, after the linkage's preceding events in the
    /// same write, and returns once it committed. Fails as [`SessionEventAppendError`] says.
    pub(crate) async fn append(
        &self,
        event_type: SessionEventType,
        payload: &impl AppendedPayload,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventAppendError> {
        let draft = SessionEventDraft::new(event_type, payload)?;
        self.append_draft(draft, linkage).await
    }

    /// Appends an `event_type` event on `session_id`'s log with a payload that names no session,
    /// stored as given, with the daemon as its actor. Fails as [`SessionEventAppendError`] says.
    pub(crate) async fn append_to_session(
        &self,
        event_type: SessionEventType,
        session_id: SessionId,
        payload: &impl Serialize,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventAppendError> {
        let draft = SessionEventDraft {
            event_type,
            session_id,
            actor: None,
            payload: payload_members(payload)?,
        };
        self.append_draft(draft, linkage).await
    }

    async fn append_draft(
        &self,
        draft: SessionEventDraft,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventAppendError> {
        let SessionEventLinkage {
            occurred_at,
            correlation_id,
            causation_id,
            transactional_prelude,
            content_body,
            preceding_events,
            is_waited_on,
        } = linkage;
        // Built in write order, so the ids minted for them rise with their sequences.
        let preceding_events = preceding_events
            .into_iter()
            .map(|preceding| self.envelope_of(preceding, read_clock(), None, None))
            .collect();
        let occurred_at = match occurred_at {
            Some(occurred_at) => normalize_occurred_at(occurred_at.as_str())?,
            None => read_clock(),
        };
        let envelope = self.envelope_of(draft, occurred_at, correlation_id, causation_id);
        let options = EventLogAppendOptions {
            content_body,
            transactional_prelude,
            preceding_events,
            is_waited_on,
        };
        Ok(self.event_log.append(envelope, options).await?)
    }

    fn envelope_of(
        &self,
        draft: SessionEventDraft,
        occurred_at: EventOccurredAt,
        correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
        causation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    ) -> UnsequencedEventEnvelope {
        UnsequencedEventEnvelope {
            id: FreeFormText::new(mint_uuid_v7().to_string()).expect("a minted UUID is an id"),
            session_id: draft.session_id,
            occurred_at,
            category: draft.event_type.category(),
            event_type: EventEnvelopeType::from(draft.event_type),
            actor: Some(draft.actor),
            payload: draft.payload,
            correlation_id,
            causation_id,
            version: self.version.clone(),
        }
    }
}

/// The clock's instant in the stored form.
fn read_clock() -> EventOccurredAt {
    EventOccurredAt::from_timestamp(Timestamp::now()).expect("the clock reads after year 0000")
}

/// `payload`'s members, as the envelope stores them.
fn payload_members(payload: &impl Serialize) -> Result<Map<String, Value>, serde_json::Error> {
    serde_json::from_value(serde_json::to_value(payload)?)
}
