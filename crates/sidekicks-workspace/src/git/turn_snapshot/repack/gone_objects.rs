//! A pack whose revisions reach an object gone from both the capture folder and the repository:
//! the gone objects are logged and the present ones packed as a bare list, so one gone object never
//! stops every later pack of the folder.

use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;

use super::{CapturePacking, PACK_SIZE_LIMIT_PIN, PATH_WALK_PIN, PackingError, pack_name_base};
use crate::git::cat_file::object_lines;
use crate::git::process::{GitCall, GitError};
use crate::git::turn_snapshot::capture::CORE_FSYNC_PIN;
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, in_git_folder};
use crate::git::turn_snapshot::diagnostics::CaptureDiagnostic;

impl CapturePacking {
    // After the pack of `revisions` into `capture_folder` failed with `failure`, lists every object
    // they reach, the repository attached; when some are gone from both stores, logs them and
    // packs the present ones as a bare list, the repository attached, so what they borrow is
    // copied. Fails with `failure` when nothing is gone, so another cause surfaces as it was, and
    // as the listing or the pack fails.
    pub(super) async fn pack_present_objects(
        &self,
        place: Option<&Place>,
        capture_folder: &CaptureFolder,
        revisions: Vec<u8>,
        failure: GitError,
    ) -> Result<(), PackingError> {
        let folder = capture_folder.folder();
        // A tip gone from both stores is printed missing too, never failed.
        let arguments = in_git_folder(
            folder,
            &[],
            &[
                "rev-list",
                "--objects",
                "--no-object-names",
                "--missing=print",
                "--stdin",
            ],
        );
        let mut listing = GitCall::read(arguments).with_input(revisions);
        for (name, value) in capture_folder.write_environment() {
            listing = listing.with_environment(name, value);
        }
        let output = self.git.run(place, listing).await?;
        let (present, gone) = read_listed_objects(&output.stdout)?;
        if gone.is_empty() {
            return Err(failure.into());
        }
        CaptureDiagnostic::ObjectsGone {
            capture_folder: folder.to_path_buf(),
            objects: gone,
        }
        .warn();
        if present.is_empty() {
            return Ok(());
        }
        let mut arguments = in_git_folder(
            folder,
            &[&CORE_FSYNC_PIN, &PACK_SIZE_LIMIT_PIN, &PATH_WALK_PIN],
            &["pack-objects", "-q", "--non-empty"],
        );
        arguments.push(pack_name_base(folder));
        let mut pack = GitCall::read(arguments).with_input(object_lines(&present));
        for (name, value) in capture_folder.write_environment() {
            pack = pack.with_environment(name, value);
        }
        self.git.run(place, pack).await?;
        Ok(())
    }
}

// The objects `rev-list --missing=print` answered in `stdout`, present and gone: one id per line,
// a gone one after a `?`. Fails with `UnreadableAnswer` on any other line.
fn read_listed_objects(
    stdout: &[u8],
) -> Result<(Vec<GitObjectId>, Vec<GitObjectId>), PackingError> {
    let mut present = Vec::new();
    let mut gone = Vec::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        if line.is_empty() {
            continue;
        }
        let (objects, id) = match line.strip_prefix('?') {
            Some(id) => (&mut gone, id),
            None => (&mut present, line),
        };
        objects.push(
            GitObjectId::new(id.to_owned()).ok_or(PackingError::UnreadableAnswer {
                command: "rev-list",
                reason: "a line is not an object id",
            })?,
        );
    }
    Ok((present, gone))
}
