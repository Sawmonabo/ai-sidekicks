//! What one run knows of the secrets' place: the record as it read it and the picked place's
//! check, behind the run's lock, and the view of the place the status read takes without that lock,
//! so a read during a call that checks the place again still names the cause the run holds.

use std::sync::{Arc, Mutex};

use sidekicks_contracts::daemon::status::DaemonSecretsFileUnopened;

use super::{cannot_open, mismatch, unreadable_record};
use crate::credential_store::KeychainRefusal;
use crate::credential_store::place::{PlaceRecord, SecretsPlace};
use crate::mutex_lock::lock;

// What this run knows of the place, behind the run's lock.
pub(super) struct PlaceState {
    pub(super) record: RecordState,
    pub(super) verdict: Verdict,
    // The cell the status read takes without the run's lock, written only through this state.
    view: Arc<Mutex<PlaceView>>,
}

// Where calls go and why the sealed file cannot be opened, as the status read sees them.
#[derive(Clone, Copy, Default)]
pub(super) struct PlaceView {
    // Where calls go, once picked.
    pub(super) picked: Option<SecretsPlace>,
    // Why the sealed file could not be opened at the last check, while it could not.
    pub(super) cannot_open: Option<DaemonSecretsFileUnopened>,
}

// The place record as this run read it.
pub(super) enum RecordState {
    Unread,
    // Why it cannot be read.
    Unreadable(String),
    Absent,
    Present(PlaceRecord),
}

// The picked place's check.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    Unchecked,
    Accepted,
    // The place kept another value than the check gave it.
    Mismatch,
    // The sealed file cannot be opened for the cause until the next start: an item does not open
    // under the key the probe opens with, or the service kept another value than the probe gave.
    Latched(DaemonSecretsFileUnopened),
}

// What a call may do now.
pub(super) enum Readiness {
    Ready(SecretsPlace),
    Refused(KeychainRefusal),
    Unsettled,
}

impl PlaceView {
    // The view `cell` holds now.
    pub(super) fn read(cell: &Mutex<Self>) -> Self {
        *lock(cell)
    }
}

impl PlaceState {
    // Nothing read or picked yet, the view kept in `view`.
    pub(super) fn new(view: Arc<Mutex<PlaceView>>) -> Self {
        Self {
            record: RecordState::Unread,
            verdict: Verdict::Unchecked,
            view,
        }
    }

    // Where calls go and why the sealed file cannot be opened.
    pub(super) fn view(&self) -> PlaceView {
        PlaceView::read(&self.view)
    }

    // What a call may do with the place as it stands.
    pub(super) fn readiness(&self) -> Readiness {
        match &self.record {
            RecordState::Unread => return Readiness::Unsettled,
            RecordState::Unreadable(reason) => {
                return Readiness::Refused(unreadable_record(reason));
            }
            RecordState::Absent | RecordState::Present(_) => {}
        }
        match (self.verdict, self.view().picked) {
            (Verdict::Mismatch, _) => Readiness::Refused(mismatch()),
            (Verdict::Latched(cause), _) => Readiness::Refused(cannot_open(cause)),
            (Verdict::Accepted, Some(place)) => Readiness::Ready(place),
            (Verdict::Unchecked | Verdict::Accepted, _) => Readiness::Unsettled,
        }
    }

    // Records that `place` passed its check, once its record names it.
    pub(super) fn accept(&mut self, place: SecretsPlace) -> SecretsPlace {
        self.verdict = Verdict::Accepted;
        *lock(&self.view) = PlaceView {
            picked: Some(place),
            cannot_open: None,
        };
        place
    }

    // Records that the sealed file cannot be opened for `cause`, latched for the run when the key
    // changed and checked again at the next call otherwise, and the refusal for it.
    pub(super) fn refuse_opening(&mut self, cause: DaemonSecretsFileUnopened) -> KeychainRefusal {
        if cause == DaemonSecretsFileUnopened::KeyChanged {
            return self.latch_opening(cause);
        }
        *lock(&self.view) = PlaceView {
            picked: Some(SecretsPlace::SealedFile),
            cannot_open: Some(cause),
        };
        cannot_open(cause)
    }

    // Records that the sealed file cannot be opened for `cause` until the next start, and the
    // refusal for it.
    pub(super) fn latch_opening(&mut self, cause: DaemonSecretsFileUnopened) -> KeychainRefusal {
        *lock(&self.view) = PlaceView {
            picked: Some(SecretsPlace::SealedFile),
            cannot_open: Some(cause),
        };
        self.verdict = Verdict::Latched(cause);
        cannot_open(cause)
    }

    // Forgets the pick and its check, `record` standing as the record read.
    pub(super) fn reset(&mut self, record: RecordState) {
        self.record = record;
        self.verdict = Verdict::Unchecked;
        *lock(&self.view) = PlaceView::default();
    }
}
