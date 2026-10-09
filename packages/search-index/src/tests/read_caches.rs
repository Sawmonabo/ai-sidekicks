//! Held searches' read caches stay within their bound together: past it, the cache of the search
//! paged least recently is emptied first, and the other searches keep theirs.

use std::fs;
use std::ops::Range;
use std::path::Path;
use std::sync::Arc;

use tantivy::Directory;

use crate::directory::{FolderDirectory, ReadCache, ReadCaches, ReadMode};

use super::support::ScratchFolder;

const MEBIBYTE: usize = 1024 * 1024;

#[test]
fn the_search_paged_least_recently_is_emptied_first() {
    let folder = ScratchFolder::new("read-caches");
    fs::create_dir_all(folder.path()).expect("the folder is made");
    let file_name = Path::new("ranges");
    let file_path = folder.path().join(file_name);
    fs::write(&file_path, vec![1u8; 33 * MEBIBYTE]).expect("the file is written");
    let directory =
        FolderDirectory::open(folder.path(), ReadMode::Positioned).expect("the folder opens");
    let file = directory
        .get_file_handle(file_name)
        .expect("the file opens");
    let caches = Arc::new(ReadCaches::default());
    let [first, second, third] = [(); 3].map(|()| Arc::new(ReadCaches::open_cache(&caches)));
    let read = |cache: &Arc<ReadCache>, range: Range<usize>| -> u8 {
        let _reading = ReadCache::enter(cache);
        file.read_bytes(range).expect("the range reads").as_slice()[0]
    };
    let mebibytes = |from: usize, to: usize| from * MEBIBYTE..to * MEBIBYTE;

    // Two searches fill their 16 MiB each, then the first pages again from its cache.
    read(&first, mebibytes(0, 8));
    read(&first, mebibytes(8, 16));
    read(&second, mebibytes(16, 24));
    read(&second, mebibytes(24, 32));
    read(&first, mebibytes(0, 8));
    // The file changes under the caches, so a cached range reads as it was and a range read from
    // the file again reads as it is now.
    fs::write(&file_path, vec![2u8; 33 * MEBIBYTE]).expect("the file is rewritten");
    // A third search's range passes the 32 MiB every cache holds together.
    read(&third, mebibytes(32, 33));

    assert_eq!(
        read(&first, mebibytes(8, 16)),
        1,
        "the first search keeps its cache"
    );
    assert_eq!(
        read(&second, mebibytes(16, 24)),
        2,
        "the second search's cache was emptied"
    );
}
