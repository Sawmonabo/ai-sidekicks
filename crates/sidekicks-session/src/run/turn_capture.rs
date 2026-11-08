//! The turn-end capture: at each committed turn end of a run bound to a checkout, the checkout is
//! recorded as a turn snapshot in the session's capture folder, under the run's epoch and the run
//! position the turn's opening message took in it, both read from the log, so a capture after a
//! restart or a rollback lands where the log says the turn stands. A follower of every session's
//! events spawns each end's capture off the writer's pump; the stop waits for every capture under
//! way and cuts none short. A run with no execution context, as a chat's own folder runs, captures
//! nothing.

use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use jiff::Timestamp;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::{
    EpochPosition, TURN_END_EVENT_TYPES, TURN_STARTED_EVENT_TYPE,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::followers::{
    CommittedEvent, FollowerAttachment, SessionEventFollowers,
};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use sidekicks_workspace::git::turn_snapshot::capture::CheckoutCaptureInput;
use sidekicks_workspace::git::turn_snapshot::refs::RunSnapshotPoint;
use sidekicks_workspace::git::turn_snapshot::service::{
    TurnSnapshotCaptureInput, TurnSnapshotService,
};
use tokio::runtime::Handle;
use tokio_util::task::TaskTracker;

use crate::run::checkout::{RunCheckout, read_run_checkout};
use crate::transcript::turn_attribution::{RunTurnReads, TurnAttributionError};

/// The statements a turn end's capture prepares on a pooled connection: the run's checkout and
/// place, the sequence of the turn's own start, and the run's rollbacks and its turn starts and
/// steers its standing is read from.
pub const TURN_CAPTURE_STATEMENT_CAPACITY: usize = 4;

// The sequence of the run's start of the turn, spelled as the unique index on turn starts spells
// its predicate.
static SELECT_TURN_START_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT sequence FROM session_events
  WHERE category = '{}'
    AND type = '{TURN_STARTED_EVENT_TYPE}'
    AND run_id = @run_id
    AND turn_number = @turn_number",
        EventCategory::RunLifecycle.as_str()
    )
});

