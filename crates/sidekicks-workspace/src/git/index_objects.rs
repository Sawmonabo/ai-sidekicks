//! The objects a git index names, read through git, and which of them an objects folder lacks,
//! read so that git never fetches one.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::Path;

use memchr::memchr;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;

use crate::git::GITLINK_MODE;
use crate::git::cat_file::{
    CatFileAnswerError, ObjectAnswer, object_lines, read_batch_check_answers,
};
use crate::git::process::version::GitFeature;
use crate::git::process::{GitCall, GitError, GitRunner};
use crate::git::turn_snapshot::capture::ObjectFormat;
use crate::git::turn_snapshot::capture_folder::{git_folder_argument, in_git_folder};

/// Why the objects an index names, or the ones an objects folder lacks, could not be read.
#[derive(Debug, thiserror::Error)]
pub enum IndexObjectsError {
    /// A git call failed.
    #[error(transparent)]
    Git(#[from] GitError),
    /// `cat-file`'s answer did not read.
    #[error(transparent)]
    Answer(#[from] CatFileAnswerError),
    /// An entry of the index's listing was not `<mode> <object> <stage>\t<path>`.
    #[error("an entry of git's index listing does not read")]
    UnreadableEntry,
    /// A git before 2.35 expanded a sparse index and said it could not read a folder's tree, so
    /// that folder's entries were left out of the listing.
    #[error("git left entries out of an index it read: {stderr}")]
    EntriesLeftOut {
        /// What git printed on its standard error.
        stderr: String,
    },
    /// The objects asked are of two widths, so no one repository holds them all.
    #[error("the objects asked are of two object formats")]
    TwoObjectFormats,
}

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

/// Lists the index of the repository `location` places git in (`-C <work tree>`, or a git folder
/// with a work tree) with `ls-files --stage -z` and `options`, `GIT_INDEX_FILE` set to
/// `index_file` when given, for a project at `place`, handing each entry to `on_entry`, without
/// its separator, as git prints it. Git fetches no object on any release: `GIT_ALLOW_PROTOCOL` is
/// empty, which allows no transport, and from 2.35 `--sparse` keeps a sparse index's folders as
/// the trees they name. A git before 2.35 expands a sparse index through its trees and leaves out a
/// folder whose tree it cannot read with only an error line, so there any standard error fails the
/// listing with `EntriesLeftOut`; else fails with git's error.
pub(crate) async fn list_stage_entries(
    git: &GitRunner,
    place: Option<&Place>,
    location: Vec<OsString>,
    options: &[&str],
    index_file: Option<&Path>,
    on_entry: impl FnMut(&[u8]),
) -> Result<(), IndexObjectsError> {
    let keeps_sparse_folders = git
        .version(place, GitFeature::LsFilesSparse)
        .await?
        .has(GitFeature::LsFilesSparse);
    let mut arguments = location;
    arguments.extend(["ls-files", "--stage", "-z"].map(OsString::from));
    arguments.extend(options.iter().map(OsString::from));
    if keeps_sparse_folders {
        arguments.push("--sparse".into());
    }
    let mut call = GitCall::read(arguments).with_environment("GIT_ALLOW_PROTOCOL", "");
    if let Some(index_file) = index_file {
        call = call.with_environment("GIT_INDEX_FILE", index_file);
    }
    let stderr = git.run_by_entry(place, call, 0, on_entry).await?;
    if !keeps_sparse_folders && !stderr.is_empty() {
        return Err(IndexObjectsError::EntriesLeftOut { stderr });
    }
    Ok(())
}

/// Every object the index file `index_file` names in its entries and its resolve-undo entries, a
/// gitlink's commit aside, a sparse index's folders as the trees they name. `index_folder` is the
/// folder holding the index's live file (a git folder, or a linked worktree's folder in it), where
/// git finds a split index's shared file; `work_tree` is any folder that exists, since the listing
/// reads no work tree and a `core.worktree` naming a missing folder would fail it. Runs this
/// machine's git and never fetches. Fails as [`list_stage_entries`] does, and with
/// `UnreadableEntry` for an entry that does not read.
pub async fn read_index_objects(
    git: &GitRunner,
    index_folder: &Path,
    index_file: &Path,
    work_tree: &Path,
) -> Result<BTreeSet<GitObjectId>, IndexObjectsError> {
    let mut location = in_git_folder(index_folder, &[&["--no-optional-locks"]], &[]);
    let mut work_tree_argument = OsString::from("--work-tree=");
    work_tree_argument.push(work_tree);
    location.push(work_tree_argument);
    let mut objects = BTreeSet::new();
    let mut is_unreadable = false;
    list_stage_entries(
        git,
        None,
        location,
        &["--resolve-undo"],
        Some(index_file),
        |entry| match read_stage_entry(entry) {
            Some(entry) if entry.mode != GITLINK_MODE => {
                objects.insert(entry.object);
            }
            Some(_) => {}
            None => is_unreadable = true,
        },
    )
    .await?;
    if is_unreadable {
        return Err(IndexObjectsError::UnreadableEntry);
    }
    Ok(objects)
}

/// The ones of `objects` that the objects folder `objects_folder`, with its own `info/alternates`,
/// lacks, read by one `cat-file --batch-check` from a bare repository of the objects' format under
/// `scratch_folder` naming no remote, made there on first need, so git has no promisor remote to
/// fetch from on any release. Runs this machine's git; none asked runs none. Fails with
/// `TwoObjectFormats` for objects of two widths, else with git's error or its answer's.
pub async fn read_absent_objects(
    git: &GitRunner,
    scratch_folder: &Path,
    objects_folder: &Path,
    objects: &[&GitObjectId],
) -> Result<Vec<GitObjectId>, IndexObjectsError> {
    let Some(first) = objects.first() else {
        return Ok(Vec::new());
    };
    let width = first.as_str().len();
    if objects.iter().any(|object| object.as_str().len() != width) {
        return Err(IndexObjectsError::TwoObjectFormats);
    }
    let format = if width == ObjectFormat::Sha1.object_id_hex_length() {
        ObjectFormat::Sha1
    } else {
        ObjectFormat::Sha256
    };
    let reader = scratch_folder.join(format.name());
    // A failed look reads as no repository there; `init` over one is harmless and fails itself
    // where the folder cannot be written.
    if !tokio::fs::try_exists(reader.join("HEAD"))
        .await
        .unwrap_or(false)
    {
        let init = GitCall::read([
            OsString::from("init"),
            "--quiet".into(),
            "--bare".into(),
            "--template=".into(),
            format!("--object-format={}", format.name()).into(),
            reader.clone().into(),
        ]);
        git.run(None, init).await?;
    }
    let check = GitCall::read([
        git_folder_argument(&reader),
        "cat-file".into(),
        "--batch-check".into(),
    ])
    .with_environment("GIT_OBJECT_DIRECTORY", objects_folder)
    .with_environment("GIT_NO_LAZY_FETCH", "1")
    .with_input(object_lines(objects.iter().copied()));
    let output = git.run(None, check).await?;
    let answers = read_batch_check_answers(&output.stdout, objects)?;
    Ok(objects
        .iter()
        .zip(answers)
        .filter(|(_, answer)| *answer == ObjectAnswer::Missing)
        .map(|(object, _)| (*object).clone())
        .collect())
}
