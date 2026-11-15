//! A command's before-images: the bytes each changed file held before the command, read from the
//! before-capture's folder in groups whose answer stays within a bound, so the daemon holds about
//! one group at a time. Every read runs against the capture folder with the repository's objects
//! attached, so it works once the worktree is gone.

use std::ops::Range;

use bytes::Bytes;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;

use super::CommandCaptureService;
use crate::git::cat_file::{
    BatchRecord, CatFileAnswerError, ObjectAnswer, check_answered, object_lines,
    read_batch_check_answers, read_batch_records,
};
use crate::git::process::{GitCall, GitError, GitRunner};
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, in_git_folder};
use crate::git::turn_snapshot::refs::USE_REPLACE_REFS_PIN;
use crate::git::turn_snapshot::repack::CapturedCommit;

/// The type word git gives a file's object.
const BLOB_TYPE: &str = "blob";

/// The most of the blobs' bytes one group's answer holds.
const READ_GROUP_CONTENT_BYTES: u64 = 16 * 1024 * 1024;

/// The longest frame git puts around a blob's bytes: a 64-digit id, the type word, a 20-digit
/// size, two separators and two line ends.
const LONGEST_RECORD_FRAME_BYTES: u64 = 64 + BLOB_TYPE.len() as u64 + 20 + 2 + 2;

/// The most one group's answer holds; a blob whose answer alone passes it is never read.
const READ_GROUP_BYTES: u64 = READ_GROUP_CONTENT_BYTES + LONGEST_RECORD_FRAME_BYTES;

/// What a file held before the command, as its blob in the before-capture reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BeforeImage {
    /// The blob's bytes.
    Read(Bytes),
    /// git has no such object.
    Missing,
    /// The blob's answer alone would pass the read bound, so it was not read.
    OverBound {
        /// The blob's size in bytes.
        size: u64,
    },
}

/// Why a before-image read failed.
#[derive(Debug, thiserror::Error)]
pub enum BeforeImageReadError {
    /// A git call failed.
    #[error(transparent)]
    Git(#[from] GitError),
    /// git's answer did not read.
    #[error(transparent)]
    Answer(#[from] CatFileAnswerError),
    /// An id named an object that is not a blob, so it is no file's bytes.
    #[error("{} is a {object_type}, not a file's blob", .id.as_str())]
    NotABlob {
        /// The id asked.
        id: GitObjectId,
        /// The type git named.
        object_type: String,
    },
}

/// A command's before-images still to read, one group of blobs at a time, in the order asked.
pub struct BeforeImages<'read> {
    /// The daemon's git.
    git: &'read GitRunner,
    /// Where git runs for the project.
    place: Option<&'read Place>,
    /// The before-capture's folder, which holds or borrows every blob.
    capture_folder: &'read CaptureFolder,
    /// Each id asked and what git answered of it, in the order asked.
    answers: Vec<(GitObjectId, ObjectAnswer)>,
    /// The groups still to read, as ranges of `answers`.
    groups: std::vec::IntoIter<Range<usize>>,
}

impl CommandCaptureService {
    /// Sizes the blobs `blobs` in the before-capture whose objects are `objects`, running git for
    /// the project at `place`, and plans their read in groups. Fails when git fails, its answer
    /// does not read, or an id names an object that is not a blob.
    pub async fn read_before_images<'read>(
        &'read self,
        place: Option<&'read Place>,
        objects: &'read CapturedCommit,
        blobs: Vec<GitObjectId>,
    ) -> Result<BeforeImages<'read>, BeforeImageReadError> {
        let capture_folder = objects.capture_folder();
        let answers = if blobs.is_empty() {
            Vec::new()
        } else {
            let call = cat_file_call(capture_folder, "--batch-check", object_lines(&blobs));
            let output = self.git.run(place, call).await?;
            let ids: Vec<&GitObjectId> = blobs.iter().collect();
            read_batch_check_answers(&output.stdout, &ids)?
        };
        for (id, answer) in blobs.iter().zip(&answers) {
            if let ObjectAnswer::Found { object_type, .. } = answer
                && object_type != BLOB_TYPE
            {
                return Err(BeforeImageReadError::NotABlob {
                    id: id.clone(),
                    object_type: object_type.clone(),
                });
            }
        }
        let answers: Vec<(GitObjectId, ObjectAnswer)> = blobs.into_iter().zip(answers).collect();
        let groups = plan_batches(&answers, READ_GROUP_BYTES).into_iter();
        Ok(BeforeImages {
            git: &self.git,
            place,
            capture_folder,
            answers,
            groups,
        })
    }
}

