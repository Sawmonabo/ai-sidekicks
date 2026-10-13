//! How the operating system spells and compares a path, which every folder comparison, the trust
//! envelope and the repo-root resolver follow. Both rule sets compile and parse on every host.

use super::{posix, windows};

/// The path rules of one operating system.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathRules {
    /// macOS and Linux.
    Posix,
    /// Windows.
    Windows,
}

impl PathRules {
    /// The separator between a path's components.
    pub(crate) fn separator(self) -> char {
        match self {
            Self::Posix => posix::SEPARATOR,
            Self::Windows => windows::SEPARATOR,
        }
    }

    /// Whether `path` is rooted, by the system's own reading.
    pub(crate) fn is_absolute(self, path: &str) -> bool {
        match self {
            Self::Posix => posix::is_absolute(path),
            Self::Windows => windows::is_absolute(path),
        }
    }

    /// Whether `path` names one complete location. On Windows a rooted path may name no volume
    /// (`\repos`), which the system completes against the daemon's current drive, so the verdict
    /// would depend on the host's state; such a path is not complete.
    pub(crate) fn names_complete_location(self, path: &str) -> bool {
        match self {
            Self::Posix => posix::is_absolute(path),
            Self::Windows => windows::names_complete_location(path),
        }
    }

    /// Whether two names that differ only in case name one file, so comparisons lower-case them.
    pub(crate) fn has_case_insensitive_names(self) -> bool {
        match self {
            Self::Posix => false,
            Self::Windows => true,
        }
    }

    /// Whether a program's output may end a line with `\r\n`; a name never holds the `\r`, since
    /// the system forbids control characters in names.
    pub(crate) fn has_carriage_return_line_ends(self) -> bool {
        match self {
            Self::Posix => false,
            Self::Windows => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::PathRules;

    #[rstest]
    #[case::posix_root(PathRules::Posix, "/repos/app", true)]
    #[case::posix_relative(PathRules::Posix, "repos/app", false)]
    #[case::windows_drive_root(PathRules::Windows, r"C:\repos", true)]
    #[case::windows_forward_slashes(PathRules::Windows, "C:/repos", true)]
    #[case::windows_share(PathRules::Windows, r"\\server\share\repos", true)]
    #[case::windows_bare_share(PathRules::Windows, r"\\server\share", true)]
    #[case::windows_verbatim_drive(PathRules::Windows, r"\\?\C:\repos", true)]
    #[case::windows_driveless_root(PathRules::Windows, r"\repos", false)]
    #[case::windows_drive_relative(PathRules::Windows, r"C:repos", false)]
    #[case::windows_relative(PathRules::Windows, r"repos\app", false)]
    fn a_complete_location_needs_a_volume_and_a_root(
        #[case] rules: PathRules,
        #[case] path: &str,
        #[case] is_complete: bool,
    ) {
        assert_eq!(rules.names_complete_location(path), is_complete);
    }
}
