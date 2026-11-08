use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::time::Duration;

use rstest::rstest;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{
    MirrorReport, MirrorRoot, UnwrittenGitFolders, bring_level, copy_file, in_progress_path,
    mirror_roots, probe_time_precision,
};

fn modified(path: &Path) -> std::time::SystemTime {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .expect("the test reads a modification time")
}

// A changed file is copied with its modification time, a same-size rewrite a second later
// among them, since this folder keeps finer times than a second; a file whose source is gone,
// and a root no longer listed, are deleted; a third run copies nothing. Each root is found
// under the home it is given. Killed by the size-and-time compare dropped, by a blanket
// tolerance of two seconds, by the modification time not kept, and by the removal of gone
// copies dropped.
#[test]
fn a_run_copies_what_changed_and_deletes_what_is_gone() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let home = scratch.path();
    let workspace = scratch.path().join("workspace");
    fs::create_dir_all(workspace.join("notes")).expect("the source folder is made");
    fs::write(workspace.join("notes/kept.md"), b"kept").expect("written");
    fs::write(workspace.join("notes/changed.md"), b"first").expect("written");
    fs::write(workspace.join("gone.md"), b"gone").expect("written");
    let settings = scratch.path().join("machine-settings.json");
    fs::write(&settings, b"{}").expect("written");
    let mirror = scratch.path().join("backups/mirror");
    let roots = [
        MirrorRoot::new("workspace".to_owned(), Path::new("workspace")).expect("a root"),
        MirrorRoot::new("settings".to_owned(), Path::new("machine-settings.json")).expect("a root"),
    ];
    let stop = CancellationToken::new();
    let first = mirror_roots(&mirror, home, &roots, &UnwrittenGitFolders, &stop)
        .expect("the first run copies");
    assert_eq!(first.copied_files, 4);
    assert_eq!(fs::read(mirror.join("settings")).expect("read"), b"{}");

    // The rewritten file keeps its size and is written a second after its copy's time.
    let rewritten = workspace.join("notes/kept.md");
    let rewritten_time = modified(&rewritten) + Duration::from_secs(1);
    fs::write(&rewritten, b"KEPT").expect("written");
    File::options()
        .write(true)
        .open(&rewritten)
        .and_then(|file| file.set_modified(rewritten_time))
        .expect("the source's time is set");
    fs::write(workspace.join("notes/changed.md"), b"second, longer").expect("written");
    fs::remove_file(workspace.join("gone.md")).expect("removed");
    let listed = [roots[0].clone()];

    let second = mirror_roots(&mirror, home, &listed, &UnwrittenGitFolders, &stop)
        .expect("the second run copies");

    assert_eq!(
        second,
        MirrorReport {
            copied_files: 2,
            copied_bytes: 18,
            removed_entries: 2,
            skipped_folders: Vec::new(),
        }
    );
    assert_eq!(
        fs::read(mirror.join("workspace/notes/kept.md")).expect("read"),
        b"KEPT"
    );
    let changed_copy = mirror.join("workspace/notes/changed.md");
    assert_eq!(fs::read(&changed_copy).expect("read"), b"second, longer");
    assert_eq!(
        modified(&changed_copy),
        modified(&workspace.join("notes/changed.md"))
    );
    assert!(!mirror.join("workspace/gone.md").exists());
    assert!(!mirror.join("settings").exists());
    assert_eq!(
        mirror_roots(&mirror, home, &listed, &UnwrittenGitFolders, &stop)
            .expect("the third run reads"),
        MirrorReport::default()
    );
}

