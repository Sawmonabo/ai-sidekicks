//! The one minter of artifact ids: a manifest's id is the daemon-wide UUIDv7, so ids sort by the
//! time their manifest was written.

use sidekicks_contracts::artifacts::id::ArtifactId;

use crate::uuid_v7::mint_uuid_v7;

/// Mints the id of a new artifact manifest from the daemon-wide minter.
pub(crate) fn mint_artifact_id() -> ArtifactId {
    ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUIDv7 is an artifact id")
}