impl BeforeImages<'_> {
    /// The next group's before-images, each with its id in the order asked, or `None` once every
    /// group is read; a group holding only missing or over-bound blobs runs no git. Fails when git
    /// fails, its answer does not read, or a blob read back is not one.
    pub async fn next_batch(
        &mut self,
    ) -> Result<Option<Vec<(GitObjectId, BeforeImage)>>, BeforeImageReadError> {
        let Some(group) = self.groups.next() else {
            return Ok(None);
        };
        let entries = &self.answers[group];
        let asked: Vec<&GitObjectId> = entries
            .iter()
            .filter(|(id, answer)| read_bytes(id, answer, READ_GROUP_BYTES).is_some())
            .map(|(id, _)| id)
            .collect();
        let answer = if asked.is_empty() {
            Bytes::new()
        } else {
            let ids = object_lines(asked.iter().copied());
            let call = cat_file_call(self.capture_folder, "--batch", ids);
            Bytes::from(self.git.run(self.place, call).await?.stdout)
        };
        let records = read_batch_records(&answer)?;
        if records.len() != asked.len() {
            return Err(CatFileAnswerError::OtherCount {
                asked: asked.len(),
                answered: records.len(),
            }
            .into());
        }
        let mut records = records.into_iter();
        let mut images = Vec::with_capacity(entries.len());
        for (id, object_answer) in entries {
            let image = match object_answer {
                ObjectAnswer::Missing => BeforeImage::Missing,
                ObjectAnswer::Found { size, .. }
                    if read_bytes(id, object_answer, READ_GROUP_BYTES).is_none() =>
                {
                    BeforeImage::OverBound { size: *size }
                }
                ObjectAnswer::Found { .. } => {
                    let record = records
                        .next()
                        .expect("one record per id asked, the count checked above");
                    check_answered(id, record.id())?;
                    match record {
                        // Gone since it was sized, as a gc in the repository can take it.
                        BatchRecord::Missing { .. } => BeforeImage::Missing,
                        BatchRecord::Found {
                            object_type: BLOB_TYPE,
                            contents,
                            ..
                        } => BeforeImage::Read(answer.slice_ref(contents)),
                        BatchRecord::Found { object_type, .. } => {
                            return Err(BeforeImageReadError::NotABlob {
                                id: id.clone(),
                                object_type: object_type.to_owned(),
                            });
                        }
                    }
                }
            };
            images.push((id.clone(), image));
        }
        Ok(Some(images))
    }
}

// A `cat-file` call in `mode` against the capture folder with the repository's objects attached
// and replace refs off, the ids on its input and its answer buffered.
fn cat_file_call(capture_folder: &CaptureFolder, mode: &str, ids: Vec<u8>) -> GitCall {
    let arguments = in_git_folder(
        capture_folder.folder(),
        &[&USE_REPLACE_REFS_PIN],
        &["cat-file", mode, "--buffer"],
    );
    let mut call = GitCall::read(arguments).with_input(ids);
    for (name, value) in capture_folder.write_environment() {
        call = call.with_environment(name, value);
    }
    call
}

// The groups the read runs, as ranges covering every entry in order: each group's blobs answer in
// at most `bound` bytes. A missing blob and one whose answer alone passes `bound` ride in the
// group they fall in and count nothing, since neither is read.
fn plan_batches(answers: &[(GitObjectId, ObjectAnswer)], bound: u64) -> Vec<Range<usize>> {
    let mut groups = Vec::new();
    let (mut start, mut group_bytes) = (0, 0);
    for (position, (id, answer)) in answers.iter().enumerate() {
        let bytes = read_bytes(id, answer, bound).unwrap_or(0);
        if group_bytes + bytes > bound {
            groups.push(start..position);
            (start, group_bytes) = (position, 0);
        }
        group_bytes += bytes;
    }
    if start < answers.len() {
        groups.push(start..answers.len());
    }
    groups
}