// A list read from the backups folder that names a place outside the home folder, or a copy
// outside the mirror, is refused, so a restore never writes there; a plain one reads and is
// put under the home it is given. Killed by the read's check dropped.
#[rstest]
#[case::parent(json!({ "name": "notes", "source": "../outside" }))]
#[case::absolute(json!({ "name": "notes", "source": "/etc/hosts" }))]
#[case::inner_parent(json!({ "name": "notes", "source": "notes/../../outside" }))]
#[case::empty_source(json!({ "name": "notes", "source": "" }))]
#[case::name_path(json!({ "name": "../notes", "source": "notes" }))]
#[case::name_parent(json!({ "name": "..", "source": "notes" }))]
fn a_listed_root_outside_the_home_is_refused(#[case] listed: serde_json::Value) {
    assert!(serde_json::from_value::<MirrorRoot>(listed).is_err());
    let root: MirrorRoot =
        serde_json::from_value(json!({ "name": "notes", "source": ".agent/notes.md" }))
            .expect("a plain root reads");
    assert_eq!(
        root.place(Path::new("/home/other")),
        Path::new("/home/other/.agent/notes.md")
    );
}

// A copy the disk refuses partway leaves neither the file beside the copy nor the copy, so a
// full disk is not kept full until the next run. Killed by a failed copy that keeps its file.
#[test]
fn a_copy_that_fails_partway_leaves_no_file_beside_the_copy() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let source = scratch.path().join("source.md");
    fs::write(&source, b"the source's bytes").expect("written");
    let copy = scratch.path().join("copy.md");
    let copy_half_then_fail = |from: &Path, to: &Path| -> io::Result<u64> {
        let bytes = fs::read(from)?;
        fs::write(to, &bytes[..bytes.len() / 2])?;
        Err(io::Error::from(io::ErrorKind::StorageFull))
    };

    let failure = copy_file(&source, &copy, modified(&source), copy_half_then_fail)
        .expect_err("the copy fails");

    assert_eq!(failure.kind(), io::ErrorKind::StorageFull);
    assert!(!in_progress_path(&copy).exists());
    assert!(!copy.exists());
}

// A root copied from a folder outside the home folder is copied under its name, listed by its
// place alone, and restored there as plain files; a file gone from the folder leaves the copy
// at the next run. Killed by the copy taken from the place, by the run-only source written
// into the list, and by a gone source's file kept.
#[test]
fn a_root_copied_from_another_folder_is_restored_to_its_own_place() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let home = scratch.path().join("home");
    let place = home.join("data/restored-clones/s/v");
    let volume_folder = scratch.path().join("volume/s");
    fs::create_dir_all(&volume_folder).expect("the volume folder is made");
    fs::write(volume_folder.join("first"), b"first clone").expect("written");
    fs::write(volume_folder.join("second"), b"second clone").expect("written");
    let mirror = scratch.path().join("backups/mirror");
    let roots = [
        MirrorRoot::under_home("restored-clones-s-v".to_owned(), &home, &place)
            .expect("a root")
            .copied_from(volume_folder.clone()),
    ];
    let stop = CancellationToken::new();

    let first = mirror_roots(&mirror, &home, &roots, &UnwrittenGitFolders, &stop)
        .expect("the first run copies");

    assert_eq!(first.copied_files, 2);
    let copy = mirror.join("restored-clones-s-v");
    assert_eq!(fs::read(copy.join("first")).expect("read"), b"first clone");
    assert_eq!(
        fs::read(copy.join("second")).expect("read"),
        b"second clone"
    );
    assert_eq!(
        serde_json::to_value(&roots).expect("the list serializes"),
        json!([{ "name": "restored-clones-s-v", "source": "data/restored-clones/s/v" }])
    );
    fs::create_dir_all(&home).expect("the home folder is made");
    let precision = probe_time_precision(&home).expect("the home's precision is probed");
    bring_level(&copy, &place, precision, &stop).expect("the restore writes the place");
    assert_eq!(fs::read(place.join("first")).expect("read"), b"first clone");
    assert_eq!(
        fs::read(place.join("second")).expect("read"),
        b"second clone"
    );
    assert!(
        fs::symlink_metadata(place.join("second"))
            .expect("the restored copy reads")
            .is_file()
    );

    fs::remove_file(volume_folder.join("second")).expect("removed");
    let second = mirror_roots(&mirror, &home, &roots, &UnwrittenGitFolders, &stop)
        .expect("the second run copies");

    assert_eq!(second.removed_entries, 1);
    assert!(copy.join("first").exists());
    assert!(!copy.join("second").exists());
}

