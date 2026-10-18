//! The read projection for machine-authored prose: pairs a stored event with the body its
//! `session_events.content_payload` column holds, without altering the event.
//!
//! - The body is never merged into `payload`: it is left out of the canonical bytes, and a caller
//!   must be able to tell what the daemon stored from what a read added, so the projection is a
//!   pair ([`HydratedSessionEvent`]).
//! - A row with no body reads on the `unavailable` arm, never as an empty `available` body, which
//!   would claim the agent said nothing.
//! - `content_payload` stays on its machine, so a row carried in from a peer reads as `absent`.

use sidekicks_contracts::event::envelope::{EventEnvelope, HydratedSessionEvent};
use sidekicks_contracts::transcript::content::hydrated_content_of;

/// One stored row, as the caller read it.
#[derive(Clone, Debug)]
pub(crate) struct StoredEventContentRow {
    /// The event, as already read from the `payload` column.
    pub(crate) envelope: EventEnvelope,
    /// `session_events.content_payload` as text: the column's bytes, read as UTF-8.
    pub(crate) content_payload: Option<String>,
}

/// Pairs one stored row with its body.
pub(crate) fn hydrate_stored_event(row: StoredEventContentRow) -> HydratedSessionEvent {
    let content = hydrated_content_of(Some(&row.envelope.payload), row.content_payload);
    HydratedSessionEvent {
        event: row.envelope,
        content,
    }
}
