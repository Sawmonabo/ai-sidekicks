//! This build's release version, read in one place.

use sidekicks_contracts::release_manifest::ReleaseVersion;

/// The release version of this build of the daemon, as its crate states it.
pub(crate) fn this_build_release_version() -> ReleaseVersion {
    ReleaseVersion::new(env!("CARGO_PKG_VERSION").to_owned())
        .expect("the crate's version is a release version")
}
