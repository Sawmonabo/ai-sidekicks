//! Finds a provider's command in the folders its own installer, the system's package manager, npm
//! and the Node version and package managers put it, for a spawn whose search path holds none.
//! Where more than one build is found, the newest runs: each build's `--version` is read under a
//! deadline, and a read that printed is kept for that build. A build runs with the folder it was
//! found in first on its search path, where a Node manager keeps the `node` its script's
//! `#!/usr/bin/env node` names.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use semver::Version;
use sidekicks_platforms::{
    PathRules, ProgramFolder, Spawner, file_facts, find_executables, program_install_folders,
    real_path, user_programs_folder,
};
use sidekicks_std::child_run::ChildRunError;
use sidekicks_std::missing_entry::is_gone;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::OnceCell;

use crate::driver::{InstallFolderBase, ProviderDescriptor};
use crate::program_run::{ProgramRunRequest, run_program_to_end};
use crate::spawn_environment::{place_folder_first_on_search_path, remove_environment_names};
use crate::spawned_version::parse_cli_version_report;

/// How long one build may take to print its version before it ranks below every build that did.
const VERSION_READ_DEADLINE: Duration = Duration::from_secs(5);

/// The most bytes one stream of a build's `--version` may print; the answer is one short line.
const VERSION_OUTPUT_BOUND: usize = 64 * 1024;

/// The search a provider's command falls back to once the spawn environment's `PATH` holds none.
/// It keeps each build's version for the daemon's life once a read of it printed: a build replaced
/// at the same path, with another modification time or length, is read again, and so is one whose
/// read timed out or could not start.
pub struct ProviderCommandSearch {
    spawner: Spawner,
    // Per canonical path, one entry, so a replaced build takes its place.
    versions: Mutex<HashMap<PathBuf, FoundBuildVersion>>,
}

/// One build the search found: its resolved path and the folder its command was found in.
pub(crate) struct ProviderCommandSearchHit {
    /// The build's absolute, symlink-resolved path.
    pub(crate) build: PathBuf,
    /// The folder the command sits in, never the build's own: a Node manager links its command to
    /// a script deep in its packages, beside no `node`. Put first on the build's search path.
    pub(crate) folder: String,
    stamp: BuildStamp,
}

// A build's stamp and its version, set once a read of it printed: `None` for a build that printed
// no version it could be ranked by.
struct FoundBuildVersion {
    stamp: BuildStamp,
    version: Arc<OnceCell<Option<Version>>>,
}

// Which build sits at a canonical path: its modification time and length.
#[derive(Clone, Copy, PartialEq, Eq)]
struct BuildStamp {
    modified: i128,
    size: u64,
}

// Why a build's `--version` could not be read.
#[derive(Debug, thiserror::Error)]
enum VersionReadError {
    #[error("the build's version read did not run to its end")]
    Run(#[source] ChildRunError),
    #[error("the build exited with {0}")]
    Exited(ExitStatus),
}

impl ProviderCommandSearch {
    /// A search with no version read yet, starting each build's version read on `spawner`.
    pub fn new(spawner: Spawner) -> Self {
        Self {
            spawner,
            versions: Mutex::new(HashMap::new()),
        }
    }

    /// The newest build `command` names in `folders`, searched in order, or `None` where none holds
    /// it. A build whose version cannot be read ranks below every build whose can; among equal
    /// versions the earlier folder wins; the same build found twice keeps its first folder. Builds
    /// run in `spawn_environment`, the provider's own. Fails only when the blocking search task
    /// ends before it answers.
    pub(crate) async fn find(
        &self,
        command: &str,
        folders: Vec<ProgramFolder>,
        spawn_environment: &[(String, String)],
    ) -> io::Result<Option<ProviderCommandSearchHit>> {
        let (owned_command, owned_environment) = (command.to_owned(), spawn_environment.to_vec());
        let hits = tokio::task::spawn_blocking(move || {
            list_builds(&owned_command, folders, owned_environment)
        })
        .await
        .map_err(io::Error::other)?;
        if hits.len() <= 1 {
            return Ok(hits.into_iter().next());
        }
        let versions = futures::future::join_all(
            hits.iter()
                .map(|hit| self.read_version(hit, spawn_environment)),
        )
        .await;
        // Replaced only by a strictly newer version, so equal versions keep the earlier folder.
        let mut newest = 0;
        for (index, version) in versions.iter().enumerate() {
            if let Some(version) = version
                && versions[newest].as_ref().is_none_or(|best| version > best)
            {
                newest = index;
            }
        }
        Ok(hits.into_iter().nth(newest))
    }

