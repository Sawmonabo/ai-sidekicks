//! A scratch volume on macOS: a small APFS disk image made and attached at a folder with
//! `diskutil`, which needs no root, and ejected when the test is done.

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use tempfile::TempDir;

use crate::scratch_volume::ScratchVolume;

// The program that makes, attaches and ejects disk images, by its full path so no `PATH` entry
// stands in for it.
const DISKUTIL_PROGRAM: &str = "/usr/sbin/diskutil";

// Room enough for a few small trees.
const IMAGE_SIZE: &str = "64m";

// The image file's name inside its own temporary folder.
const IMAGE_NAME: &str = "scratch.dmg";

/// An attached scratch image and the folders it and its mount sit in, ejected and removed when
/// dropped.
pub(crate) struct ImageAttachment {
    // The whole image's device (`/dev/disk4`), which the eject names.
    device: String,
    // Removed after the eject, the mount folder with it.
    _root: TempDir,
    _image_folder: TempDir,
}

/// Makes a scratch APFS image and attaches it at `mount_at` under a fresh root folder, hidden from
/// the Finder. Panics when the image cannot be made, even on a second try, or attached.
pub(crate) fn attach_scratch_volume(mount_at: &Path) -> ScratchVolume {
    let image_folder = tempfile::tempdir().expect("the image's folder is made");
    let image = image_folder.path().join(IMAGE_NAME);
    let create = || {
        run_diskutil(
            Command::new(DISKUTIL_PROGRAM)
                .args([
                    "image", "create", "blank", "--fs", "APFS", "--size", IMAGE_SIZE,
                ])
                .arg(&image),
        )
    };
    // A hosted runner has answered a first make with "Resource busy", so it gets one more try.
    let mut created = create();
    if !created.status.success() {
        created = create();
    }
    assert!(
        created.status.success(),
        "the scratch image could not be made: {}",
        String::from_utf8_lossy(&created.stderr)
    );
    let root = tempfile::tempdir().expect("the volume's root folder is made");
    let mount_point = root.path().join(mount_at);
    fs::create_dir_all(&mount_point).expect("the mount folder is made");
    let attached = run_diskutil(
        Command::new(DISKUTIL_PROGRAM)
            .args(["image", "attach", "--nobrowse", "--mountPoint"])
            .arg(&mount_point)
            .arg(&image),
    );
    assert!(
        attached.status.success(),
        "the scratch image could not be attached: {}",
        String::from_utf8_lossy(&attached.stderr)
    );
    // The attach prints one line per device, the whole image's first, its device first on it.
    let device = String::from_utf8_lossy(&attached.stdout)
        .split_whitespace()
        .next()
        .expect("the attach names the image's device")
        .to_owned();
    ScratchVolume {
        root: root.path().to_path_buf(),
        mount_point,
        _attachment: ImageAttachment {
            device,
            _root: root,
            _image_folder: image_folder,
        },
    }
}

impl Drop for ImageAttachment {
    fn drop(&mut self) {
        // A forced unmount of the whole image first, so a file the test left open cannot hold it;
        // both take a fraction of a second, where an unmount by folder took seconds.
        let is_ejected = [["unmountDisk", "force"].as_slice(), ["eject"].as_slice()]
            .into_iter()
            .all(|step| {
                run_diskutil(Command::new(DISKUTIL_PROGRAM).args(step).arg(&self.device))
                    .status
                    .success()
            });
        assert!(
            is_ejected || std::thread::panicking(),
            "the scratch image at {} could not be ejected",
            self.device
        );
    }
}

// Runs `command`, keeping its output out of the test's.
fn run_diskutil(command: &mut Command) -> Output {
    command.output().expect("diskutil starts")
}
