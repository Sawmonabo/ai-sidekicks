//! The version of the daemon's git, read once per runner, and the first git release of each
//! feature a capture or its packing calls.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the snapshot capture and its packing check their git features through it"
    )
)]

use std::ffi::OsString;
use std::path::Path;

use sidekicks_contracts::place::Place;

use super::{GitError, GitRunner, PreparedCall};

/// A git feature some call relies on, each with the first release that has it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GitFeature {
    /// `rev-list --missing`, from 2.16.
    RevListMissing,
    /// `rev-parse --path-format`, from 2.31.
    RevParsePathFormat,
    /// `repack --geometric`, from 2.32.
    RepackGeometric,
    /// The `core.fsync` setting, from 2.36.
    CoreFsync,
    /// `sparse-checkout check-rules`, from 2.41.
    SparseCheckoutCheckRules,
}

impl GitFeature {
    // The first release that has the feature.
    fn floor(self) -> GitVersion {
        let minor = match self {
            Self::RevListMissing => 16,
            Self::RevParsePathFormat => 31,
            Self::RepackGeometric => 32,
            Self::CoreFsync => 36,
            Self::SparseCheckoutCheckRules => 41,
        };
        GitVersion {
            major: 2,
            minor,
            patch: 0,
        }
    }
}

/// A git release as `git --version` names it: major, minor and patch, compared in that order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct GitVersion {
    major: u32,
    minor: u32,
    patch: u32,
}

impl GitVersion {
    /// The release `git --version` printed in `stdout`, any build suffix after the patch ignored
    /// (`2.54.0 (Apple Git-157)`, `2.41.0.windows.1`); `None` when no three numbers lead it.
    pub(crate) fn from_version_output(stdout: &[u8]) -> Option<Self> {
        let text = String::from_utf8_lossy(stdout);
        let release = text
            .trim()
            .strip_prefix("git version ")?
            .split_whitespace()
            .next()?;
        let mut numbers = release.split('.').map(leading_number);
        Some(Self {
            major: numbers.next()??,
            minor: numbers.next()??,
            patch: numbers.next()??,
        })
    }

    /// Whether this release has `feature`.
    pub(crate) fn has(self, feature: GitFeature) -> bool {
        self >= feature.floor()
    }
}

// The digits a version part starts with, so a pre-release's `0-rc1` reads as 0; `None` when it
// starts with none.
fn leading_number(part: &str) -> Option<u32> {
    let digits = part.len() - part.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    part[..digits].parse().ok()
}

impl GitRunner {
    /// Whether the git program for a project at `place` has `feature`, its version read once for
    /// the runner. Fails as [`run`](Self::run) does, and with `UnreadableVersion` when git names no
    /// version this code can read, never answering that it has the feature.
    pub(crate) async fn meets(
        &self,
        place: Option<&Place>,
        feature: GitFeature,
    ) -> Result<bool, GitError> {
        let executable = self.executable_for(place)?;
        Ok(self.read_version(executable).await?.has(feature))
    }

    // The version of the git at `executable`, read once for the runner; a failed read is not kept.
    async fn read_version(&self, executable: &Path) -> Result<GitVersion, GitError> {
        self.git_version
            .get_or_try_init(|| async {
                let arguments = vec![OsString::from("--version")];
                let output = self
                    .run_git(executable, PreparedCall::of(arguments), self.limits.timeout)
                    .await?;
                GitVersion::from_version_output(&output.stdout).ok_or(GitError::UnreadableVersion)
            })
            .await
            .copied()
    }
}

#[cfg(test)]
mod tests;