    // The build's version, kept once a read of it printed; a read that failed is tried again by
    // the next search.
    async fn read_version(
        &self,
        hit: &ProviderCommandSearchHit,
        spawn_environment: &[(String, String)],
    ) -> Option<Version> {
        let version = {
            let mut versions = lock(&self.versions);
            match versions.get(&hit.build) {
                Some(found) if found.stamp == hit.stamp => Arc::clone(&found.version),
                Some(_) | None => {
                    let version = Arc::new(OnceCell::new());
                    versions.insert(
                        hit.build.clone(),
                        FoundBuildVersion {
                            stamp: hit.stamp,
                            version: Arc::clone(&version),
                        },
                    );
                    version
                }
            }
        };
        match version
            .get_or_try_init(|| self.read_build_version(hit, spawn_environment))
            .await
        {
            Ok(version) => version.clone(),
            Err(error) => {
                tracing::warn!(
                    build = %hit.build.display(),
                    error = &error as &(dyn Error + 'static),
                    "a provider build did not print its version, so it runs only where no build \
                     that did is found, and is read again by the next search"
                );
                None
            }
        }
    }

    // Starts the build for its `--version` and parses what it printed; a build that prints no
    // version it can be ranked by is logged and answers `None`. Fails as the read does.
    async fn read_build_version(
        &self,
        hit: &ProviderCommandSearchHit,
        spawn_environment: &[(String, String)],
    ) -> Result<Option<Version>, VersionReadError> {
        let output = self.read_version_output(hit, spawn_environment).await?;
        let parsed = parse_cli_version_report(&String::from_utf8_lossy(&output))
            .parsed_version
            .and_then(|parsed| Version::parse(&parsed).ok());
        if parsed.is_none() {
            tracing::warn!(
                build = %hit.build.display(),
                "a provider build printed no version it could be ranked by, so it runs only where \
                 no build that did is found"
            );
        }
        Ok(parsed)
    }

    // What the build printed for `--version`, run to its end with its folder first on its search
    // path; a run past the deadline or the output bound has its tree ended by the runner.
    async fn read_version_output(
        &self,
        hit: &ProviderCommandSearchHit,
        spawn_environment: &[(String, String)],
    ) -> Result<Vec<u8>, VersionReadError> {
        let mut environment = spawn_environment.to_vec();
        place_folder_first_on_search_path(&mut environment, &hit.folder, PathRules::NATIVE);
        let request = ProgramRunRequest {
            program: hit.build.clone(),
            arguments: vec!["--version".into()],
            environment,
            working_folder: None,
        };
        let output = run_program_to_end(
            &self.spawner,
            request,
            VERSION_READ_DEADLINE,
            VERSION_OUTPUT_BOUND,
        )
        .await
        .map_err(VersionReadError::Run)?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(VersionReadError::Exited(output.status))
        }
    }
}

/// The folders a provider's command is looked for in once the spawn environment's `PATH` holds
/// none, in search order: the provider's own installer's folders from `descriptor`, then the
/// folders the system's package manager, npm and the Node managers use, each moved by its variable
/// in `spawn_environment` (an empty one counts as unset). `home` is the person's home folder; a
/// folder under the person's programs folder is left out where the system has none. Never fails.
pub(crate) fn list_command_folders(
    descriptor: &ProviderDescriptor,
    home: &Path,
    spawn_environment: &[(String, String)],
) -> Vec<ProgramFolder> {
    let install_folders = descriptor
        .command_lookup(PathRules::NATIVE)
        .map_or(&[][..], |lookup| lookup.install_folders);
    let user_programs = install_folders
        .iter()
        .any(|folder| folder.base == InstallFolderBase::UserPrograms)
        .then(user_programs_folder)
        .flatten();
    let own_folders = install_folders.iter().filter_map(|folder| {
        let base = match folder.base {
            InstallFolderBase::Home => home.to_path_buf(),
            InstallFolderBase::UserPrograms => user_programs.clone()?,
        };
        Some(ProgramFolder::Folder(
            folder
                .components
                .iter()
                .fold(base, |path, component| path.join(component)),
        ))
    });
    let read_variable = |name: &str| {
        PathRules::NATIVE
            .environment_value(spawn_environment, name)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    own_folders
        .chain(program_install_folders(home, read_variable))
        .collect()
}

// Every distinct build `command` names in `folders`, in search order, each with the folder it was
// first found in. Reads the file system, so it runs in `spawn_blocking`.
fn list_builds(
    command: &str,
    folders: Vec<ProgramFolder>,
    spawn_environment: Vec<(String, String)>,
) -> Vec<ProviderCommandSearchHit> {
    let rules = PathRules::NATIVE;
    let mut search_folders = Vec::new();
    for folder in folders.into_iter().flat_map(expand_folder) {
        match folder.into_os_string().into_string() {
            Ok(folder) => search_folders.push(folder),
            // A child's environment holds text alone, so this folder can be on no search path.
            Err(folder) => tracing::warn!(
                folder = %folder.to_string_lossy(),
                "a folder that is not text is not searched for a provider command"
            ),
        }
    }
    // The folders as a `PATH` of their own, searched the way the shell's is; `PATHEXT` and the
    // rest stay the provider's.
    let separator = rules.search_path_separator().to_string();
    let mut environment = spawn_environment;
    remove_environment_names(&mut environment, &["PATH"], rules);
    environment.push(("PATH".to_owned(), search_folders.join(separator.as_str())));
    let mut hits: Vec<ProviderCommandSearchHit> = Vec::new();
    for candidate in find_executables(command, &environment, Path::new(""), &[]) {
        let read = real_path(&candidate).and_then(|build| {
            let facts = file_facts(&build)?;
            Ok((build, facts))
        });
        let (build, facts) = match read {
            Ok(read) => read,
            // Gone between the search and the read: the next candidate is tried.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                tracing::warn!(
                    candidate = %candidate.display(),
                    error = &error as &(dyn Error + 'static),
                    "a provider command found in its install folders could not be resolved, so \
                     it is passed over"
                );
                continue;
            }
        };
        if hits.iter().any(|hit| hit.build == build) {
            continue;
        }
        let folder = candidate
            .parent()
            .and_then(Path::to_str)
            .expect("each folder searched is text, so a candidate's folder is too")
            .to_owned();
        hits.push(ProviderCommandSearchHit {
            build,
            folder,
            stamp: BuildStamp {
                modified: facts.modified,
                size: facts.size,
            },
        });
    }
    hits
}

// The folders one entry stands for: the folder itself, or the child folder of each installed
// version, newest version first. A version manager that is not installed has no folder, which is
// no reason to log.
fn expand_folder(folder: ProgramFolder) -> Vec<PathBuf> {
    let (versions, child) = match folder {
        ProgramFolder::Folder(folder) => return vec![folder],
        ProgramFolder::EachVersion { versions, child } => (versions, child),
    };
    let entries = match std::fs::read_dir(&versions) {
        Ok(entries) => entries,
        Err(error) if is_gone(&error) => return Vec::new(),
        Err(error) => {
            log_unlisted_folder(&versions, &error);
            return Vec::new();
        }
    };
    let mut names: Vec<(Option<Version>, OsString)> = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => {
                let name = entry.file_name();
                names.push((parse_version_folder_name(&name), name));
            }
            Err(error) => log_unlisted_folder(&versions, &error),
        }
    }
    names.sort_by(|(left_version, left_name), (right_version, right_name)| {
        // Newest first; a name that is no version goes after every one that is.
        let by_version = match (left_version, right_version) {
            (Some(left), Some(right)) => right.cmp(left),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        };
        by_version.then_with(|| {
            let (left, right) = (left_name.to_string_lossy(), right_name.to_string_lossy());
            left.encode_utf16().cmp(right.encode_utf16())
        })
    });
    names
        .into_iter()
        .map(|(_, name)| versions.join(name).join(child))
        .collect()
}

