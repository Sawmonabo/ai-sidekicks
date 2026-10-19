//! Which file-system entry a path names, read without following a link, and its text form; each
//! platform's module reads the identity from one stat or one handle.

use std::fmt;
use std::num::ParseIntError;
use std::str::FromStr;

/// One file-system entry as the system tells entries apart: the device and inode on macOS and
/// Linux, the volume serial and 128-bit file id on Windows. Its text is `<volume>:<file>` in
/// decimal, the form a stored row keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EntryIdentity {
    /// The device (`st_dev`) or the volume serial number.
    pub(crate) volume: u64,
    /// The inode (`st_ino`) or the file id.
    pub(crate) file: u128,
}

/// An entry's identity with whether it is a folder and its other facts, all from the same read,
/// so none can change between them; a link, a junction among them, is never a folder.
#[derive(Clone, Debug)]
pub struct IdentifiedEntry {
    /// Whether the entry is a folder itself, not a link to one.
    pub is_folder: bool,
    /// Which entry it is.
    pub identity: EntryIdentity,
    /// The entry's own facts, never a link's target's: its kind, length and times.
    pub metadata: std::fs::Metadata,
}

/// Text that is not an [`EntryIdentity`]'s `<volume>:<file>` form.
#[derive(Debug, thiserror::Error)]
pub enum NotAnEntryIdentity {
    /// The text holds no `:` between the volume and the file.
    #[error("an entry identity is `<volume>:<file>`, and `{0}` holds no `:`")]
    NoSeparator(String),
    /// The volume or the file is not a decimal number in its range.
    #[error("an entry identity's volume or file is not a number in its range")]
    Number(#[source] ParseIntError),
}

impl fmt::Display for EntryIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}:{}", self.volume, self.file)
    }
}

impl FromStr for EntryIdentity {
    type Err = NotAnEntryIdentity;

    /// Reads an identity back from its `<volume>:<file>` text; refuses text with no `:` and a part
    /// that is not a decimal number in its range.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let (volume, file) = text
            .split_once(':')
            .ok_or_else(|| NotAnEntryIdentity::NoSeparator(text.to_owned()))?;
        Ok(Self {
            volume: volume.parse().map_err(NotAnEntryIdentity::Number)?,
            file: file.parse().map_err(NotAnEntryIdentity::Number)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::EntryIdentity;
    use crate::entry_identity;

    // The folder is renamed away, not removed, so its inode stays in use: ext4 hands a freed inode
    // to the next new entry at once, which would make a removed and remade folder match.
    #[test]
    fn an_identity_holds_across_reads_and_a_rename_and_differs_for_a_new_folder_at_the_path() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let folder = scratch.path().join("staged");
        let moved = scratch.path().join("moved");
        fs::create_dir(&folder).expect("the folder is made");

        let first = entry_identity(&folder).expect("the folder's identity reads");
        let again = entry_identity(&folder).expect("the folder's identity reads again");
        fs::rename(&folder, &moved).expect("the folder is renamed away");
        fs::create_dir(&folder).expect("a new folder is made at the path");
        let after_rename = entry_identity(&moved).expect("the moved folder's identity reads");
        let replaced = entry_identity(&folder).expect("the new folder's identity reads");

        assert!(first.is_folder);
        assert_eq!(first.identity, again.identity);
        assert_eq!(first.identity, after_rename.identity);
        assert_ne!(first.identity, replaced.identity);
        assert_eq!(
            first
                .identity
                .to_string()
                .parse::<EntryIdentity>()
                .expect("the text reads back"),
            first.identity
        );
    }
}
