//! How an operating system spells, joins and compares a path, how it names and lists the
//! variables of a process's environment, and how its command shell reads a word. Both rule sets
//! compile and parse on every system, so a path, a name or a shell's word for either system is
//! written by its own rules, and [`PathRules::NATIVE`] names the running system's. Windows' rules
//! also hold `command_line`, a program's command line as Windows takes it and its bound, which
//! compiles on Windows and under `test`.

use std::borrow::Cow;
use std::ffi::OsStr;
use std::path::Path;

mod posix;
pub(crate) mod windows;

/// The rules one operating system spells paths and process-environment names by, and the ones its
/// command shell (`sh` on macOS and Linux, `cmd.exe` on Windows) reads a word by.
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

    /// Whether two names that differ only in case name one file, so comparisons fold their case.
    pub fn has_case_insensitive_names(self) -> bool {
        match self {
            Self::Posix => false,
            Self::Windows => true,
        }
    }

    /// `path`'s components in the form two paths are compared in, one element each, a Windows
    /// drive or share first, so a containment check never reaches across volumes: on macOS and
    /// Linux each name byte for byte, since a lossy fold would make two names that are not UTF-8
    /// one; on Windows each UTF-8 component folded as [`environment_name_key`] folds a name, and
    /// one that is not UTF-8 as it stands. `path` is read by the running system's rules.
    ///
    /// [`environment_name_key`]: Self::environment_name_key
    pub fn comparable_components(self, path: &Path) -> Vec<Cow<'_, OsStr>> {
        path.components()
            .map(|component| {
                let name = component.as_os_str();
                match (self, name.to_str()) {
                    (Self::Windows, Some(text)) => match self.environment_name_key(text) {
                        Cow::Borrowed(_) => Cow::Borrowed(name),
                        Cow::Owned(folded) => Cow::Owned(folded.into()),
                    },
                    (Self::Windows, None) | (Self::Posix, _) => Cow::Borrowed(name),
                }
            })
            .collect()
    }

    /// Whether `path` names a place strictly inside `folder`, read lexically with no link
    /// followed and compared by [`comparable_components`], so a sibling that shares a prefix
    /// (`/repo-old` beside `/repo`) and the folder itself are not inside it. Both paths come
    /// folded, `.` and `..` resolved away, as [`resolve_path_against`] gives them.
    ///
    /// [`comparable_components`]: Self::comparable_components
    /// [`resolve_path_against`]: crate::resolve_path_against
    pub fn is_within(self, folder: &Path, path: &Path) -> bool {
        let folder = self.comparable_components(folder);
        let path = self.comparable_components(path);
        path.len() > folder.len() && path.starts_with(&folder)
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

    /// The value `environment` gives the variable `name`, read as the system reads it: the last
    /// pair whose name shares `name`'s [`environment_name_key`](Self::environment_name_key), since
    /// a later pair wins when a child's environment is set; `None` where no pair names it.
    pub fn environment_value<'e>(
        self,
        environment: &'e [(String, String)],
        name: &str,
    ) -> Option<&'e str> {
        let key = self.environment_name_key(name);
        environment
            .iter()
            .rev()
            .find(|(pair_name, _)| self.environment_name_key(pair_name) == key)
            .map(|(_, value)| value.as_str())
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

    /// The environment variable naming the person's home folder: `HOME` on macOS and Linux,
    /// `USERPROFILE` on Windows. It goes by the place a process runs in, so a WSL distribution
    /// reads `HOME` through [`PathRules::Posix`].
    pub fn home_environment_name(self) -> &'static str {
        match self {
            Self::Posix => "HOME",
            Self::Windows => "USERPROFILE",
        }
    }

    /// `word` written so the system's command shell hands it to the program exactly: single-quoted
    /// for `sh`, and for a `cmd.exe /c` line on Windows. Fails with [`ShellWordRefused`] only on
    /// Windows, for a word holding a line break.
    pub fn quote_shell_word(self, word: &str) -> Result<String, ShellWordRefused> {
        match self {
            Self::Posix => Ok(posix::quote_shell_word(word)),
            Self::Windows => windows::quote_shell_word(word),
        }
    }
}

/// A word the system's command shell cannot be given exactly: on Windows a `\r` or `\n`, where
/// `cmd.exe` ends the line.
#[derive(Debug, thiserror::Error)]
#[error("a line break cannot be written into a Windows command line")]
pub struct ShellWordRefused;

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
    use std::path::Path;

    use rstest::rstest;

    use super::PathRules;

    // Fails when containment compares text prefixes, admits the folder itself, or stops folding
    // case on Windows.
    #[rstest]
    #[case::inside(PathRules::Posix, "/repo", "/repo/src/main.rs", true)]
    #[case::the_folder_itself(PathRules::Posix, "/repo", "/repo", false)]
    #[case::a_sibling_sharing_a_prefix(PathRules::Posix, "/repo", "/repo-old/main.rs", false)]
    #[case::posix_keeps_case(PathRules::Posix, "/repo", "/Repo/main.rs", false)]
    #[case::windows_folds_case(PathRules::Windows, "/repo", "/REPO/Main.rs", true)]
    fn is_within_holds_only_a_path_strictly_inside_the_folder(
        #[case] rules: PathRules,
        #[case] folder: &str,
        #[case] path: &str,
        #[case] is_within: bool,
    ) {
        assert_eq!(
            rules.is_within(Path::new(folder), Path::new(path)),
            is_within
        );
    }

    // Fails when the `'` escape, the `%` escape or the `"` doubling is dropped.
    #[rstest]
    #[case::posix(PathRules::Posix, "it's 100%", Some(r"'it'\''s 100%'"))]
    #[case::windows_quote_and_percent(
        PathRules::Windows,
        r#"say "hi" 100%PATH%"#,
        Some(r#""say ""hi"" 100%%cd:~,%PATH%%cd:~,%""#)
    )]
    #[case::windows_trailing_backslash(PathRules::Windows, r"C:\a b\", Some(r#""C:\a b\\""#))]
    #[case::windows_empty(PathRules::Windows, "", Some(r#""""#))]
    #[case::windows_line_break(PathRules::Windows, "a\nb", None)]
    fn quote_shell_word_hands_the_program_the_word_exactly(
        #[case] rules: PathRules,
        #[case] word: &str,
        #[case] expected: Option<&str>,
    ) {
        assert_eq!(rules.quote_shell_word(word).ok().as_deref(), expected);
    }

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
