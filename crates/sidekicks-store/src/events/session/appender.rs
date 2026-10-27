//! The envelope build and single append every daemon-authored session event shares. Each producer
//! builds its own typed event and passes it here; this module owns the envelope's members.
//!
//! - Typed: a producer appends a [`SessionEvent`], so its type and its payload cannot disagree.
//!   Its checks run on the typed value, and the payload the envelope stores is serialized from it
//!   once, beside the run it belongs to. An envelope is built only from such an event, so the log
//!   service never takes a type and a payload on their own.
//! - One append per call: no retry, no fan-out.
//! - No sequence: the append path mints it inside the write.
//! - The append receipt is returned as is.

mod payloads;

use std::sync::Arc;

use garde::Validate as _;
use serde::ser::Error as _;
use serde_json::{Map, Value};
use sidekicks_contracts::event::envelope::{EventCategory, EventOccurredAt};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::{EventRun, SessionEvent};
use sidekicks_contracts::event::version::{EVENT_FIELD_MAX_LEN, EventEnvelopeVersion};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::statement::WriteStatement;
use crate::events::canonicalizer::{OccurredAtNormalizationRefusal, normalize_occurred_at};
use crate::events::content::append::{
    ContentPartitionRefusedError, PatchFilesRefusedError, PatchPartPlace, compose_content_payload,
    compose_patch_file_rows, is_patch_bearing,
};
use crate::events::content::codec::StoredBody;
use crate::events::log_service::{
    EventAppendError, EventLogAppendOptions, EventLogAppendReceipt, EventLogService,
};
use crate::events::session::append_lock::SessionAppendHold;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// A payload that names the session it belongs to and who acted, so the envelope reads both from
/// it and the two cannot disagree.
pub trait AppendedPayload {
    /// The session the event belongs to.
    fn session_id(&self) -> &SessionId;

    /// The person's or agent's id that acted; `None` when the daemon itself did.
    fn actor(&self) -> Option<&FreeFormText<EVENT_FIELD_MAX_LEN>>;
}

/// A typed event ready to append: its session, who acted, its type, the payload members the
/// envelope stores, serialized from the checked event, and the run the event belongs to.
#[derive(Clone, Debug)]
pub struct SessionEventDraft {
    session_id: SessionId,
    actor: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    event_type: SessionEventType,
    payload: Map<String, Value>,
    run: Option<EventRun>,
    content_body: Option<String>,
}

impl SessionEventDraft {
    /// The draft of the event `into_event` makes of `payload`, its session and actor read from the
    /// payload, as `SessionEvent::AgentToolCallInvoked` makes an `agent.toolCall.invoked`. Fails as
    /// [`SessionEventDraft::of_session`] does.
    pub fn new<Payload: AppendedPayload>(
        payload: Payload,
        into_event: fn(Payload) -> SessionEvent,
    ) -> Result<Self, SessionEventDraftError> {
        let session_id = *payload.session_id();
        let actor = payload.actor().cloned();
        Self::checked(session_id, actor, &into_event(payload))
    }

    /// The draft of `event` on `session_id`'s log, for a payload that names no session, with the
    /// daemon as its actor. Fails when the event breaks one of its type's checks, or when its
    /// payload does not serialize to a JSON object.
    pub fn of_session(
        session_id: SessionId,
        event: &SessionEvent,
    ) -> Result<Self, SessionEventDraftError> {
        Self::checked(session_id, None, event)
    }

    fn checked(
        session_id: SessionId,
        actor: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
        event: &SessionEvent,
    ) -> Result<Self, SessionEventDraftError> {
        event.validate()?;
        Ok(Self {
            session_id,
            actor,
            event_type: event.event_type(),
            payload: payload_members(event)?,
            run: event.run(),
            content_body: None,
        })
    }

    /// The draft with `body`, its machine-authored prose, kept beside its payload when it is
    /// appended; a body its append's linkage carries is kept in its place.
    #[must_use]
    pub fn with_content_body(self, body: String) -> Self {
        Self {
            content_body: Some(body),
            ..self
        }
    }
}

/// An event's envelope beside the bytes its row stores as its body.
pub(crate) type EnvelopeWithBody = (UnsequencedEventEnvelope, StoredBody);

/// What makes a row a stored part of a patch-bearing completion rather than an event of its own:
/// it joins the completion's row and is never published, streamed or counted as an event.
#[derive(Clone, Debug)]
pub(crate) struct StoredPatchPart {
    /// The completion's event id, the key its parts join its row by.
    pub(crate) completion_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// Where it sits in the completion's file list.
    pub(crate) place: PatchPartPlace,
}

