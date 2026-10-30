//! The environment every git call runs with: the login shell's, cleared of the variables that point
//! git at another repository and pinned to English messages and no prompt, and the git program
//! found along its search path.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use sidekicks_platforms::find_executables;

use super::GIT_TERMINAL_PROMPT_OFF;

/// The variables git reads as this repository's own (`git rev-parse --local-env-vars`), and three
/// more that move where it looks for one; an inherited one would point a call at another
/// repository, index, object store or history. The person's own config files stay theirs.
const STRIPPED_GIT_ENVIRONMENT_NAMES: [&str; 18] = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_NAMESPACE",
];

/// Set on every call after the strip: git's messages in English, which callers read refusals
/// from, and no prompt, which would wait on a terminal the daemon lacks until the timeout.
const PINNED_GIT_ENVIRONMENT: [(&str, &str); 3] =
    [("LC_ALL", "C"), ("LANG", "C"), GIT_TERMINAL_PROMPT_OFF];

/// The first absolute `git` along `environment`'s search path, the person's own (the login
/// shell's on macOS and Linux); a relative entry is passed over, since it would name the daemon's
/// working folder. `None` when there is none. Reads the file system, so it runs on the spawner's
/// thread or in `spawn_blocking`.
pub fn find_git_executable(environment: &[(String, String)]) -> Option<PathBuf> {
    find_executables("git", environment, Path::new(""), &[])
        .find(|candidate| candidate.is_absolute())
}

/// `variables` without the stripped names, compared case-blind since Windows keeps an inherited
/// name's own spelling (`Git_Dir`), then the pinned locale and prompt, then `overrides`; a later
/// pair of the same name replaces an earlier one when the command applies them.
pub(super) fn git_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
    overrides: Vec<(OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    variables
        .into_iter()
        .filter(|(name, _)| {
            !STRIPPED_GIT_ENVIRONMENT_NAMES
                .iter()
                .any(|stripped| name.eq_ignore_ascii_case(stripped))
        })
        .chain(
            PINNED_GIT_ENVIRONMENT
                .iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value))),
        )
        .chain(overrides)
        .collect()
}
