//! Reading `git cat-file`'s batch answers: the ids asked on its standard input, the default
//! `--batch-check` lines read against them, and the `--batch` records walked by their sizes.

use sidekicks_contracts::repo::git_reads::GitObjectId;

/// The word `cat-file` prints in place of a type for a name it cannot resolve.
const MISSING_WORD: &str = "missing";

/// Why a `cat-file` batch answer did not read.
#[derive(Debug, thiserror::Error)]
pub enum CatFileAnswerError {
    /// A line or a record did not read: which one, counted from zero, and why.
    #[error("git cat-file's answer {position} does not read: {reason}")]
    Unreadable {
        /// The line's or the record's place in the answer, counted from zero.
        position: usize,
        /// What was wrong with it.
        reason: &'static str,
    },
    /// The answer held another count of objects than asked.
    #[error("git cat-file answered {answered} objects for the {asked} asked")]
    OtherCount {
        /// The objects asked.
        asked: usize,
        /// The objects answered.
        answered: usize,
    },
    /// An answer named another object than the one asked in its place.
    #[error("git cat-file answered {answered} where {} was asked", .asked.as_str())]
    OtherObject {
        /// The object asked.
        asked: GitObjectId,
        /// The name the answer gave in its place.
        answered: String,
    },
}

/// What `cat-file --batch-check` answers of one object in its default format.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ObjectAnswer {
    /// git has no such object.
    Missing,
    /// The object, its type word and its size in bytes.
    Found {
        /// The type git names, as `blob` or `commit`.
        object_type: String,
        /// The object's size in bytes.
        size: u64,
    },
}

/// One record of a `cat-file --batch` answer, its contents borrowed from the answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BatchRecord<'answer> {
    /// git has no object by the name asked.
    Missing {
        /// The name the record gives.
        id: &'answer str,
    },
    /// An object and its bytes.
    Found {
        /// The object's id.
        id: &'answer str,
        /// The type git names.
        object_type: &'answer str,
        /// The object's bytes, exactly its size.
        contents: &'answer [u8],
    },
}

impl BatchRecord<'_> {
    /// The name the record gives, whether git found the object or not.
    pub(crate) fn id(&self) -> &str {
        match self {
            Self::Missing { id } | Self::Found { id, .. } => id,
        }
    }
}

/// The ids `objects` as `cat-file`'s standard input: each on its own line.
pub(crate) fn object_lines<'a>(objects: impl IntoIterator<Item = &'a GitObjectId>) -> Vec<u8> {
    let mut lines = Vec::new();
    for object in objects {
        lines.extend_from_slice(object.as_str().as_bytes());
        lines.push(b'\n');
    }
    lines
}

/// What `cat-file --batch-check` answered in `stdout` of each of `ids`, in order: one line per id,
/// `<id> <type> <size>` or `<id> missing`, each ending in a line end. Fails with `OtherCount` when
/// the lines are not one per id, `OtherObject` when a line names another id, and `Unreadable` for
/// a line in another form.
pub(crate) fn read_batch_check_answers(
    stdout: &[u8],
    ids: &[&GitObjectId],
) -> Result<Vec<ObjectAnswer>, CatFileAnswerError> {
    let lines = match stdout.strip_suffix(b"\n") {
        Some(lines) => lines.split(|&byte| byte == b'\n').collect(),
        None if stdout.is_empty() => Vec::new(),
        None => {
            return Err(CatFileAnswerError::Unreadable {
                position: memchr::memchr_iter(b'\n', stdout).count(),
                reason: "the last line has no line end",
            });
        }
    };
    if lines.len() != ids.len() {
        return Err(CatFileAnswerError::OtherCount {
            asked: ids.len(),
            answered: lines.len(),
        });
    }
    lines
        .into_iter()
        .zip(ids)
        .enumerate()
        .map(|(position, (line, asked))| {
            let unreadable = |reason| CatFileAnswerError::Unreadable { position, reason };
            let line = std::str::from_utf8(line)
                .ok()
                .ok_or_else(|| unreadable("it is not text"))?;
            let fields: Vec<&str> = line.split(' ').collect();
            let (answered, answer) = match fields.as_slice() {
                [id, MISSING_WORD] => (*id, ObjectAnswer::Missing),
                [id, object_type, size] if !object_type.is_empty() => (
                    *id,
                    ObjectAnswer::Found {
                        object_type: (*object_type).to_owned(),
                        size: read_size(size).ok_or_else(|| unreadable("its size is no number"))?,
                    },
                ),
                _ => return Err(unreadable("it is neither an object nor a missing one")),
            };
            check_answered(asked, answered)?;
            Ok(answer)
        })
        .collect()
}

