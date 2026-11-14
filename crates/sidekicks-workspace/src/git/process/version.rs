//! The record of what was read of the daemon's git build (its release, whether it has its built-in
//! file watch, and the stat data of the program and of the git it runs), kept once per runner and
//! read again only before a refusal and only when that stat data changed, and the first git
//! release of each feature a capture, its packing or a read of an index calls.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_platforms::{FileFacts, file_facts, path_from_program_output};

use super::{BUILT_IN_FILE_WATCH_BUILD_LINE, GitError, GitRunner, PreparedCall, strip_line_end};

/// A git feature some call relies on, each with the first release that has it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum GitFeature {
    /// `repack --geometric`, from 2.32, which the fold of a capture folder's packs runs.
    RepackGeometric,
    /// The `core.fsync` setting, with the `reference` component a capture's ref write names, from
    /// 2.36 (its configuration reference lists `reference` among the components).
    CoreFsync,
    /// `sparse-checkout check-rules`, from 2.41, which a capture in a sparse root runs.
    SparseCheckoutCheckRules,
    /// `ls-files --sparse`, from 2.35, which keeps a sparse index's folders as the trees they
    /// name, so the backup's read of an index and the clone's listing of its submodules never
    /// expand one.
    LsFilesSparse,
}

impl GitFeature {
    /// The first release that has the feature.
    pub(crate) fn floor(self) -> GitVersion {
        let minor = match self {
            Self::RepackGeometric => 32,
            Self::CoreFsync => 36,
            Self::SparseCheckoutCheckRules => 41,
            Self::LsFilesSparse => 35,
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

impl fmt::Display for GitVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

// The digits a version part starts with, so a pre-release's `0-rc1` reads as 0; `None` when it
// starts with none.
fn leading_number(part: &str) -> Option<u32> {
    let digits = part.len() - part.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    part[..digits].parse().ok()
}

/// What one read of the daemon's git build found, replaced whole when it is read again.
#[derive(Clone, Debug)]
pub(crate) struct GitBuild {
    /// The release `git version` named.
    version: GitVersion,
    /// Whether the program was built with its file-watch daemon.
    has_built_in_file_watch: bool,
    /// The found program's stat data, links followed; `None` when the stat failed.
    program_facts: Option<FileFacts>,
    /// The git under the program's `--exec-path`, which a launcher such as `/usr/bin/git` runs and
    /// an update replaces while the launcher stays as it was.
    installed_program: PathBuf,
    /// That git's stat data, links followed; `None` when the stat failed.
    installed_program_facts: Option<FileFacts>,
}

impl GitRunner {
    /// The release of the git program for a project at `place`, which [`GitVersion::has`] checks
    /// a feature against: the one kept from the last read, read again first only when it lacks
    /// `needed` and the program's stat data changed since or cannot be read, so an upgrade counts
    /// at the next call and an unchanged git spawns nothing. Fails as [`run`](Self::run) does, and
    /// with `UnreadableVersion` when git names no version this code can read, so no feature is
    /// ever taken to be there.
    pub(crate) async fn version(
        &self,
        place: Option<&Place>,
        needed: GitFeature,
    ) -> Result<GitVersion, GitError> {
        let executable = self.executable_for(place)?;
        let mut record = self.build_record.lock().await;
        let kept = if let Some(kept) = record.as_ref() {
            kept.clone()
        } else {
            let read = Box::pin(self.read_build(executable)).await?;
            *record = Some(read.clone());
            read
        };
        if kept.version.has(needed) {
            return Ok(kept.version);
        }
        let facts = read_program_facts(executable, &kept.installed_program).await;
        // A stat that fails tells nothing, so it never stands for an unchanged program.
        let is_unchanged = matches!(facts, (Some(_), Some(_)))
            && facts == (kept.program_facts, kept.installed_program_facts);
        if is_unchanged {
            return Ok(kept.version);
        }
        // A failed read keeps nothing, so the next call reads again.
        *record = None;
        let read = Box::pin(self.read_build(executable)).await?;
        let version = read.version;
        *record = Some(read);
        Ok(version)
    }

    // Whether the git at `executable` was built with its file-watch daemon, from the kept record,
    // read once it is first needed; a failed read is not kept.
    pub(super) async fn read_built_in_file_watch(
        &self,
        executable: &Path,
    ) -> Result<bool, GitError> {
        let mut record = self.build_record.lock().await;
        if let Some(kept) = record.as_ref() {
            return Ok(kept.has_built_in_file_watch);
        }
        let read = Box::pin(self.read_build(executable)).await?;
        let has_built_in_file_watch = read.has_built_in_file_watch;
        *record = Some(read);
        Ok(has_built_in_file_watch)
    }

    // One read of the build of the git at `executable`: `version --build-options` for the release
    // and the file-watch line, `--exec-path` beside it for the git it runs, then both programs'
    // stat data. Callers pin it on the heap, so its two calls sit in no caller's future.
    async fn read_build(&self, executable: &Path) -> Result<GitBuild, GitError> {
        let build_options = PreparedCall::of(vec![
            OsString::from("version"),
            OsString::from("--build-options"),
        ]);
        let exec_path = PreparedCall::of(vec![OsString::from("--exec-path")]);
        let (options, exec_folder) = tokio::try_join!(
            self.run_git(executable, build_options, self.limits.timeout),
            self.run_git(executable, exec_path, self.limits.timeout),
        )?;
        // The first line names the release; the words after it stop at its end.
        let version =
            GitVersion::from_version_output(&options.stdout).ok_or(GitError::UnreadableVersion)?;
        let has_built_in_file_watch = options
            .stdout
            .split(|byte| *byte == b'\n')
            .any(|line| line.trim_ascii() == BUILT_IN_FILE_WATCH_BUILD_LINE);
        let exec_folder = path_from_program_output(strip_line_end(exec_folder.stdout))
            .map_err(GitError::PathText)?;
        let installed_program = exec_folder.join(format!("git{}", std::env::consts::EXE_SUFFIX));
        let (program_facts, installed_program_facts) =
            read_program_facts(executable, &installed_program).await;
        Ok(GitBuild {
            version,
            has_built_in_file_watch,
            program_facts,
            installed_program,
            installed_program_facts,
        })
    }

    /// This runner with its git taken to be the release `version_output` names, its other facts
    /// read from the running git, for a test of what an older or newer git does, its kept stat
    /// data as `kept_facts` says.
    #[cfg(test)]
    pub(crate) async fn reading_version_as(
        mut self,
        version_output: &[u8],
        kept_facts: KeptProgramFacts,
    ) -> Self {
        let executable = self
            .executable_for(None)
            .expect("the tests run where git is")
            .to_path_buf();
        let mut build = self.read_build(&executable).await.expect("the build reads");
        build.version = GitVersion::from_version_output(version_output).expect("the version reads");
        match kept_facts {
            KeptProgramFacts::Current => {}
            KeptProgramFacts::Changed => {
                let stale = |facts: Option<FileFacts>| {
                    facts.map(|facts| FileFacts {
                        size: facts.size + 1,
                        ..facts
                    })
                };
                build.program_facts = stale(build.program_facts);
                build.installed_program_facts = stale(build.installed_program_facts);
            }
            KeptProgramFacts::Unreadable => {
                build.installed_program = executable.with_file_name("no-such-git");
                build.installed_program_facts = None;
            }
        }
        self.build_record = std::sync::Arc::new(tokio::sync::Mutex::new(Some(build)));
        self
    }
}

/// How a test runner's kept stat data of its git stands against the programs.
#[cfg(test)]
#[derive(Clone, Copy, Debug)]
pub(crate) enum KeptProgramFacts {
    /// It matches the programs.
    Current,
    /// It no longer matches them, as after an upgrade.
    Changed,
    /// The installed program's stat failed when the record was read and fails again since.
    Unreadable,
}

// The stat data of `program` and `installed_program`, links followed, on the blocking pool; a stat
// that fails, or a blocking task that does not finish, reads `None`.
async fn read_program_facts(
    program: &Path,
    installed_program: &Path,
) -> (Option<FileFacts>, Option<FileFacts>) {
    let (program, installed_program) = (program.to_path_buf(), installed_program.to_path_buf());
    tokio::task::spawn_blocking(move || {
        (
            file_facts(&program).ok(),
            file_facts(&installed_program).ok(),
        )
    })
    .await
    .unwrap_or((None, None))
}

#[cfg(test)]
mod tests;