// The version a version manager's folder is named for, `v22.11.0` read as 22.11.0.
fn parse_version_folder_name(name: &OsStr) -> Option<Version> {
    let name = name.to_str()?;
    Version::parse(name.strip_prefix('v').unwrap_or(name)).ok()
}

fn log_unlisted_folder(folder: &Path, error: &io::Error) {
    tracing::warn!(
        folder = %folder.display(),
        error = error as &(dyn Error + 'static),
        "a folder could not be listed, so no provider command is looked for in it"
    );
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rstest::rstest;
    use sidekicks_platforms::{
        ProgramFolder, Spawner, StandInAnswer, StandInProgram, write_stand_in_program,
    };

    use super::ProviderCommandSearch;

    // A build's first version read waits this long, past the read's deadline, where a case asks.
    const FIRST_READ_WAIT: Duration = Duration::from_secs(30);

    // Fails when an older build beats a newer one (by folder order or by text order of versions),
    // when a build that prints no version beats one that does, when the later of two builds of
    // equal version wins, or when a read that timed out is kept, so no later search reads that
    // build again. Each build prints its report, its first read first waiting past the deadline
    // where its case says; each search in turn finds the build `winners` names.
    #[rstest]
    #[case::newest_last(&[("tool 1.2.3\n", false), ("tool 1.10.0\n", false)], &[1])]
    #[case::newest_first(&[("tool 2.0.0\n", false), ("tool 1.9.9\n", false)], &[0])]
    #[case::unreadable_first(&[("tool \n", false), ("tool 0.0.1\n", false)], &[1])]
    #[case::equal_versions(&[("tool 1.2.3\n", false), ("tool 1.2.3\n", false)], &[0])]
    #[case::timed_out_read_again(&[("tool 2.0.0\n", true), ("tool 1.0.0\n", false)], &[1, 0])]
    #[tokio::test]
    async fn the_newest_readable_build_wins_and_ties_keep_the_earlier_folder(
        #[case] builds: &[(&str, bool)],
        #[case] winners: &[usize],
    ) {
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let mut folders = Vec::new();
        for (index, (report, is_first_read_slow)) in builds.iter().enumerate() {
            let folder = root.path().join(index.to_string());
            tokio::fs::create_dir(&folder)
                .await
                .expect("the folder is made");
            write_stand_in_program(
                &folder,
                "tool",
                &StandInProgram {
                    answers_by_argument: Vec::new(),
                    otherwise: StandInAnswer {
                        standard_output: (*report).to_owned(),
                        exit_code: 0,
                        argument_record: None,
                        ..StandInAnswer::default()
                    },
                    first_call_wait: is_first_read_slow.then_some(FIRST_READ_WAIT),
                },
            )
            .expect("the build is written");
            folders.push(folder);
        }
        let search = ProviderCommandSearch::new(
            Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts"),
        );
        let environment = vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())];

        for &winner in winners {
            let hit = search
                .find(
                    "tool",
                    folders.iter().cloned().map(ProgramFolder::Folder).collect(),
                    &environment,
                )
                .await
                .expect("the search runs")
                .expect("a build is found");

            assert_eq!(
                Some(hit.folder.as_str()),
                folders[winner].to_str(),
                "{builds:?}"
            );
        }
    }
}
