//! The address of Claude Code's official release notes for a printed version.

use crate::output_validation::is_canonical_semver;

/// Claude Code's changelog page; each version's heading is anchored by the version with its dots
/// as dashes.
const CHANGELOG_ADDRESS: &str = "https://code.claude.com/docs/en/changelog";

/// The changelog at `version`'s heading, or the changelog's top for a version that is not a
/// canonical semantic version; a version with no heading yet lands on the top of the same page.
pub(super) fn release_notes_address(version: &str) -> String {
    if is_canonical_semver(version) {
        format!("{CHANGELOG_ADDRESS}#{}", version.replace('.', "-"))
    } else {
        CHANGELOG_ADDRESS.to_owned()
    }
}
