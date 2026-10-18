//! How an operating system spells, joins and compares a path, and how it names and lists the
//! variables of a process's environment. Both rule sets compile and parse on every system, so a
//! path or a name from either system reads by its own rules, and [`PathRules::NATIVE`] names the
//! running system's.

use std::borrow::Cow;

mod posix;
mod windows;

/// The rules one operating system spells paths and process-environment names by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathRules {
    /// macOS and Linux.
    Posix,
    /// Windows.
    Windows,
}

impl PathRules {
    /// The rules of the system this program runs on, so no caller checks which system that is.
    pub const NATIVE: Self = if cfg!(windows) {
        Self::Windows
    } else {
        Self::Posix
    };

    /// The separator the system writes between a path's components.
    pub fn separator(self) -> char {
        match self {
            Self::Posix => posix::SEPARATOR,
            Self::Windows => windows::SEPARATOR,
        }
    }

    /// Whether `character` separates a path's components: `/` on every system, and `\` on Windows.
    pub fn is_separator(self, character: char) -> bool {
        match self {
            Self::Posix => character == posix::SEPARATOR,
            Self::Windows => windows::is_separator(character),
        }
    }

    /// Whether `path` is rooted, by the system's own reading.
    pub fn is_absolute(self, path: &str) -> bool {
        match self {
            Self::Posix => posix::is_absolute(path),
            Self::Windows => windows::is_absolute(path),
        }
    }

    /// Whether `path` names one complete location. On Windows a rooted path may name no volume
    /// (`\repos`), which the system completes against the program's current drive, so the verdict
    /// would depend on the program's state; such a path is not complete.
    pub fn names_complete_location(self, path: &str) -> bool {
        match self {
            Self::Posix => posix::is_absolute(path),
            Self::Windows => windows::names_complete_location(path),
        }
    }

    /// Whether the system names volumes by drive letters (`C:`), which only Windows does.
    pub fn has_drive_letters(self) -> bool {
        match self {
            Self::Posix => false,
            Self::Windows => true,
        }
    }

    /// Whether `path` is a drive alone (`C:`) naming the drive `base` starts with, compared without
    /// case; never on macOS and Linux, which have no drives.
    pub fn is_drive_of(self, path: &str, base: &str) -> bool {
        match self {
            Self::Posix => false,
            Self::Windows => windows::is_drive_of(path, base),
        }
    }

    /// `path` joined onto `base` with no environment variable and no working folder read, so every
    /// process answers alike: an absolute `path` replaces `base`, and on Windows a drive-relative
    /// one (`D:foo`) takes its own drive, then `base` without its drive, then the rest of itself,
    /// and a bare drive (`D:`) is that drive's root. The result is not folded.
    pub(crate) fn join(self, base: &str, path: &str) -> String {
        match self {
            Self::Posix => posix::join(base, path),
            Self::Windows => windows::join(base, path),
        }
    }

    /// Whether two names that differ only in case name one file, so comparisons lower-case them.
    pub fn has_case_insensitive_names(self) -> bool {
        match self {
            Self::Posix => false,
            Self::Windows => true,
        }
    }

    /// The key two environment names share exactly when the system reads them as one variable: the
    /// name itself on macOS and Linux, and on Windows the name with each character that has a
    /// single upper-case form upper-cased, as the system's ordinal case-blind comparison folds it
    /// (`path` and `PATH` share a key; `ß` stays `ß`).
    pub fn environment_name_key(self, name: &str) -> Cow<'_, str> {
        match self {
            Self::Posix => Cow::Borrowed(name),
            Self::Windows => {
                if name
                    .chars()
                    .all(|character| fold_to_upper_case(character) == character)
                {
                    Cow::Borrowed(name)
                } else {
                    Cow::Owned(name.chars().map(fold_to_upper_case).collect())
                }
            }
        }
    }

    /// The character between the folders of a search-path list such as `PATH`: `:` on macOS and
    /// Linux, `;` on Windows.
    pub fn search_path_separator(self) -> char {
        match self {
            Self::Posix => ':',
            Self::Windows => ';',
        }
    }

    /// Whether a program's output may end a line with `\r\n`; a name never holds the `\r`, since
    /// the system forbids control characters in names.
    pub fn has_carriage_return_line_ends(self) -> bool {
        match self {
            Self::Posix => false,
            Self::Windows => true,
        }
    }
}