// A root kept as it is while its folder is away keeps its copy, and is not swept as no longer
// listed. Killed by a kept root leveled against its missing source, and by a kept root swept.
#[test]
fn a_kept_root_keeps_its_copy_while_its_source_is_away() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let home = scratch.path().join("home");
    let place = home.join("data/restored-clones/s/v");
    let volume_folder = scratch.path().join("volume/s");
    fs::create_dir_all(&volume_folder).expect("the volume folder is made");
    fs::write(volume_folder.join("clone"), b"the clone").expect("written");
    let mirror = scratch.path().join("backups/mirror");
    let root =
        MirrorRoot::under_home("restored-clones-s-v".to_owned(), &home, &place).expect("a root");
    let stop = CancellationToken::new();
    mirror_roots(
        &mirror,
        &home,
        &[root.clone().copied_from(volume_folder.clone())],
        &UnwrittenGitFolders,
        &stop,
    )
    .expect("the first run copies");
    fs::remove_dir_all(&volume_folder).expect("the volume folder is gone");

    let second = mirror_roots(
        &mirror,
        &home,
        &[root.kept_as_is()],
        &UnwrittenGitFolders,
        &stop,
    )
    .expect("the second run reads");

    assert_eq!(second, MirrorReport::default());
    assert_eq!(
        fs::read(mirror.join("restored-clones-s-v/clone")).expect("the copy is kept"),
        b"the clone"
    );
}

// Runs git from the path with `arguments` in `folder`, under the test's identity and the files ref
// format, since the store holds no git runner. Answers what git printed.
fn git_in(folder: &Path, arguments: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "init.defaultRefFormat=files",
        ])
        .arg("-C")
        .arg(folder)
        .args(arguments)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("git prints text")
}

// A backup's copy cut short beside a ref is a name git never reads, so the mirror's repository
// lists only its ref; a restore copies no such leftover into a place and removes the one a restore
// cut short left there. Killed by the in-progress name without its leading `.` (git lists the
// leftover as a ref), by the leftover copied (the place holds the copy's), and by the place's
// leftover kept.
#[test]
fn a_restores_leftovers_are_never_read_as_refs_and_its_next_pass_removes_them() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let copy = scratch.path().join("copy");
    fs::create_dir_all(&copy).expect("the copy's folder is made");
    git_in(&copy, &["init", "--quiet"]);
    fs::write(copy.join("notes.md"), b"notes").expect("written");
    git_in(&copy, &["add", "notes.md"]);
    git_in(&copy, &["commit", "--quiet", "-m", "first"]);
    let copied_main = copy.join(".git/refs/heads/main");
    let commit = fs::read(&copied_main).expect("main is a loose ref");
    fs::write(in_progress_path(&copied_main), &commit).expect("the backup's leftover is written");
    let place = scratch.path().join("place");
    let topic = place.join(".git/refs/heads/topic");
    fs::create_dir_all(topic.parent().expect("a ref has a folder")).expect("made");
    let restore_leftover = in_progress_path(&topic);
    fs::write(&restore_leftover, &commit).expect("the restore's leftover is written");
    let refs = ["for-each-ref", "--format=%(refname)"];

    let copied_refs = git_in(&copy, &refs);
    let precision = probe_time_precision(scratch.path()).expect("the precision is probed");
    bring_level(&copy, &place, precision, &CancellationToken::new())
        .expect("the restore writes the place");

    assert_eq!(copied_refs, "refs/heads/main\n");
    let placed_main = place.join(".git/refs/heads/main");
    assert_eq!(fs::read(&placed_main).expect("main is restored"), commit);
    assert!(!in_progress_path(&placed_main).exists());
    assert!(!restore_leftover.exists());
    assert_eq!(git_in(&place, &refs), "refs/heads/main\n");
}