/// Why a turn end's checkout could not be read; that end is not captured.
#[derive(Debug, thiserror::Error)]
enum TurnCheckoutReadError {
    /// The read pool did not run the read.
    #[error("the read pool did not run the turn end's read")]
    Pool(#[from] DatabaseReadError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the run's checkout or its turn's start could not be read")]
    Read(#[from] rusqlite::Error),
    /// Where the run stood once the turn started could not be read from its log.
    #[error(transparent)]
    Standing(#[from] TurnAttributionError),
    /// The log holds no start of the ended turn.
    #[error("the log holds no start of the ended turn")]
    TurnStartAbsent,
}

// A committed turn end the capture records the checkout at.
#[derive(Clone, Copy, Debug)]
struct TurnEnding {
    session_id: SessionId,
    run_id: RunId,
    turn_number: SafeInt<1>,
    ended_at: Timestamp,
}

// What a turn end's capture reads: where the run works, the place git runs for, and the epoch and
// run position the ended turn started at.
struct TurnCheckout {
    checkout: RunCheckout,
    turn: EpochPosition,
}

/// Records the checkout at each committed turn end of a run bound to one, from
/// [`TurnCapture::start`] until [`TurnCapturing::stop`].
pub struct TurnCapture {
    pool: Arc<DatabaseReadPool>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    snapshots: Arc<TurnSnapshotService>,
    data_folder: PathBuf,
    /// Every capture under way, so the stop waits for each.
    captures: TaskTracker,
}

/// The follow of every session's committed turn ends and the captures they started, from
/// [`TurnCapture::start`] until [`TurnCapturing::stop`].
pub struct TurnCapturing {
    /// Hears every committed turn end; dropping it detaches.
    attachment: FollowerAttachment,
    capture: Arc<TurnCapture>,
}

impl TurnCapturing {
    /// Stops hearing turn ends and settles once every capture under way has ended; none is cut
    /// short, since a capture cut mid-way leaves its scratch index behind.
    pub async fn stop(self) {
        let Self {
            attachment,
            capture,
        } = self;
        drop(attachment);
        capture.captures.close();
        capture.captures.wait().await;
    }
}

impl TurnCapture {
    /// The capture reading runs and their logs through `pool`, no log read passing where
    /// `read_damaged_from_sequence` stops a damaged session, capturing through `snapshots` into
    /// each session's storage folder under `data_folder`.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
        snapshots: Arc<TurnSnapshotService>,
        data_folder: PathBuf,
    ) -> Self {
        Self {
            pool,
            read_damaged_from_sequence,
            snapshots,
            data_folder,
            captures: TaskTracker::new(),
        }
    }

    /// Follows every committed turn end of `followers`, each end's capture spawned on the runtime
    /// this is called inside, the daemon's.
    pub fn start(self: &Arc<Self>, followers: &Arc<SessionEventFollowers>) -> TurnCapturing {
        let runtime = Handle::current();
        let capture = Arc::clone(self);
        // Runs on the writer's pump, so it only spawns the capture.
        let attachment = followers.follow_all(move |event| {
            // The token holds the stop's wait until this publish has spawned its capture or,
            // finding the tracker closed, spawned none, so no capture starts past the stop's wait.
            let _publishing = capture.captures.token();
            if !capture.captures.is_closed()
                && let Some(ending) = turn_ending_of(event)
            {
                capture
                    .captures
                    .spawn_on(Arc::clone(&capture).capture_end(ending), &runtime);
            }
            Ok(())
        });
        TurnCapturing {
            attachment,
            capture: Arc::clone(self),
        }
    }

    // Captures the checkout at `ending`, where its run has one: a failed read is logged once with
    // its cause and the end goes uncaptured, and the snapshot service logs a failed capture.
    async fn capture_end(self: Arc<Self>, ending: TurnEnding) {
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        let checkout = self
            .pool
            .read(ReadLength::Short, move |reader| {
                read_turn_checkout(reader, &*read_damaged_from_sequence, ending)
            })
            .await;
        let checkout = match checkout {
            Ok(Some(checkout)) => checkout,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(
                    session_id = %ending.session_id,
                    run_id = %ending.run_id,
                    turn_number = ending.turn_number.get(),
                    error = &error as &(dyn Error + 'static),
                    "a turn end's checkout could not be read, so it was not captured"
                );
                return;
            }
        };
        let input = TurnSnapshotCaptureInput {
            checkout: CheckoutCaptureInput {
                owner_folder: session_storage_folder(&self.data_folder, &ending.session_id),
                execution_root: checkout.checkout.execution_root,
                checkout_root: checkout.checkout.checkout_root,
                captured_at: ending.ended_at,
            },
            point: RunSnapshotPoint::Turn {
                run_id: ending.run_id,
                epoch: checkout.turn.epoch.0.get(),
                ordinal: checkout.turn.position.0.get(),
            },
        };
        self.snapshots
            .capture_turn_snapshot(checkout.checkout.place.as_ref(), &input)
            .await;
    }
}

// The turn end `event` is, where it is one of a run's turn ends.
fn turn_ending_of(event: &CommittedEvent) -> Option<TurnEnding> {
    let envelope = &event.envelope;
    if !TURN_END_EVENT_TYPES.contains(&envelope.event_type().as_str()) {
        return None;
    }
    let run = envelope.run()?;
    Some(TurnEnding {
        session_id: envelope.session_id(),
        run_id: run.run_id,
        turn_number: run.turn_number?,
        ended_at: envelope
            .occurred_at
            .timestamp()
            .expect("the append path stores occurredAt in its normalized form, which parses"),
    })
}

// The checkout `ending`'s run works in and the turn its ended turn started at, on one connection;
// `None` for a run with no execution context. The turn is where the run stood just past the
// turn's own start, so a late end, or a turn re-executed after a cut, takes its own place.
fn read_turn_checkout(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    ending: TurnEnding,
) -> Result<Option<TurnCheckout>, TurnCheckoutReadError> {
    let Some(checkout) = read_run_checkout(reader, ending.run_id)? else {
        return Ok(None);
    };
    let run_id = ending.run_id.text();
    let turn_start: i64 = reader
        .prepare_cached(&SELECT_TURN_START_SQL)?
        .query_row(
            named_params! {
                "@run_id": run_id.as_str(),
                "@turn_number": i64::from(ending.turn_number),
            },
            |row| row.get(0),
        )
        .optional()?
        .ok_or(TurnCheckoutReadError::TurnStartAbsent)?;
    let turn = RunTurnReads::new(reader, read_damaged_from_sequence).read_standing_before(
        &ending.session_id,
        &ending.run_id,
        turn_start + 1,
    )?;
    Ok(Some(TurnCheckout { checkout, turn }))
}

#[cfg(test)]
mod tests;