/// `character`'s upper-case form where `character` is one UTF-16 unit and its upper-case form is
/// one character, as Windows' upper-case table maps one unit to one; `character` itself otherwise.
fn fold_to_upper_case(character: char) -> char {
    if u32::from(character) > 0xFFFF {
        return character;
    }
    let mut upper = character.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(single), None) => single,
        _ => character,
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

    #[rstest]
    #[case::same_drive(PathRules::Windows, r"C:\proj", "C:foo", r"C:\proj\foo")]
    #[case::same_drive_in_another_case(PathRules::Windows, r"c:\proj", "C:foo", r"C:\proj\foo")]
    #[case::another_drive(
        PathRules::Windows,
        r"C:\base\cwd",
        r"D:path\to\file",
        r"D:\base\cwd\path\to\file"
    )]
    #[case::bare_drive(PathRules::Windows, r"C:\proj", "D:", r"D:\")]
    #[case::bare_drive_on_base_drive(PathRules::Windows, r"C:\proj", "C:", r"C:\")]
    #[case::base_on_no_drive(PathRules::Windows, r"\proj", "D:foo", r"D:\proj\foo")]
    #[case::base_on_a_share(PathRules::Windows, r"\\server\share\x", "D:foo", r"D:\x\foo")]
    #[case::rooted(
        PathRules::Windows,
        r"C:\base\cwd",
        r"\path\to\file",
        r"C:\path\to\file"
    )]
    #[case::absolute(PathRules::Windows, r"C:\proj", r"D:\foo", r"D:\foo")]
    #[case::posix_relative(PathRules::Posix, "/proj", "C:", "/proj/C:")]
    #[case::posix_absolute(PathRules::Posix, "/proj", "/plans", "/plans")]
    fn a_path_joins_onto_its_base_by_its_system_rules(
        #[case] rules: PathRules,
        #[case] base: &str,
        #[case] path: &str,
        #[case] expected: &str,
    ) {
        assert_eq!(rules.join(base, path), expected);
    }

    #[rstest]
    #[case::posix_keeps_case(PathRules::Posix, "path", "PATH", false)]
    #[case::windows_folds_ascii(PathRules::Windows, "path", "PATH", true)]
    #[case::windows_folds_one_to_one(PathRules::Windows, "naïve", "NAÏVE", true)]
    #[case::windows_keeps_a_one_to_many_letter(PathRules::Windows, "straße", "STRASSE", false)]
    fn environment_names_share_a_key_only_where_the_system_reads_one_variable(
        #[case] rules: PathRules,
        #[case] left: &str,
        #[case] right: &str,
        #[case] is_one_variable: bool,
    ) {
        assert_eq!(
            rules.environment_name_key(left) == rules.environment_name_key(right),
            is_one_variable
        );
    }

    #[rstest]
    #[case::the_base_drive(PathRules::Windows, "C:", r"C:\proj", true)]
    #[case::the_base_drive_in_another_case(PathRules::Windows, "c:", r"C:\proj", true)]
    #[case::another_drive(PathRules::Windows, "D:", r"C:\proj", false)]
    #[case::a_drive_and_a_folder(PathRules::Windows, "C:plans", r"C:\proj", false)]
    #[case::a_base_on_a_share(PathRules::Windows, "C:", r"\\server\share\proj", false)]
    #[case::posix(PathRules::Posix, "C:", "C:/proj", false)]
    fn a_bare_drive_names_its_base_drive_only_on_windows(
        #[case] rules: PathRules,
        #[case] path: &str,
        #[case] base: &str,
        #[case] is_drive_of: bool,
    ) {
        assert_eq!(rules.is_drive_of(path, base), is_drive_of);
    }
}