/// Why a typed event could not be drafted.
#[derive(Debug, thiserror::Error)]
pub enum SessionEventDraftError {
    /// The event breaks one of its type's checks.
    #[error("the event breaks a check of its type")]
    Check(#[from] garde::Report),
    /// The payload does not serialize to a JSON object.
    #[error("the event's payload is not a JSON object")]
    Payload(#[from] serde_json::Error),
}

/// An event to append: every member of the stored envelope but `sequence`, which the writer mints
/// inside its transaction. Its session, type, payload and run come from a [`SessionEventDraft`]
/// only, so they always agree.
#[derive(Clone, Debug)]
pub struct UnsequencedEventEnvelope {
    /// The event's id.
    pub id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// When the event occurred; stored in UTC to the millisecond.
    pub occurred_at: EventOccurredAt,
    /// Who acted: a person's or an agent's id, `None` when the daemon did; stored as `NULL`.
    pub(crate) actor: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The id that ties this event to others of one operation.
    pub(crate) correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The id of what caused this event.
    pub(crate) causation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The producer's envelope version.
    pub(crate) version: EventEnvelopeVersion,
    session_id: SessionId,
    event_type: SessionEventType,
    payload: Map<String, Value>,
    run: Option<EventRun>,
    patch_part: Option<StoredPatchPart>,
}

impl UnsequencedEventEnvelope {
    /// The envelope of `draft`, under a freshly minted id, with the linkage members given;
    /// `occurred_at` is in the stored form.
    pub fn new(
        draft: SessionEventDraft,
        occurred_at: EventOccurredAt,
        correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
        causation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
        version: EventEnvelopeVersion,
    ) -> Self {
        let SessionEventDraft {
            session_id,
            actor,
            event_type,
            payload,
            run,
            content_body: _,
        } = draft;
        Self {
            id: FreeFormText::new(mint_uuid_v7().to_string()).expect("a minted UUID is an id"),
            occurred_at,
            actor,
            correlation_id,
            causation_id,
            version,
            session_id,
            event_type,
            payload,
            run,
            patch_part: None,
        }
    }

    /// The session the event belongs to.
    pub fn session_id(&self) -> SessionId {
        self.session_id
    }

    /// The event's type.
    pub fn event_type(&self) -> SessionEventType {
        self.event_type
    }

    /// The event's category, its type's own.
    pub fn category(&self) -> EventCategory {
        self.event_type.category()
    }

    /// The payload members the envelope stores.
    pub fn payload(&self) -> &Map<String, Value> {
        &self.payload
    }

    /// The run the event belongs to, where its payload names one.
    pub fn run(&self) -> Option<EventRun> {
        self.run
    }

    /// Adds to the payload the description of `body`, the event's machine-authored prose, and
    /// returns the body `content_payload` stores. Fails on a type that carries no body.
    pub fn describe_content(
        &mut self,
        body: String,
    ) -> Result<StoredBody, ContentPartitionRefusedError> {
        compose_content_payload(self.event_type, &mut self.payload, body)
    }

    /// Whether the event is a tool completion naming the files its body's patches cover, whose
    /// body [`UnsequencedEventEnvelope::describe_patch_files`] stores.
    pub(crate) fn is_patch_bearing(&self) -> bool {
        is_patch_bearing(self.event_type, &self.payload)
    }

    /// Where this row sits when it is a stored part of a patch-bearing completion, which is no
    /// event of its own; `None` on every event.
    pub(crate) fn patch_part(&self) -> Option<&StoredPatchPart> {
        self.patch_part.as_ref()
    }

    /// Cuts `body`, this patch-bearing completion's file list, into its rows: adds to the payload
    /// the description of, and returns, the body its own row stores, then each stored part's
    /// envelope, beside this one under a freshly minted id, with its stored body. Fails when the
    /// body is not the file list the payload names.
    pub(crate) fn describe_patch_files(
        &mut self,
        body: &str,
    ) -> Result<(StoredBody, Vec<EnvelopeWithBody>), PatchFilesRefusedError> {
        let rows = compose_patch_file_rows(&mut self.payload, body)?;
        let parts = rows
            .parts
            .into_iter()
            .map(|part| {
                let envelope = Self {
                    id: FreeFormText::new(mint_uuid_v7().to_string())
                        .expect("a minted UUID is an id"),
                    occurred_at: self.occurred_at.clone(),
                    actor: self.actor.clone(),
                    correlation_id: self.correlation_id.clone(),
                    causation_id: self.causation_id.clone(),
                    version: self.version.clone(),
                    session_id: self.session_id,
                    event_type: self.event_type,
                    payload: part.payload,
                    run: self.run,
                    patch_part: Some(StoredPatchPart {
                        completion_id: self.id.clone(),
                        place: part.place,
                    }),
                };
                (envelope, part.body)
            })
            .collect();
        Ok((rows.opening, parts))
    }
}

/// The envelope linkage and the atomic table write one append carries.
#[derive(Debug, Default)]
pub struct SessionEventLinkage {
    /// The instant the event records, for a producer whose rows in the same write carry it too;
    /// the clock's when `None`.
    pub occurred_at: Option<WireInstant>,
    /// The id that ties this event to others of one operation.
    pub correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The id of what caused this event.
    pub causation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// Statements committed in the same write just before the rows; see
    /// [`EventLogAppendOptions::transactional_prelude`].
    pub transactional_prelude: Vec<WriteStatement>,
    /// A body-bearing event's prose, kept beside its payload.
    pub content_body: Option<String>,
    /// Events committed in the same write, in order, just before this one.
    pub preceding_events: Vec<SessionEventDraft>,
}

/// Why an append through the appender was not kept; none of its events is stored.
#[derive(Debug, thiserror::Error)]
pub enum SessionEventAppendError {
    /// The linkage's `occurredAt` cannot take the stored form, one finer than a millisecond among
    /// them.
    #[error("the event's occurredAt cannot be stored")]
    OccurredAt(#[from] OccurredAtNormalizationRefusal),
    /// The event log refused or did not keep the append.
    #[error(transparent)]
    Append(#[from] EventAppendError),
}

/// Why an emitter's typed event was not appended, refused at its draft or at its append; none of
/// its write is kept.
#[derive(Debug, thiserror::Error)]
pub enum SessionEventEmitError {
    /// The event breaks one of its type's checks.
    #[error("the event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the append.
    #[error("the event was not appended")]
    Append(#[from] SessionEventAppendError),
}

/// Builds one session event envelope from a typed event and appends it to the event log.
pub struct SessionEventAppender {
    event_log: Arc<EventLogService>,
    version: EventEnvelopeVersion,
}

impl SessionEventAppender {
    /// An appender writing envelopes of `version` to `event_log`.
    pub fn new(event_log: Arc<EventLogService>, version: EventEnvelopeVersion) -> Self {
        Self { event_log, version }
    }

    /// Appends `draft`, after the linkage's preceding events in the same write, and returns once
    /// it committed. Fails as [`SessionEventAppendError`] says.
    pub async fn append(
        &self,
        draft: SessionEventDraft,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventAppendError> {
        let (envelope, options) = self.envelope_of(draft, linkage)?;
        Ok(self.event_log.append(envelope, options).await?)
    }

    /// Appends as [`SessionEventAppender::append`] does, under `hold`, the caller's own hold on
    /// the draft's session.
    pub async fn append_held(
        &self,
        hold: &SessionAppendHold,
        draft: SessionEventDraft,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventAppendError> {
        let (envelope, options) = self.envelope_of(draft, linkage)?;
        Ok(self.event_log.append_held(hold, envelope, options).await?)
    }

    fn envelope_of(
        &self,
        mut draft: SessionEventDraft,
        linkage: SessionEventLinkage,
    ) -> Result<(UnsequencedEventEnvelope, EventLogAppendOptions), SessionEventAppendError> {
        let SessionEventLinkage {
            occurred_at,
            correlation_id,
            causation_id,
            transactional_prelude,
            content_body,
            preceding_events,
        } = linkage;
        // Built in write order, so the ids minted for them rise with their sequences.
        let preceding_events = preceding_events
            .into_iter()
            .map(|mut preceding| {
                let content_body = preceding.content_body.take();
                let envelope = UnsequencedEventEnvelope::new(
                    preceding,
                    EventOccurredAt::now(),
                    None,
                    None,
                    self.version.clone(),
                );
                (envelope, content_body)
            })
            .collect();
        let occurred_at = match occurred_at {
            Some(occurred_at) => normalize_occurred_at(occurred_at.as_str())?,
            None => EventOccurredAt::now(),
        };
        let draft_body = draft.content_body.take();
        let envelope = UnsequencedEventEnvelope::new(
            draft,
            occurred_at,
            correlation_id,
            causation_id,
            self.version.clone(),
        );
        let options = EventLogAppendOptions {
            content_body: content_body.or(draft_body),
            transactional_prelude,
            preceding_events,
        };
        Ok((envelope, options))
    }
}

/// `event`'s payload members, as the envelope stores them, serialized once from the typed event.
fn payload_members(event: &SessionEvent) -> Result<Map<String, Value>, serde_json::Error> {
    // The event serializes as its type beside its payload.
    let Value::Object(mut members) = serde_json::to_value(event)? else {
        return Err(serde_json::Error::custom(
            "a session event is not a JSON object",
        ));
    };
    let Some(Value::Object(payload)) = members.remove("payload") else {
        return Err(serde_json::Error::custom(
            "a session event's payload is not a JSON object",
        ));
    };
    Ok(payload)
}