// The bytes `--batch` answers a found blob in, its header and its line ends counted, or `None` when
// it is missing or that passes `bound`, so it is not read.
fn read_bytes(id: &GitObjectId, answer: &ObjectAnswer, bound: u64) -> Option<u64> {
    let ObjectAnswer::Found { object_type, size } = answer else {
        return None;
    };
    let digits = u64::from(size.checked_ilog10().unwrap_or(0) + 1);
    let frame = id.as_str().len() as u64 + object_type.len() as u64 + digits + 2 + 2;
    Some(size.saturating_add(frame)).filter(|&bytes| bytes <= bound)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ops::Range;
    use std::path::PathBuf;
    use std::sync::Arc;

    use bytes::Bytes;
    use rstest::rstest;
    use sidekicks_contracts::repo::git_reads::GitObjectId;
    use sidekicks_std::keyed_lock::KeyedLock;

    use super::{BeforeImage, BeforeImageReadError, BeforeImages, plan_batches};
    use crate::git::cat_file::ObjectAnswer;
    use crate::git::process::test_git_runner;
    use crate::git::process::test_repository::{commit_empty, git_in, make_test_repository};
    use crate::git::turn_snapshot::capture::GitFloorReports;
    use crate::git::turn_snapshot::command_capture::tests::{command_in, write_files};
    use crate::git::turn_snapshot::command_capture::{CommandCaptureService, TreeChange};
    use crate::git::turn_snapshot::repack::CapturePacking;

    const SHA1: &str = "1111111111111111111111111111111111111111";
    const MADE_UP: &str = "0123456789abcdef0123456789abcdef01234567";

    fn object(id: &str) -> GitObjectId {
        GitObjectId::new(id.to_owned()).expect("the test's id is valid")
    }

    // Every image left to read, in order.
    async fn read_all(images: &mut BeforeImages<'_>) -> Vec<(GitObjectId, BeforeImage)> {
        let mut read = Vec::new();
        while let Some(batch) = images.next_batch().await.expect("the batch reads") {
            read.extend(batch);
        }
        read
    }

    // A 40-digit id with a two-digit size answers in the size plus 50 bytes, so each of these
    // sizes costs itself plus 50. Fails when a group passes the bound, a blob is dropped or
    // repeated at a group's edge, or a missing or over-bound blob counts toward its group.
    #[rstest]
    #[case::every_blob_in_one_group(&[Some(10), Some(20), Some(30)], 300, &[(0, 3)])]
    #[case::a_group_closes_at_the_bound(&[Some(10), Some(20), Some(30)], 130, &[(0, 2), (2, 3)])]
    #[case::a_blob_alone_fills_a_group(&[Some(10), Some(10), Some(10)], 60, &[(0, 1), (1, 2), (2, 3)])]
    #[case::an_over_bound_blob_between_two(&[Some(10), Some(99), Some(20)], 130, &[(0, 3)])]
    #[case::missing_blobs(&[Some(10), None, Some(20), None, Some(30)], 130, &[(0, 4), (4, 5)])]
    fn blobs_are_planned_in_groups_within_the_bound(
        #[case] sizes: &[Option<u64>],
        #[case] bound: u64,
        #[case] expected: &[(usize, usize)],
    ) {
        let answers: Vec<(GitObjectId, ObjectAnswer)> = sizes
            .iter()
            .map(|size| {
                let answer = match size {
                    Some(size) => ObjectAnswer::Found {
                        object_type: "blob".to_owned(),
                        size: *size,
                    },
                    None => ObjectAnswer::Missing,
                };
                (object(SHA1), answer)
            })
            .collect();

        let expected: Vec<Range<usize>> = expected.iter().map(|&(start, end)| start..end).collect();
        assert_eq!(plan_batches(&answers, bound), expected);
    }

    // Fails when the read takes the after tree's blobs, or the repository's HEAD in place of the
    // capture (the untracked file's before blob is only in the capture folder, the tracked ones
    // only in the repository's objects).
    #[tokio::test]
    async fn before_images_read_every_changed_blob_of_a_command() {
        let git = test_git_runner();
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let repository = make_test_repository(&git, root.path(), "repository").await;
        let before_files = [
            ("a.txt", "a before\n"),
            ("src/b.txt", "b before\n"),
            ("gone.txt", "gone before\n"),
        ];
        write_files(&repository, &before_files);
        git_in(&git, &repository, &["add", "-A"]).await;
        commit_empty(&git, &repository, "base").await;
        write_files(&repository, &[("untracked.txt", "untracked before\n")]);
        let owner = root.path().join("owner");
        let service = CommandCaptureService::new(
            git.clone(),
            Arc::new(KeyedLock::new()),
            Arc::new(CapturePacking::new(
                git.clone(),
                Arc::new(GitFloorReports::default()),
            )),
            Arc::new(GitFloorReports::default()),
        );
        let input = command_in(&repository, &owner);

        let before = service
            .capture_before(None, &input)
            .await
            .expect("the before-capture is taken");
        write_files(
            &repository,
            &[
                ("a.txt", "a after\n"),
                ("src/b.txt", "b after\n"),
                ("untracked.txt", "untracked after\n"),
            ],
        );
        std::fs::remove_file(repository.join("gone.txt")).expect("the file is removed");
        let after = service
            .capture_after(None, &input, &before.tree)
            .await
            .expect("the after-capture is taken");
        let (paths, blobs): (Vec<PathBuf>, Vec<GitObjectId>) = after
            .changes
            .iter()
            .filter_map(|change| match change {
                TreeChange::Deleted { path, before }
                | TreeChange::Modified { path, before, .. }
                | TreeChange::TypeChanged { path, before, .. } => {
                    Some((path.clone(), before.object.clone()))
                }
                TreeChange::Added { .. } => None,
            })
            .unzip();
        let mut images = service
            .read_before_images(None, &before.objects, blobs.clone())
            .await
            .expect("the blobs are sized");
        let read = read_all(&mut images).await;

        assert_eq!(
            read.iter().map(|(id, _)| id).collect::<Vec<_>>(),
            blobs.iter().collect::<Vec<_>>()
        );
        let by_path: BTreeMap<PathBuf, BeforeImage> = paths
            .into_iter()
            .zip(read.into_iter().map(|(_, image)| image))
            .collect();
        let expected: BTreeMap<PathBuf, BeforeImage> = before_files
            .iter()
            .chain(&[("untracked.txt", "untracked before\n")])
            .map(|(path, text)| {
                let image = BeforeImage::Read(Bytes::copy_from_slice(text.as_bytes()));
                (PathBuf::from(*path), image)
            })
            .collect();
        assert_eq!(by_path, expected);
    }

    // Fails when one missing object fails the whole read, or when a tree's bytes are read as a
    // file's.
    #[tokio::test]
    async fn a_missing_blob_reads_missing_and_the_rest_still_read() {
        let git = test_git_runner();
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let repository = make_test_repository(&git, root.path(), "repository").await;
        write_files(&repository, &[("a.txt", "a\n"), ("b.txt", "b\n")]);
        let owner = root.path().join("owner");
        let service = CommandCaptureService::new(
            git.clone(),
            Arc::new(KeyedLock::new()),
            Arc::new(CapturePacking::new(
                git.clone(),
                Arc::new(GitFloorReports::default()),
            )),
            Arc::new(GitFloorReports::default()),
        );
        let before = service
            .capture_before(None, &command_in(&repository, &owner))
            .await
            .expect("the before-capture is taken");
        let a_blob = object(&git_in(&git, &repository, &["hash-object", "a.txt"]).await);
        let b_blob = object(&git_in(&git, &repository, &["hash-object", "b.txt"]).await);
        let asked = vec![a_blob.clone(), object(MADE_UP), b_blob.clone()];

        let mut images = service
            .read_before_images(None, &before.objects, asked)
            .await
            .expect("the blobs are sized");
        let read = read_all(&mut images).await;
        let tree_read = service
            .read_before_images(None, &before.objects, vec![before.tree.clone()])
            .await;

        assert_eq!(
            read,
            [
                (a_blob, BeforeImage::Read(Bytes::from_static(b"a\n"))),
                (object(MADE_UP), BeforeImage::Missing),
                (b_blob, BeforeImage::Read(Bytes::from_static(b"b\n"))),
            ]
        );
        assert!(
            matches!(
                &tree_read,
                Err(BeforeImageReadError::NotABlob { id, object_type })
                    if *id == before.tree && object_type == "tree"
            ),
            "the tree is refused, got {:?}",
            tree_read.as_ref().err()
        );
    }
}
