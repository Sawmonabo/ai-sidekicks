//! A file's facts as one read of it tells them, following a link: which entry it is, its size, how
//! many names it has and its two times. Each platform's module reads them from one stat or one
//! handle, which leaves any lock a process holds on the file alone, either by the file's path or
//! through a file already open.

use crate::entry_identity::EntryIdentity;

/// A file's facts from one read: which entry it is, its size, how many names it has, and when its
/// contents and its metadata last changed, each time in nanoseconds since the Unix epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileFacts {
    /// Which entry the file is, the link's target when the path names a link.
    pub identity: EntryIdentity,
    /// Its size in bytes.
    pub size: u64,
    /// How many names the file has, hard links included: `st_nlink`, or Windows' `NumberOfLinks`.
    pub link_count: u64,
    /// When its contents last changed.
    pub modified: i128,
    /// When its contents or its metadata last changed: `st_ctime`, or Windows' `ChangeTime`.
    pub changed: i128,
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};

    use crate::{file_facts, file_facts_of};

    // Fails when the link count is fixed or read apart from the other facts, or when an open file's
    // facts are read through its path, which names another file once one is renamed over it.
    #[test]
    fn a_files_link_count_and_its_open_facts_come_from_one_read_of_that_file() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let path = folder.path().join("file");
        fs::write(&path, b"the first file").expect("the file is written");
        assert_eq!(
            file_facts(&path).expect("the facts read").link_count,
            1,
            "a file with one name"
        );

        fs::hard_link(&path, folder.path().join("second name")).expect("the hard link is made");
        let opened = File::open(&path).expect("the file opens");
        let by_path = file_facts(&path).expect("the facts read by path");
        let by_handle = file_facts_of(&opened).expect("the facts read through the handle");
        assert_eq!(by_path.link_count, 2, "a file with a second name");
        assert_eq!(by_handle, by_path, "both reads tell the same file's facts");

        #[cfg(unix)]
        {
            let replacement = folder.path().join("replacement");
            fs::write(&replacement, b"another file").expect("the replacement is written");
            fs::rename(&replacement, &path).expect("the replacement takes the name");
            assert_eq!(
                file_facts_of(&opened)
                    .expect("the open file's facts read")
                    .identity,
                by_handle.identity,
                "the handle still reads the file it opened"
            );
            assert_ne!(
                file_facts(&path)
                    .expect("the new file's facts read")
                    .identity,
                by_handle.identity,
                "the path now names the replacement"
            );
        }
    }
}
