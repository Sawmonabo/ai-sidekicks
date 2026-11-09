//! The capture folder: a bare repository of the daemon's own, one per owner and repository, that
//! every capture step writes its objects and its ref into, so a capture leaves the repository's own
//! `.git` as it was. The repository is attached to each call by `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
//! never by an `objects/info/alternates` file, so the folder packs alone with nothing attached.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};
use sidekicks_contracts::place::Place;
use sidekicks_platforms::{
    create_new_private_folder, create_private_folder, os_text_bytes, os_text_stable_bytes,
    path_from_program_output, rename_replacing,
};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::file::remove_tree_awaited;
use sidekicks_std::random_hex::random_hex;

use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::{GitCall, GitError, GitRunner};
use crate::git::turn_snapshot::capture::{ObjectFormat, UnrecognizedObjectFormat};
use crate::git::turn_snapshot::capture_steps::joined;

/// The folder under an owner's folder that holds its capture folders.
pub const CAPTURES_SEGMENT: &str = "captures";

/// A git folder's object folder.
pub(crate) const OBJECTS_SEGMENT: &str = "objects";

/// The folder in a capture folder that holds the indexes captures stage into.
const INDEXES_SEGMENT: &str = "indexes";

/// The variable naming the object folder a git call writes into.
const OBJECT_FOLDER_VARIABLE: &str = "GIT_OBJECT_DIRECTORY";

/// The variable listing the object folders a git call also reads.
const ALTERNATE_OBJECT_FOLDERS_VARIABLE: &str = "GIT_ALTERNATE_OBJECT_DIRECTORIES";

/// The random bytes in the name of a capture folder still being made, so two makers never meet.
const PARTIAL_NAME_BYTES: usize = 8;

const SETUP_OPERATION: &str = "making the capture folder";

