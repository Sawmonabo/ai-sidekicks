//! The read projection for machine-authored prose: pairs a stored event with the body its
//! `session_events.content_payload` column and those of the pieces that join it hold, without
//! altering the event.
//!
//! - The body is never merged into `payload`: it is left out of the canonical bytes, and a caller
//!   must be able to tell what the daemon stored from what a read added, so the projection is a
//!   pair ([`HydratedSessionEvent`]).
//! - A row with no body reads on the `unavailable` arm, never as an empty `available` body, which
//!   would claim the agent said nothing.
//! - `content_payload` stays on its machine, so a row carried in from a peer reads as `absent`.

use sidekicks_contracts::event::envelope::{
    EventEnvelope, HydratedContentUnavailableReason, HydratedSessionEvent,
    HydratedSessionEventContent,
};
use sidekicks_contracts::wire::integer::SafeInt;

use crate::events::content::codec::StoredBodyPlace;

/// One stored row, as the caller read it.
#[derive(Clone, Debug)]
pub(crate) struct StoredEventContentRow {
    /// The event, as already read from the `payload` column.
    pub(crate) envelope: EventEnvelope,
    /// The row's body: its own `session_events.content_payload` and those of the pieces that join
    /// it, decoded and joined in order; `None` when it stores none.
    pub(crate) content_payload: Option<String>,
    /// The joined body's UTF-8 byte length, as [`joined_content_length`] sums it.
    pub(crate) content_length: Option<u64>,
}

/// Pairs one stored row with its body.
pub(crate) fn hydrate_stored_event(row: StoredEventContentRow) -> HydratedSessionEvent {
    let content = match row.content_payload {
        Some(body) => HydratedSessionEventContent::Available {
            body,
            content_length: row.content_length.and_then(SafeInt::new),
        },
        None => HydratedSessionEventContent::Unavailable {
            reason: HydratedContentUnavailableReason::Absent,
        },
    };
    HydratedSessionEvent {
        event: row.envelope,
        content,
    }
}

/// The length of a body stored as `pieces`, its own and those that join it: the sum of the lengths
/// their payloads state, echoed rather than counted from the text; `None` when one states none.
pub(crate) fn joined_content_length(pieces: &[StoredBodyPlace]) -> Option<u64> {
    pieces.iter().map(|piece| piece.content_length).sum()
}
