//! The address of Codex's official release notes for a printed version.

use crate::output_validation::is_canonical_semver;

/// Codex's releases page; each release's tag is its version after a `rust-v` prefix.
const RELEASES_ADDRESS: &str = "https://github.com/openai/codex/releases";

/// The release tagged with `version`, or the releases page for a version that is not a canonical
/// semantic version.
pub(super) fn release_notes_address(version: &str) -> String {
    if is_canonical_semver(version) {
        format!("{RELEASES_ADDRESS}/tag/rust-v{version}")
    } else {
        RELEASES_ADDRESS.to_owned()
    }
}
