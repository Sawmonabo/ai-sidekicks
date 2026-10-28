//! One path written relative to another the way git writes a linked tree's `.git` file and its
//! record's `gitdir` file, so the files the daemon writes read exactly as git's own.

use crate::path::rules::PathRules;

// What git writes for a path that is the base itself.
const SAME_FOLDER: &str = "./";

// What git writes for each folder the result climbs out of, with `/` on every system.
const PARENT_FOLDER: &str = "../";

// The length of a drive prefix (`C:`), which the walk passes over so its case does not count.
const DRIVE_LENGTH: usize = 2;

/// `path` relative to the folder `base`, read by `rules`, as git's `relative_path` writes it: the
/// part of `path` under the folders the two share, after one `../` for each folder of `base`
/// beyond them, `./` when the two are one path, and `path` unchanged when the two have different
/// roots (another drive, or one absolute and one not). Names are compared byte for byte, as git
/// compares them. Both paths come resolved and non-empty, with no `.`, `..` or doubled separator.
pub fn relative_path(rules: PathRules, path: &str, base: &str) -> String {
    let Some(root_length) = shared_root_length(rules, path, base) else {
        return path.to_owned();
    };
    let is_separator = |byte: u8| rules.is_separator(char::from(byte));
    let path_bytes = path.as_bytes();
    let base_bytes = base.as_bytes();
    // `base_index` and `path_index` walk both while they agree; each offset marks the first byte
    // after the last separator run they shared.
    let (mut base_index, mut path_index) = (root_length, root_length);
    let (mut base_offset, mut path_offset) = (0, 0);
    while base_index < base_bytes.len()
        && path_index < path_bytes.len()
        && base_bytes[base_index] == path_bytes[path_index]
    {
        if is_separator(base_bytes[base_index]) {
            base_index = after_separators(base_bytes, base_index, is_separator);
            path_index = after_separators(path_bytes, path_index, is_separator);
            base_offset = base_index;
            path_offset = path_index;
        } else {
            base_index += 1;
            path_index += 1;
        }
    }
    if base_index >= base_bytes.len() && base_offset < base_bytes.len() {
        // All of `base` matched and it ends in a name: `path` is `base`, under it, or a sibling
        // whose name only starts with `base`'s last name (`/a/bbb` against `/a/b`).
        if path_index >= path_bytes.len() {
            path_offset = path_bytes.len();
        } else if is_separator(path_bytes[path_index]) {
            path_offset = after_separators(path_bytes, path_index, is_separator);
        } else {
            base_index = base_offset;
        }
    } else if path_index >= path_bytes.len()
        && path_offset < path_bytes.len()
        && base_bytes
            .get(base_index)
            .is_some_and(|byte| is_separator(*byte))
    {
        // All of `path` matched and `base` goes on below it.
        base_index = after_separators(base_bytes, base_index, is_separator);
        path_offset = path_bytes.len();
    }
    let rest = &path[path_offset..];
    if base_index >= base_bytes.len() {
        return if rest.is_empty() {
            SAME_FOLDER.to_owned()
        } else {
            rest.to_owned()
        };
    }
    let mut relative = String::with_capacity(rest.len() + PARENT_FOLDER.len());
    while base_index < base_bytes.len() {
        if is_separator(base_bytes[base_index]) {
            relative.push_str(PARENT_FOLDER);
            base_index = after_separators(base_bytes, base_index, is_separator);
        } else {
            base_index += 1;
        }
    }
    // `base`'s last name has no separator after it, so it takes its own `../`.
    if base_bytes.last().is_some_and(|byte| !is_separator(*byte)) {
        relative.push_str(PARENT_FOLDER);
    }
    relative.push_str(rest);
    relative
}

// Where the walk starts when `path` and `base` share a root, past a drive both name so the drive
// letter's case does not count; `None` when their roots differ. Two absolute paths share one when
// both name the same drive or both start at a separator; two relative paths always do.
fn shared_root_length(rules: PathRules, path: &str, base: &str) -> Option<usize> {
    match (rules.is_absolute(path), rules.is_absolute(base)) {
        (false, false) => Some(0),
        (true, true) => {
            if path
                .get(..DRIVE_LENGTH)
                .is_some_and(|drive| rules.is_drive_of(drive, base))
            {
                Some(DRIVE_LENGTH)
            } else if path.starts_with(|character| rules.is_separator(character))
                && base.starts_with(|character| rules.is_separator(character))
            {
                Some(0)
            } else {
                None
            }
        }
        (true, false) | (false, true) => None,
    }
}

// The index of the first byte at or after `index` that is not a separator.
fn after_separators(bytes: &[u8], index: usize, is_separator: impl Fn(u8) -> bool) -> usize {
    bytes
        .iter()
        .skip(index)
        .position(|byte| !is_separator(*byte))
        .map_or(bytes.len(), |skipped| index + skipped)
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::relative_path;
    use crate::path::rules::PathRules;

    // The two directions git writes a linked tree's files in. Fails when a sibling sharing a
    // name's start is read as inside (`/a/bbb` under `/a/b`), when a base under the path loses
    // its `../`, when identical paths answer anything but `./`, when the last name of a base gets
    // no `../`, and when two roots that differ (another drive, an absolute path against a
    // relative one) give a climbing path instead of the path unchanged; the Windows cases also
    // fail when a drive's letter case or a `\` separator splits a shared root.
    #[rstest]
    #[case::the_record_under_the_repository(
        PathRules::Posix,
        "/repo/.git/worktrees/one",
        "/repo",
        ".git/worktrees/one"
    )]
    #[case::the_tree_from_its_record(
        PathRules::Posix,
        "/trees/one",
        "/repo/.git/worktrees/one",
        "../../../../trees/one"
    )]
    #[case::a_sibling(PathRules::Posix, "/trees/two", "/trees/one", "../two")]
    #[case::a_name_starting_with_the_base_name(PathRules::Posix, "/a/bbb/c", "/a/b", "../bbb/c")]
    #[case::the_base_under_the_path(PathRules::Posix, "/repo", "/repo/sub/folder", "../../")]
    #[case::identical(PathRules::Posix, "/repo/one", "/repo/one", "./")]
    #[case::absolute_against_relative(PathRules::Posix, "/trees/one", "repo", "/trees/one")]
    #[case::windows_drive_in_another_case(
        PathRules::Windows,
        r"c:\repo\.git\worktrees\one",
        r"C:\trees\one",
        r"../../repo\.git\worktrees\one"
    )]
    #[case::windows_nested(PathRules::Windows, "C:/repo/.git", "c:/repo", ".git")]
    #[case::windows_another_drive(
        PathRules::Windows,
        r"D:\trees\one",
        r"C:\repo\.git\worktrees\one",
        r"D:\trees\one"
    )]
    #[case::windows_a_share_against_a_drive(
        PathRules::Windows,
        r"\\server\share\one",
        r"C:\repo",
        r"\\server\share\one"
    )]
    fn a_path_is_written_relative_to_its_base_as_git_writes_it(
        #[case] rules: PathRules,
        #[case] path: &str,
        #[case] base: &str,
        #[case] expected: &str,
    ) {
        assert_eq!(relative_path(rules, path, base), expected);
    }
}