/// The records of a `cat-file --batch` answer: each `<id> <type> <size>`, a line end, exactly that
/// many bytes and a line end, or `<id> missing` and a line end. The contents are read by the size,
/// never by line ends, since a blob holds any byte. Fails with `Unreadable` on a header in another
/// form, contents shorter than their size, or a missing line end after them.
pub(crate) fn read_batch_records(
    answer: &[u8],
) -> Result<Vec<BatchRecord<'_>>, CatFileAnswerError> {
    let mut records = Vec::new();
    let mut rest = answer;
    while !rest.is_empty() {
        let position = records.len();
        let unreadable = |reason| CatFileAnswerError::Unreadable { position, reason };
        let header_end = rest
            .iter()
            .position(|&byte| byte == b'\n')
            .ok_or_else(|| unreadable("its header has no line end"))?;
        let header = std::str::from_utf8(&rest[..header_end])
            .ok()
            .ok_or_else(|| unreadable("its header is not text"))?;
        let after_header = &rest[header_end + 1..];
        let fields: Vec<&str> = header.split(' ').collect();
        match fields.as_slice() {
            [id, MISSING_WORD] => {
                records.push(BatchRecord::Missing { id });
                rest = after_header;
            }
            [id, object_type, size] if !object_type.is_empty() => {
                let size = read_size(size)
                    .and_then(|size| usize::try_from(size).ok())
                    .ok_or_else(|| unreadable("its size is no number"))?;
                let contents = after_header
                    .get(..size)
                    .ok_or_else(|| unreadable("its contents are shorter than its size"))?;
                rest = after_header[size..]
                    .strip_prefix(b"\n")
                    .ok_or_else(|| unreadable("its contents have no line end after them"))?;
                records.push(BatchRecord::Found {
                    id,
                    object_type,
                    contents,
                });
            }
            _ => {
                return Err(unreadable(
                    "its header is neither an object nor a missing one",
                ));
            }
        }
    }
    Ok(records)
}

/// Fails with `OtherObject` when the answer `answered` names another object than `asked`.
pub(crate) fn check_answered(
    asked: &GitObjectId,
    answered: &str,
) -> Result<(), CatFileAnswerError> {
    if answered == asked.as_str() {
        return Ok(());
    }
    Err(CatFileAnswerError::OtherObject {
        asked: asked.clone(),
        answered: answered.to_owned(),
    })
}

// A size written in decimal digits only, so a sign or a space never reads as one.
fn read_size(size: &str) -> Option<u64> {
    let is_decimal = !size.is_empty() && size.bytes().all(|byte| byte.is_ascii_digit());
    size.parse().ok().filter(|_| is_decimal)
}

#[cfg(test)]
mod tests {
    use super::{BatchRecord, read_batch_records};

    const BLOB_A: &str = "1111111111111111111111111111111111111111";
    const BLOB_B: &str = "2222222222222222222222222222222222222222";
    const GONE: &str = "3333333333333333333333333333333333333333";

    // Fails when the contents are read by line ends (the fake header inside the first blob then
    // reads as a record) or when a blob's last byte is dropped with the line end after it.
    #[test]
    fn batch_records_read_each_blob_by_its_size() {
        let first: Vec<u8> = format!("top\n{BLOB_B} blob 3\nend\n").into_bytes();
        let second: &[u8] = b"\0\xff\n";
        let mut answer = format!("{BLOB_A} blob {}\n", first.len()).into_bytes();
        answer.extend_from_slice(&first);
        answer.push(b'\n');
        answer.extend_from_slice(format!("{BLOB_B} blob {}\n", second.len()).as_bytes());
        answer.extend_from_slice(second);
        answer.push(b'\n');
        answer.extend_from_slice(format!("{GONE} missing\n").as_bytes());

        let records = read_batch_records(&answer).expect("the records read");

        assert_eq!(
            records,
            [
                BatchRecord::Found {
                    id: BLOB_A,
                    object_type: "blob",
                    contents: first.as_slice(),
                },
                BatchRecord::Found {
                    id: BLOB_B,
                    object_type: "blob",
                    contents: second,
                },
                BatchRecord::Missing { id: GONE },
            ]
        );
    }
}
