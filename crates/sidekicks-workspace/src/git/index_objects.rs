//! The objects a git index names, read through git, and which of them an objects folder lacks,
//! read so that git never fetches one.

use memchr::memchr;
use sidekicks_contracts::repo::git_reads::GitObjectId;

/// One entry of an `ls-files --stage` listing, `<mode> <object> <stage>\t<path>`, borrowed from it.
pub(crate) struct StageEntry<'entry> {
    /// The mode git records, six octal digits as printed.
    pub(crate) mode: &'entry str,
    /// The object the entry names.
    pub(crate) object: GitObjectId,
    /// The path, bytes as printed.
    pub(crate) path: &'entry [u8],
}

/// The entry `entry` of an `ls-files --stage` listing, without its separator; `None` when it is not
/// in that form or its object is no object id.
pub(crate) fn read_stage_entry(entry: &[u8]) -> Option<StageEntry<'_>> {
    let tab = memchr(b'\t', entry)?;
    let (header, path) = entry.split_at(tab);
    let mut fields = std::str::from_utf8(header).ok()?.split(' ');
    let (Some(mode), Some(object), Some(_stage), None) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return None;
    };
    Some(StageEntry {
        mode,
        object: GitObjectId::new(object.to_owned())?,
        path: &path[1..],
    })
}