/// Why a capture folder could not be opened or made.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CaptureFolderError {
    /// A file system call on the folder or the repository's path failed.
    #[error("the capture folder could not be made or reached")]
    Io(#[source] io::Error),
    /// The name of the folder being made could not be drawn.
    #[error("the capture folder being made could not be named")]
    PartialName(#[source] getrandom::Error),
    /// A git call making the folder failed.
    #[error(transparent)]
    Git(#[from] GitError),
    /// git named an object format this code does not know.
    #[error(transparent)]
    ObjectFormat(#[from] UnrecognizedObjectFormat),
    /// Making the folder failed and removing what was made of it failed too.
    #[error(transparent)]
    Setup(Box<CleanupFailures<CaptureFolderError, io::Error>>),
}

/// Where a capture's git calls write: a git folder for the snapshot refs and its object folder for
/// every object, with the repository's object folder attached to each call. A capture folder is
/// named for the sha256 of the repository's common git folder by its real path, so two checkouts
/// of one repository share one folder and a symlinked spelling of it opens the same one.
#[derive(Clone, Debug)]
pub(crate) struct CaptureFolder {
    /// The git folder the snapshot refs are written in.
    folder: PathBuf,
    /// Its object folder, where every capture write lands.
    objects: PathBuf,
    /// The object folder as one quoted entry of git's alternate list.
    objects_alternate: OsString,
    /// The repository's common object folder, which a write reads the history it builds on from,
    /// as one quoted entry of git's alternate list.
    repository_objects: OsString,
}

impl CaptureFolder {
    /// The capture folder of the repository whose common git folder is `repository`, for the
    /// owner whose folder is `owner`: `<owner>/captures/<sha256 hex of the real path>/`, made once
    /// as a bare repository in the repository's object format, with automatic gc and maintenance
    /// off, and reused when present. Fails as git or the file system does.
    pub(crate) async fn open_or_create(
        git: &GitRunner,
        place: Option<&Place>,
        owner: &Path,
        repository: &Path,
    ) -> Result<Self, CaptureFolderError> {
        let (capture_folder, name) = Self::locate(owner, repository)
            .await
            .map_err(CaptureFolderError::Io)?;
        let is_present = tokio::fs::try_exists(&capture_folder.folder)
            .await
            .map_err(CaptureFolderError::Io)?;
        if !is_present {
            let captures = owner.join(CAPTURES_SEGMENT);
            capture_folder
                .create(git, place, repository, &captures, &name)
                .await?;
        }
        Ok(capture_folder)
    }

    /// The capture folder [`open_or_create`](Self::open_or_create) would open for `owner` and the
    /// repository whose common git folder is `repository`, or `None` when it was never made;
    /// nothing is made and no git runs. Fails as the file system does.
    pub(crate) async fn open_existing(owner: &Path, repository: &Path) -> io::Result<Option<Self>> {
        let (capture_folder, _) = Self::locate(owner, repository).await?;
        let is_present = tokio::fs::try_exists(&capture_folder.folder).await?;
        Ok(is_present.then_some(capture_folder))
    }

    // Where the capture folder of `owner` and `repository` is, made or not, and its name.
    async fn locate(owner: &Path, repository: &Path) -> io::Result<(Self, String)> {
        let name = real_path_name(repository).await?;
        let folder = owner.join(CAPTURES_SEGMENT).join(&name);
        Ok((Self::new(folder, &repository.join(OBJECTS_SEGMENT))?, name))
    }

    // The capture folder at the git folder `folder`, attaching the object folder
    // `repository_objects` to its writes.
    fn new(folder: PathBuf, repository_objects: &Path) -> io::Result<Self> {
        let objects = folder.join(OBJECTS_SEGMENT);
        Ok(Self {
            objects_alternate: quote_alternate(&objects)?,
            repository_objects: quote_alternate(repository_objects)?,
            objects,
            folder,
        })
    }

    /// The git folder the snapshot refs are written in and read from.
    pub(crate) fn folder(&self) -> &Path {
        &self.folder
    }

    /// The folder holding the indexes captures stage into; made by the first capture that needs
    /// it.
    pub(crate) fn indexes_folder(&self) -> PathBuf {
        self.folder.join(INDEXES_SEGMENT)
    }

    /// The variables of a write that must see the repository's history: its objects go to this
    /// folder's object folder and the repository's is attached.
    pub(crate) fn write_environment(&self) -> [(&'static str, &OsStr); 2] {
        [
            (OBJECT_FOLDER_VARIABLE, self.objects.as_os_str()),
            (ALTERNATE_OBJECT_FOLDERS_VARIABLE, &self.repository_objects),
        ]
    }

    /// The variable of a call run in the repository that must see the captures: this folder's
    /// object folder attached.
    pub(crate) fn read_environment(&self) -> [(&'static str, &OsStr); 1] {
        [(ALTERNATE_OBJECT_FOLDERS_VARIABLE, &self.objects_alternate)]
    }

    // Makes the folder beside its place under a name no other maker draws, then renames it in, so
    // a maker that stops midway leaves no half-made folder in its place; one another maker put
    // there first is kept.
    async fn create(
        &self,
        git: &GitRunner,
        place: Option<&Place>,
        repository: &Path,
        captures: &Path,
        name: &str,
    ) -> Result<(), CaptureFolderError> {
        let suffix = random_hex(PARTIAL_NAME_BYTES).map_err(CaptureFolderError::PartialName)?;
        let partial = captures.join(format!("{name}.{suffix}.partial"));
        let (parent, made) = (captures.to_path_buf(), partial.clone());
        joined(
            tokio::task::spawn_blocking(move || {
                create_private_folder(&parent)?;
                create_new_private_folder(&made)
            })
            .await,
        )
        .map_err(CaptureFolderError::Io)?;
        let placed = match self.set_up(git, place, repository, &partial).await {
            Ok(()) => {
                let (from, to) = (partial.clone(), self.folder.clone());
                joined(tokio::task::spawn_blocking(move || rename_replacing(&from, &to)).await)
                    .map_err(CaptureFolderError::Io)
            }
            Err(failure) => Err(failure),
        };
        let Err(failure) = placed else {
            return Ok(());
        };
        let removed = remove_tree_awaited(&partial).await;
        // A folder another maker renamed in first is a whole one, so this maker only lost the
        // place to it.
        if removed.is_ok()
            && tokio::fs::try_exists(&self.folder)
                .await
                .map_err(CaptureFolderError::Io)?
        {
            return Ok(());
        }
        Err(CaptureFolderError::Setup(Box::new(CleanupFailures::new(
            failure,
            removed.err().into_iter().collect(),
            SETUP_OPERATION,
        ))))
    }

    // `partial` as a bare repository in the object format of the repository at `repository`, with
    // automatic gc and maintenance off, so nothing packs or prunes the captures but the daemon.
    async fn set_up(
        &self,
        git: &GitRunner,
        place: Option<&Place>,
        repository: &Path,
        partial: &Path,
    ) -> Result<(), CaptureFolderError> {
        let format_read = GitCall::read([
            git_folder_argument(repository),
            "rev-parse".into(),
            "--show-object-format".into(),
        ]);
        let output = git.run(place, format_read).await?;
        let format = ObjectFormat::from_show_object_format(&output.stdout)?;
        // An empty template, so the person's template folder adds no hooks or settings here.
        let init = GitCall::read([
            OsString::from("init"),
            "--quiet".into(),
            "--bare".into(),
            "--template=".into(),
            format!("--object-format={}", format.name()).into(),
            partial.into(),
        ]);
        git.run(place, init).await?;
        for [key, value] in [["gc.auto", "0"], ["maintenance.auto", "false"]] {
            let setting = GitCall::read([
                git_folder_argument(partial),
                "config".into(),
                key.into(),
                value.into(),
            ]);
            git.run(place, setting).await?;
        }
        Ok(())
    }
}

/// The sha256 of `folder`'s real path as lowercase hex, so every spelling of one folder gives one
/// name. Fails as resolving the path does.
pub(crate) async fn real_path_name(folder: &Path) -> io::Result<String> {
    let real_folder = canonical_folder_path(folder).await?;
    Ok(base16ct::lower::encode_string(&Sha256::digest(
        os_text_stable_bytes(real_folder.as_os_str()),
    )))
}

/// `--git-dir=<folder>`, the argument that runs a call against the git folder `folder`.
pub(crate) fn git_folder_argument(folder: &Path) -> OsString {
    let mut argument = OsString::from("--git-dir=");
    argument.push(folder);
    argument
}

/// The arguments of a call against the git folder `folder`: each of `settings` in turn, then
/// `--git-dir=<folder>` and `arguments`.
pub(crate) fn in_git_folder(
    folder: &Path,
    settings: &[&[&str]],
    arguments: &[&str],
) -> Vec<OsString> {
    settings
        .iter()
        .flat_map(|setting| setting.iter().map(OsString::from))
        .chain([git_folder_argument(folder)])
        .chain(arguments.iter().map(OsString::from))
        .collect()
}

// `objects` as one entry of git's alternate list, in the C-style quotes git reads there, so a path
// holding the list's separator or a quote stays one entry. Fails for a path this system cannot
// give as bytes.
fn quote_alternate(objects: &Path) -> io::Result<OsString> {
    let bytes = os_text_bytes(objects.as_os_str())?;
    let mut quoted = Vec::with_capacity(bytes.len() + 2);
    quoted.push(b'"');
    for &byte in bytes.iter() {
        if byte == b'"' || byte == b'\\' {
            quoted.push(b'\\');
        }
        quoted.push(byte);
    }
    quoted.push(b'"');
    path_from_program_output(quoted).map(PathBuf::into_os_string)
}

#[cfg(test)]
mod tests;
