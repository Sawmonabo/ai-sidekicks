//! Readers of git's answers to the packing's questions: how many loose objects, packs and garbage
//! files a folder holds, which captures its refs name, whether each base is a commit the repository
//! holds, and whether a ref reaches it. Each refuses an answer in any other form, so no unreadable
//! answer passes for a count, a capture or a reach.

use sidekicks_contracts::repo::git_reads::GitObjectId;

use super::{PackingError, SnapshotPoint};
use crate::git::cat_file::{CatFileAnswerError, ObjectAnswer, read_batch_check_answers};

/// What `count-objects -v` reports of a folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ObjectCounts {
    /// Loose objects (`count:`).
    pub(super) loose: u64,
    /// Packs (`packs:`).
    pub(super) packs: u64,
    /// The files git counts as neither a loose object nor a pack (`garbage:`).
    pub(super) garbage: u64,
}

/// Whether a base names a commit the repository holds, as `cat-file --batch-check` answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum BasePresence {
    /// A commit.
    Commit,
    /// The repository lacks the object.
    Missing,
    /// Another kind of object, named; a tree would read as reached to `rev-list`.
    NotACommit(String),
}

/// The counts in `count-objects -v`'s answer `stdout`: `count:`, `packs:` and `garbage:`, each once
/// and in decimal, any other line ignored. Fails with `UnreadableAnswer` otherwise.
pub(super) fn read_object_counts(stdout: &[u8]) -> Result<ObjectCounts, PackingError> {
    let unreadable = |reason| PackingError::UnreadableAnswer {
        command: "count-objects",
        reason,
    };
    let (mut loose, mut packs, mut garbage): (Option<u64>, Option<u64>, Option<u64>) =
        (None, None, None);
    for line in String::from_utf8_lossy(stdout).lines() {
        let Some((key, value)) = line.split_once(": ") else {
            continue;
        };
        let slot = match key {
            "count" => &mut loose,
            "packs" => &mut packs,
            "garbage" => &mut garbage,
            _ => continue,
        };
        if slot.is_some() {
            return Err(unreadable("a count is repeated"));
        }
        let is_decimal = !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
        let number = value
            .parse()
            .ok()
            .filter(|_| is_decimal)
            .ok_or_else(|| unreadable("a count is not a decimal number"))?;
        *slot = Some(number);
    }
    Ok(ObjectCounts {
        loose: loose.ok_or_else(|| unreadable("the loose count is missing"))?,
        packs: packs.ok_or_else(|| unreadable("the pack count is missing"))?,
        garbage: garbage.ok_or_else(|| unreadable("the garbage count is missing"))?,
    })
}

/// The captures in `for-each-ref --format='%(refname) %(objectname) %(tree) %(parent)'`'s answer
/// `stdout`, and every line that does not read as one: exactly four fields, the first three
/// non-empty and the last three ids of one length, the parent empty for a capture with no base. A
/// tree, a tag or a commit with two parents does not read.
pub(super) fn read_points(stdout: &[u8]) -> (Vec<SnapshotPoint>, Vec<String>) {
    let mut points = Vec::new();
    let mut unreadable = Vec::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        if line.is_empty() {
            continue;
        }
        match read_point(line) {
            Some(point) => points.push(point),
            None => unreadable.push(line.to_owned()),
        }
    }
    (points, unreadable)
}

// One capture's line, `None` when it does not read as one.
fn read_point(line: &str) -> Option<SnapshotPoint> {
    let fields: Vec<&str> = line.split(' ').collect();
    let [ref_name, commit, tree, parent] = fields.as_slice() else {
        return None;
    };
    if ref_name.is_empty() {
        return None;
    }
    let commit = GitObjectId::new((*commit).to_owned())?;
    let tree = GitObjectId::new((*tree).to_owned())?;
    let base = if parent.is_empty() {
        None
    } else {
        let base = GitObjectId::new((*parent).to_owned())?;
        if base.as_str().len() != commit.as_str().len() {
            return None;
        }
        Some(base)
    };
    (tree.as_str().len() == commit.as_str().len()).then_some(SnapshotPoint { commit, tree, base })
}

/// Whether each of `bases` is a commit, from `cat-file --batch-check`'s answer `stdout` to them in
/// order: `<id> commit <size>`, `<id> missing`, or another type. Fails with `UnreadableAnswer` on a
/// line for another id, a line in another form, or a line too few or too many.
pub(super) fn read_bases_present(
    stdout: &[u8],
    bases: &[&GitObjectId],
) -> Result<Vec<BasePresence>, PackingError> {
    let answers = read_batch_check_answers(stdout, bases).map_err(|failure| {
        let reason = match failure {
            CatFileAnswerError::OtherCount { .. } => "it answers a different number of objects",
            CatFileAnswerError::Unreadable { .. } | CatFileAnswerError::OtherObject { .. } => {
                "a line does not answer the base asked"
            }
        };
        PackingError::UnreadableAnswer {
            command: "cat-file",
            reason,
        }
    })?;
    Ok(answers
        .into_iter()
        .map(|answer| match answer {
            ObjectAnswer::Missing => BasePresence::Missing,
            ObjectAnswer::Found { object_type, .. } if object_type == "commit" => {
                BasePresence::Commit
            }
            ObjectAnswer::Found { object_type, .. } => BasePresence::NotACommit(object_type),
        })
        .collect())
}

/// The ids in `stdout` that `command` printed, one per line. Fails with `UnreadableAnswer` for a
/// line that is no id.
pub(super) fn read_object_ids(
    stdout: &[u8],
    command: &'static str,
) -> Result<Vec<GitObjectId>, PackingError> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            GitObjectId::new(line.to_owned()).ok_or(PackingError::UnreadableAnswer {
                command,
                reason: "a line is not an object id",
            })
        })
        .collect()
}

#[cfg(test)]
mod tests;
