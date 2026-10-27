//! Rebuilds a session's record from its event log, a pure fold that reads no clock, store or file.
//! The caller supplies the events in sequence order and the fold trusts that order; the directory
//! columns come from the same table the event's own write applies to the `sessions` row.

use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::directory::row::{
    DirectoryEvent, DirectoryRowError, fold_directory_row, open_directory_row,
};
use crate::records::DaemonSessionRecord;

/// Why a session's log does not rebuild into a record.
#[derive(Debug, thiserror::Error)]
pub enum SessionRebuildError {
    /// The bootstrap `session.created` sits past sequence 0: earlier events were lost or its
    /// producer broke the bootstrap contract, so a record from it would show partial state as
    /// whole.
    #[error(
        "the session's bootstrap session.created is at sequence {sequence}, not 0: earlier events \
         were lost or its producer broke the bootstrap contract"
    )]
    BootstrapNotAtStart {
        /// The bootstrap's sequence.
        sequence: u64,
    },
    /// An event does not open or fold into the directory row: the log does not open at
    /// `session.created`, names it again later, or holds an event its read refuses.
    #[error("the session's event at sequence {sequence} does not fold into its directory row")]
    Fold {
        /// The event's sequence.
        sequence: u64,
        /// Why it does not fold.
        #[source]
        source: DirectoryRowError,
    },
}

/// Folds a session's events, in sequence order, into its record; `None` for an empty list, since a
/// session has at least its `session.created`. Fails with [`SessionRebuildError::Fold`] when the
/// first event is not a `session.created` or a later one is, and with
/// [`SessionRebuildError::BootstrapNotAtStart`] when the bootstrap is not at sequence 0.
pub(crate) fn rebuild_session(
    events: &[EventEnvelope],
) -> Result<Option<DaemonSessionRecord>, SessionRebuildError> {
    let Some((created, later)) = events.split_first() else {
        return Ok(None);
    };
    let mut directory_row =
        open_directory_row(&DirectoryEvent::from(created)).map_err(|source| {
            SessionRebuildError::Fold {
                sequence: created.sequence.get(),
                source,
            }
        })?;
    if created.sequence.get() != 0 {
        return Err(SessionRebuildError::BootstrapNotAtStart {
            sequence: created.sequence.get(),
        });
    }
    for event in later {
        directory_row =
            fold_directory_row(&directory_row, &DirectoryEvent::from(event)).map_err(|source| {
                SessionRebuildError::Fold {
                    sequence: event.sequence.get(),
                    source,
                }
            })?;
    }
    let newest = later.last().unwrap_or(created);
    Ok(Some(DaemonSessionRecord {
        directory_row,
        as_of_sequence: i64::from(newest.sequence),
        // A system-emitted bootstrap names no actor, which stays `None` rather than an invented
        // owner.
        owner_actor: created
            .actor
            .clone()
            .flatten()
            .map(FreeFormText::into_string),
    }))
}
