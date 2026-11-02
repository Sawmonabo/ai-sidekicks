//! The move of the daemon's own secrets between the login keychain and the items file of a Mac's
//! service running while the person is logged out, and the check that a place takes a value now.
//!
//! The place record names where the secrets are and, during a move, where they go, so a move
//! stopped partway finishes in the same direction at the next start. A move begins only here; a
//! start finishes one the record names and never begins one.

use sidekicks_contracts::daemon::secrets_place::{
    PlaceRecord, SecretsMoveDestination, SecretsPlace,
};
use sidekicks_contracts::keychain::KeychainRefusalCause;

use crate::credential_store::KeychainRefusal;
use crate::credential_store::items::state::RecordState;
use crate::credential_store::items::{Check, SecretItems, mismatch, unreadable_record};

impl SecretItems {
    /// Moves every item into `destination` under the place lock: a move the record names is
    /// finished first, then the items move from the other place of the pair, each written, read
    /// back, then deleted from its source. No record moves nothing, since the first start picks the
    /// place itself. Fails with [`KeychainRefusal`] when the record cannot be read, names a place
    /// outside the pair, or a call is refused; the record then names any move under way.
    pub async fn move_to(
        &self,
        destination: SecretsMoveDestination,
    ) -> Result<(), KeychainRefusal> {
        let mut state = self.state.write().await;
        self.read_record_once(&mut state).await;
        let mut record = match &state.record {
            RecordState::Present(record) => *record,
            RecordState::Unreadable(reason) => return Err(unreadable_record(reason)),
            RecordState::Unread | RecordState::Absent => return Ok(()),
        };
        if let Some(moving_to) = record.moving_to() {
            self.finish_move(&mut state, record, moving_to).await?;
            record = PlaceRecord::settled(moving_to);
        }
        // The pair is the login keychain and the logged-out service's items file; any other place
        // refuses with nothing moved.
        let source = match record.place() {
            place @ (SecretsPlace::OperatingSystem | SecretsPlace::LoggedOutServiceFile) => place,
            SecretsPlace::SealedFile => return Err(outside_the_pair("the sealed items file")),
            SecretsPlace::PlainFile { .. } => return Err(outside_the_pair("the plain items file")),
        };
        let target = pair_place(destination);
        if source == target {
            return Ok(());
        }
        self.finish_move(&mut state, PlaceRecord::settled(source), target)
            .await
            .map(drop)
    }

    /// Checks that `destination` takes a value now: a write, a read back and a delete under this
    /// run's own probe account, taking no lock, so it runs while a service holds the data folder.
    /// Fails with [`KeychainRefusal`] when the place refuses a call or keeps another value.
    pub async fn check_destination(
        &self,
        destination: SecretsMoveDestination,
    ) -> Result<(), KeychainRefusal> {
        match self.check(pair_place(destination)).await {
            Check::Accepted => Ok(()),
            Check::Mismatch => Err(mismatch()),
            Check::Refused(refusal) => Err(refusal),
        }
    }
}

// The store's place a move's destination names.
fn pair_place(destination: SecretsMoveDestination) -> SecretsPlace {
    match destination {
        SecretsMoveDestination::LoggedOutServiceFile => SecretsPlace::LoggedOutServiceFile,
        SecretsMoveDestination::OperatingSystem => SecretsPlace::OperatingSystem,
    }
}

// The refusal of a move from `kept_in`, a place outside the pair, nothing moved.
fn outside_the_pair(kept_in: &str) -> KeychainRefusal {
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        format!("the secrets are kept in {kept_in}, which no move takes them from"),
    )
}
