use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rstest::rstest;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{
    CloneRefusal, EntryIdentity, FileFacts, RegularFileOpen, Volume, VolumeId, file_facts,
    harness_test_name, read_volume, real_path, scratch_volume,
};
use sidekicks_std::file::clone_open_file::{CloneOpenFileError, clone_open_file};
use sidekicks_std::file::time_precision::{COARSEST_TIME_PRECISION, probe_time_precision};

use super::{
    PlacedShadow, Placement, ShadowComparison, ShadowFiles, ShadowPlaces, ShadowTaken,
    compare_shadow,
};
use crate::checkpoints::schema::NotKeptReason;
use crate::checkpoints::store::shadows::{Shadow, ShadowContent, ShadowId, VolumeFolder};

const SESSION: &str = "01900000-0000-7000-8000-000000000001";
const CAPTURE_FOLDER: &str = "/owner/captures/large";
const CHECKOUT: &str = "/v/a/repo";
const VOLUME_TOP: &str = "/v";
const USER_FOLDER: &str = "/v/.ai-sidekicks-501";
/// `USER_FOLDER` joined with `SESSION`: the session's folder the walk's answer makes.
const MADE_FOLDER: &str = "/v/.ai-sidekicks-501/01900000-0000-7000-8000-000000000001";
/// A folder of the session's on the volume that its rows already hold, outside the checkout.
const KNOWN_FOLDER: &str = "/v/b/.ai-sidekicks-501/01900000-0000-7000-8000-000000000001";
/// A folder of the session's on the volume that lies inside this checkout.
const INSIDE_FOLDER: &str = "/v/a/repo/.ai-sidekicks-501/01900000-0000-7000-8000-000000000001";

fn session_id() -> SessionId {
    SessionId::new(SESSION).expect("a session id")
}

fn volume_id() -> VolumeId {
    "volume-one".parse().expect("a volume id")
}

fn recorded(path: impl AsRef<Path>) -> FilesystemPath {
    FilesystemPath::new(path.as_ref().to_string_lossy().into_owned()).expect("a test path")
}

/// What the open answers.
#[derive(Clone, Copy)]
enum Open {
    File,
    Gone,
    Link,
    SpecialFile,
    Fails,
}

/// What one clone answers.
#[derive(Clone, Copy)]
enum CloneAnswer {
    Made,
    Refused(CloneRefusal),
    Fails,
}

/// What each of the placement's reads answers.
struct Answers {
    open: Open,
    is_facts_read: bool,
    clones: &'static [CloneAnswer],
    volume: Result<(), ErrorKind>,
    known: &'static [&'static str],
    user_folder: Result<Option<&'static str>, ErrorKind>,
    is_session_folder_made: bool,
}

/// The facts a shadow is expected to hold.
#[derive(Clone, Copy)]
enum Facts {
    Unread,
    OfOpenFile,
    AtPath,
}

/// Where a shadow is expected to keep its clone.
#[derive(Clone, Copy)]
enum Content {
    NotKept(NotKeptReason),
    InCaptureFolder,
    In(&'static str),
}

/// The placement a case expects.
enum Kept {
    Gone,
    Shadow {
        content: Content,
        facts: Facts,
        volume_folder: Option<&'static str>,
    },
}

/// The folders each clone went to, the checkouts the walk was asked for, and the session folders
/// whose make was asked.
struct Calls {
    clones: &'static [&'static str],
    walks: &'static [&'static str],
    made: &'static [&'static str],
}

// Answers each read as its case says and records what was asked.
struct ScriptedFiles {
    answers: Answers,
    file: PathBuf,
    facts: FileFacts,
    clone_answers: std::slice::Iter<'static, CloneAnswer>,
    clones: Vec<PathBuf>,
    walks: Vec<PathBuf>,
    made: Vec<PathBuf>,
}

// The facts a read by path gives, told apart from the open file's.
fn facts_by_path(facts: FileFacts) -> FileFacts {
    FileFacts {
        size: facts.size + 1,
        ..facts
    }
}

impl ShadowFiles for ScriptedFiles {
    fn open(&mut self, _checkout: &Path, _relative: &Path) -> io::Result<RegularFileOpen> {
        match self.answers.open {
            Open::File => Ok(RegularFileOpen::Opened(
                File::open(&self.file).expect("the test file opens"),
            )),
            Open::Gone => Ok(RegularFileOpen::Gone),
            Open::Link => Ok(RegularFileOpen::Link),
            Open::SpecialFile => Ok(RegularFileOpen::SpecialFile),
            Open::Fails => Err(io::Error::from(ErrorKind::PermissionDenied)),
        }
    }

    fn facts_of(&mut self, _file: &File) -> io::Result<FileFacts> {
        if self.answers.is_facts_read {
            Ok(self.facts)
        } else {
            Err(io::Error::from(ErrorKind::PermissionDenied))
        }
    }

    fn facts_at(&mut self, _path: &Path) -> io::Result<FileFacts> {
        Ok(facts_by_path(self.facts))
    }

    fn clone_file(&mut self, _file: &File, destination: &Path) -> Result<(), CloneOpenFileError> {
        self.clones.push(
            destination
                .parent()
                .expect("a clone sits in a folder")
                .to_path_buf(),
        );
        match self
            .clone_answers
            .next()
            .expect("the case answers each clone")
        {
            CloneAnswer::Made => Ok(()),
            CloneAnswer::Refused(refusal) => Err(CloneOpenFileError::Refused(*refusal)),
            CloneAnswer::Fails => Err(CloneOpenFileError::Failed(io::Error::from(
                ErrorKind::StorageFull,
            ))),
        }
    }

    fn read_volume(&mut self, _path: &Path) -> io::Result<Volume> {
        self.answers
            .volume
            .map(|()| Volume {
                top: PathBuf::from(VOLUME_TOP),
                id: volume_id(),
            })
            .map_err(io::Error::from)
    }

    fn create_volume_folder(
        &mut self,
        _volume: &Volume,
        checkout: &Path,
    ) -> io::Result<Option<PathBuf>> {
        self.walks.push(checkout.to_path_buf());
        self.answers
            .user_folder
            .map(|folder| folder.map(PathBuf::from))
            .map_err(io::Error::from)
    }

    fn create_session_folder(&mut self, folder: &Path) -> io::Result<()> {
        self.made.push(folder.to_path_buf());
        if self.answers.is_session_folder_made {
            Ok(())
        } else {
            Err(io::Error::from(ErrorKind::StorageFull))
        }
    }
}

// The answers of a file that opens and reads, and a volume that reads, with no known folder.
const fn reads(clones: &'static [CloneAnswer]) -> Answers {
    Answers {
        open: Open::File,
        is_facts_read: true,
        clones,
        volume: Ok(()),
        known: &[],
        user_folder: Ok(Some(USER_FOLDER)),
        is_session_folder_made: true,
    }
}

const ACROSS: CloneAnswer = CloneAnswer::Refused(CloneRefusal::AcrossVolumes);
const UNSUPPORTED: CloneAnswer = CloneAnswer::Refused(CloneRefusal::Unsupported);

const fn not_kept(reason: NotKeptReason, facts: Facts) -> Kept {
    Kept::Shadow {
        content: Content::NotKept(reason),
        facts,
        volume_folder: None,
    }
}

const NOTHING: Calls = Calls {
    clones: &[],
    walks: &[],
    made: &[],
};
const CAPTURE_CLONE: Calls = Calls {
    clones: &[CAPTURE_FOLDER],
    walks: &[],
    made: &[],
};
const WALKED: Calls = Calls {
    clones: &[CAPTURE_FOLDER],
    walks: &[CHECKOUT],
    made: &[],
};
const MADE_AND_CLONED: Calls = Calls {
    clones: &[CAPTURE_FOLDER, MADE_FOLDER],
    walks: &[CHECKOUT],
    made: &[MADE_FOLDER],
};

// Kills each placement row misrouted, a known folder inside the checkout reused, something written
// on a volume whose top is the checkout (a clone or a session folder past the walk's `None`), a
// folder this take made or cloned into left unnamed (a known folder named only when made), and a
// made folder not learned for the next take.
#[rstest]
#[case::gone(Answers { open: Open::Gone, ..reads(&[]) }, Kept::Gone, NOTHING)]
#[case::link(
    Answers { open: Open::Link, ..reads(&[]) },
    not_kept(NotKeptReason::SymbolicLink, Facts::AtPath),
    NOTHING
)]
#[case::special_file(
    Answers { open: Open::SpecialFile, ..reads(&[]) },
    not_kept(NotKeptReason::NotARegularFile, Facts::AtPath),
    NOTHING
)]
#[case::open_fails(
    Answers { open: Open::Fails, ..reads(&[]) },
    not_kept(NotKeptReason::Failed, Facts::AtPath),
    NOTHING
)]
#[case::facts_fail(
    Answers { is_facts_read: false, ..reads(&[]) },
    not_kept(NotKeptReason::Failed, Facts::Unread),
    NOTHING
)]
#[case::cloned_in_the_capture_folder(
    reads(&[CloneAnswer::Made]),
    Kept::Shadow {
        content: Content::InCaptureFolder,
        facts: Facts::OfOpenFile,
        volume_folder: None,
    },
    CAPTURE_CLONE
)]
#[case::no_clones_on_the_volume(
    reads(&[UNSUPPORTED]),
    not_kept(NotKeptReason::TooLarge, Facts::OfOpenFile),
    CAPTURE_CLONE
)]
#[case::capture_clone_fails(
    reads(&[CloneAnswer::Fails]),
    not_kept(NotKeptReason::Failed, Facts::OfOpenFile),
    CAPTURE_CLONE
)]
#[case::volume_with_no_id(
    Answers { volume: Err(ErrorKind::Unsupported), ..reads(&[ACROSS]) },
    not_kept(NotKeptReason::TooLarge, Facts::OfOpenFile),
    CAPTURE_CLONE
)]
#[case::volume_read_fails(
    Answers { volume: Err(ErrorKind::PermissionDenied), ..reads(&[ACROSS]) },
    not_kept(NotKeptReason::Failed, Facts::OfOpenFile),
    CAPTURE_CLONE
)]
#[case::no_place_on_the_volume(
    Answers { user_folder: Ok(None), ..reads(&[ACROSS]) },
    not_kept(NotKeptReason::NoPlaceOnVolume, Facts::OfOpenFile),
    WALKED
)]
#[case::walk_fails(
    Answers { user_folder: Err(ErrorKind::PermissionDenied), ..reads(&[ACROSS]) },
    not_kept(NotKeptReason::Failed, Facts::OfOpenFile),
    WALKED
)]
#[case::session_folder_make_fails(
    Answers { is_session_folder_made: false, ..reads(&[ACROSS]) },
    not_kept(NotKeptReason::Failed, Facts::OfOpenFile),
    Calls { clones: &[CAPTURE_FOLDER], walks: &[CHECKOUT], made: &[MADE_FOLDER] }
)]
#[case::cloned_in_a_made_folder(
    reads(&[ACROSS, CloneAnswer::Made]),
    Kept::Shadow {
        content: Content::In(MADE_FOLDER),
        facts: Facts::OfOpenFile,
        volume_folder: Some(MADE_FOLDER),
    },
    MADE_AND_CLONED
)]
#[case::made_folder_makes_no_clones(
    reads(&[ACROSS, UNSUPPORTED]),
    Kept::Shadow {
        content: Content::NotKept(NotKeptReason::TooLarge),
        facts: Facts::OfOpenFile,
        volume_folder: Some(MADE_FOLDER),
    },
    MADE_AND_CLONED
)]
#[case::made_folder_on_another_volume(
    reads(&[ACROSS, ACROSS]),
    Kept::Shadow {
        content: Content::NotKept(NotKeptReason::Failed),
        facts: Facts::OfOpenFile,
        volume_folder: Some(MADE_FOLDER),
    },
    MADE_AND_CLONED
)]
#[case::made_folder_clone_fails(
    reads(&[ACROSS, CloneAnswer::Fails]),
    Kept::Shadow {
        content: Content::NotKept(NotKeptReason::Failed),
        facts: Facts::OfOpenFile,
        volume_folder: Some(MADE_FOLDER),
    },
    MADE_AND_CLONED
)]
#[case::known_folder(
    Answers { known: &[KNOWN_FOLDER], ..reads(&[ACROSS, CloneAnswer::Made]) },
    Kept::Shadow {
        content: Content::In(KNOWN_FOLDER),
        facts: Facts::OfOpenFile,
        volume_folder: Some(KNOWN_FOLDER),
    },
    Calls { clones: &[CAPTURE_FOLDER, KNOWN_FOLDER], walks: &[], made: &[] }
)]
#[case::known_folder_inside_the_checkout(
    Answers { known: &[INSIDE_FOLDER], ..reads(&[ACROSS, CloneAnswer::Made]) },
    Kept::Shadow {
        content: Content::In(MADE_FOLDER),
        facts: Facts::OfOpenFile,
        volume_folder: Some(MADE_FOLDER),
    },
    MADE_AND_CLONED
)]
fn each_placement_keeps_its_clone_or_says_why_none_was_kept(
    #[case] answers: Answers,
    #[case] kept: Kept,
    #[case] calls: Calls,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let file = scratch.path().join("big");
    fs::write(&file, b"a large file").expect("the file is written");
    let facts = file_facts(&file).expect("the file's facts read");
    let known = answers
        .known
        .iter()
        .map(|folder| VolumeFolder {
            volume_id: volume_id(),
            folder: recorded(folder),
        })
        .collect();
    let mut places = ShadowPlaces::open(scratch.path(), session_id(), known)
        .expect("the capture folder is made");
    places.capture_folder = PathBuf::from(CAPTURE_FOLDER);
    let mut files = ScriptedFiles {
        clone_answers: answers.clones.iter(),
        answers,
        file,
        facts,
        clones: Vec::new(),
        walks: Vec::new(),
        made: Vec::new(),
    };
    let shadow_id = ShadowId::mint();
    let clone_in = |folder: &str| recorded(Path::new(folder).join(shadow_id.text().as_str()));

    let placed = places.place(&mut files, shadow_id, Path::new(CHECKOUT), Path::new("big"));

    let expected = match kept {
        Kept::Gone => Placement::Gone,
        Kept::Shadow {
            content,
            facts: expected_facts,
            volume_folder,
        } => Placement::Placed(PlacedShadow {
            content: match content {
                Content::NotKept(reason) => ShadowContent::NotKept { reason },
                Content::InCaptureFolder => ShadowContent::Cloned {
                    clone_path: clone_in(CAPTURE_FOLDER),
                    volume_id: None,
                },
                Content::In(folder) => ShadowContent::Cloned {
                    clone_path: clone_in(folder),
                    volume_id: Some(volume_id()),
                },
            },
            facts: match expected_facts {
                Facts::Unread => None,
                Facts::OfOpenFile => Some(facts),
                Facts::AtPath => Some(facts_by_path(facts)),
            },
            clone_folder: match content {
                Content::NotKept(_) => None,
                Content::InCaptureFolder => Some(PathBuf::from(CAPTURE_FOLDER)),
                Content::In(folder) => Some(PathBuf::from(folder)),
            },
            volume_folder: volume_folder.map(|folder| VolumeFolder {
                volume_id: volume_id(),
                folder: recorded(folder),
            }),
        }),
    };
    assert_eq!(placed, expected);
    let paths = |listed: &[&str]| listed.iter().map(PathBuf::from).collect::<Vec<_>>();
    assert_eq!(files.clones, paths(calls.clones), "the folders cloned into");
    assert_eq!(files.walks, paths(calls.walks), "the checkouts walked for");
    assert_eq!(files.made, paths(calls.made), "the session folders made");
    if let Placement::Placed(PlacedShadow {
        volume_folder: Some(made),
        ..
    }) = &placed
    {
        assert_eq!(
            places.known_folder(&volume_id(), Path::new(CHECKOUT)),
            Some(made.clone()),
            "the folder is kept for the next take"
        );
    }
}

/// The capture's clock in the compare cases, in nanoseconds since the epoch.
const TAKEN_AT_NANOSECONDS: i128 = 1_700_000_000_000_000_000;

/// The facts every compare case starts from: times ten seconds before the capture.
fn settled(facts: FileFacts) -> FileFacts {
    FileFacts {
        modified: TAKEN_AT_NANOSECONDS - 10_000_000_000,
        changed: TAKEN_AT_NANOSECONDS - 10_000_000_000,
        ..facts
    }
}

/// Half a second before the capture: within the one-second precision the cases take.
const RACY: i128 = TAKEN_AT_NANOSECONDS - 500_000_000;

// Kills a fact dropped from the compare, the racy rule removed for either time, a shadow with no
// facts read as unchanged and a gone file read as unchanged.
#[rstest]
#[case::unchanged(Some, |facts, _| Some(facts), ShadowComparison::Unchanged)]
#[case::size(
    Some,
    |facts: FileFacts, _| Some(FileFacts { size: facts.size + 1, ..facts }),
    ShadowComparison::Changed
)]
#[case::modified(
    Some,
    |facts: FileFacts, _| Some(FileFacts { modified: facts.modified + 1, ..facts }),
    ShadowComparison::Changed
)]
#[case::changed(
    Some,
    |facts: FileFacts, _| Some(FileFacts { changed: facts.changed + 1, ..facts }),
    ShadowComparison::Changed
)]
#[case::identity(
    Some,
    |facts, other| Some(FileFacts { identity: other, ..facts }),
    ShadowComparison::Changed
)]
#[case::link_count(
    Some,
    |facts: FileFacts, _| Some(FileFacts { link_count: facts.link_count + 1, ..facts }),
    ShadowComparison::Changed
)]
#[case::no_facts_kept(|_| None, |facts, _| Some(facts), ShadowComparison::Changed)]
#[case::gone(Some, |_, _| None, ShadowComparison::Changed)]
#[case::racy_by_modified(
    |facts| Some(FileFacts { modified: RACY, ..facts }),
    |facts, _| Some(FileFacts { modified: RACY, ..facts }),
    ShadowComparison::Changed
)]
#[case::racy_by_changed(
    |facts| Some(FileFacts { changed: RACY, ..facts }),
    |facts, _| Some(FileFacts { changed: RACY, ..facts }),
    ShadowComparison::Changed
)]
fn a_shadow_is_unchanged_only_when_every_fact_holds_and_none_is_racy(
    #[case] then: fn(FileFacts) -> Option<FileFacts>,
    #[case] now: fn(FileFacts, EntryIdentity) -> Option<FileFacts>,
    #[case] expected: ShadowComparison,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let (first, second) = (scratch.path().join("first"), scratch.path().join("second"));
    fs::write(&first, b"first").expect("the first file is written");
    fs::write(&second, b"second").expect("the second file is written");
    let facts = settled(file_facts(&first).expect("the first file's facts read"));
    let other = file_facts(&second)
        .expect("the second file's facts read")
        .identity;
    let shadow = Shadow {
        shadow_id: ShadowId::mint(),
        session_id: session_id(),
        path: recorded(&first),
        content: ShadowContent::NotKept {
            reason: NotKeptReason::TooLarge,
        },
        facts: then(facts),
        taken_at: jiff::Timestamp::from_nanosecond(TAKEN_AT_NANOSECONDS).expect("an instant"),
        time_precision: Duration::from_secs(1),
    };

    assert_eq!(compare_shadow(&shadow, now(facts, other)), expected);
}

// The sorted names in `folder`.
fn listing(folder: &Path) -> Vec<OsString> {
    let mut names: Vec<OsString> = fs::read_dir(folder)
        .expect("the folder lists")
        .map(|entry| entry.expect("an entry reads").file_name())
        .collect();
    names.sort();
    names
}

// Whether the volume holding `file` clones within itself, probed beside it and the probe removed.
fn is_cloning_beside(file: &Path) -> bool {
    let probe = file.with_file_name("clone-probe");
    let source = File::open(file).expect("the file opens");
    let is_cloning = clone_open_file(&source, &probe).is_ok();
    if is_cloning {
        fs::remove_file(&probe).expect("the probe is removed");
    }
    is_cloning
}

// The capture's clock a few seconds ahead, past every time the test's writes set, so a file not
// touched since reads as settled even at the coarsest precision.
fn capture_clock() -> jiff::Timestamp {
    jiff::Timestamp::now() + jiff::SignedDuration::from_secs(5)
}

// Takes the shadow of `relative` under `checkout` and answers it with the folder it made.
fn take(
    places: &mut ShadowPlaces,
    checkout: &Path,
    relative: &str,
) -> (Shadow, Option<VolumeFolder>) {
    match places.take_shadow(
        checkout,
        Path::new(relative),
        recorded(checkout.join(relative)),
        capture_clock(),
    ) {
        ShadowTaken::Taken {
            shadow,
            volume_folder,
        } => (shadow, volume_folder),
        ShadowTaken::Gone => panic!("the file is there"),
    }
}

// Kills a shadow kept only in the owner's folder for a file on another volume, a hard link standing
// in for the clone (the rewrite would show through it), `tooLarge` without the compare, and a
// folder made on the volume left unnamed.
#[test]
fn a_large_file_on_a_scratch_volume_is_shadowed_on_that_volume() {
    let Some(volume) = scratch_volume(
        &harness_test_name(
            module_path!(),
            "a_large_file_on_a_scratch_volume_is_shadowed_on_that_volume",
        ),
        Path::new("volume"),
    ) else {
        return;
    };
    let mount = real_path(volume.mount_point()).expect("the mount point resolves");
    let root = real_path(volume.root()).expect("the root resolves");
    let checkout = mount.join("repo");
    fs::create_dir(&checkout).expect("the checkout is made");
    let file = checkout.join("big");
    fs::write(&file, b"before").expect("the file is written");
    let is_cloning = is_cloning_beside(&file);
    let mut places = ShadowPlaces::open(&root.join("owner"), session_id(), Vec::new())
        .expect("the capture folder is made");

    let (shadow, volume_folder) = take(&mut places, &checkout, "big");

    let volume_folder =
        volume_folder.expect("the session's folder on the volume is made and named");
    assert!(Path::new(volume_folder.folder.as_str()).starts_with(&mount));
    match &shadow.content {
        ShadowContent::Cloned {
            clone_path,
            volume_id: Some(volume_id),
        } => {
            assert!(is_cloning, "a clone where the volume makes none");
            assert_eq!(
                Path::new(clone_path.as_str()).parent(),
                Some(Path::new(volume_folder.folder.as_str()))
            );
            assert_eq!(*volume_id, read_volume(&file).expect("the volume reads").id);
        }
        ShadowContent::NotKept {
            reason: NotKeptReason::TooLarge,
        } => assert!(!is_cloning, "no clone where the volume makes one"),
        other @ (ShadowContent::Cloned { .. } | ShadowContent::NotKept { .. }) => {
            panic!("{other:?}")
        }
    }
    assert!(shadow.facts.is_some(), "the facts are read");
    assert_eq!(
        compare_shadow(&shadow, file_facts(&file).ok()),
        ShadowComparison::Unchanged
    );

    fs::write(&file, b"after, and longer").expect("the file is rewritten");

    assert_eq!(
        compare_shadow(&shadow, file_facts(&file).ok()),
        ShadowComparison::Changed
    );
    if let ShadowContent::Cloned { clone_path, .. } = &shadow.content {
        assert_eq!(
            fs::read(clone_path.as_str()).expect("the clone reads"),
            b"before"
        );
    }
}

// Kills a clone or a folder made at the top of the checkout's volume.
#[test]
fn a_checkout_at_its_volumes_top_keeps_no_shadow_and_writes_nothing_there() {
    let Some(volume) = scratch_volume(
        &harness_test_name(
            module_path!(),
            "a_checkout_at_its_volumes_top_keeps_no_shadow_and_writes_nothing_there",
        ),
        Path::new("volume"),
    ) else {
        return;
    };
    let mount = real_path(volume.mount_point()).expect("the mount point resolves");
    let root = real_path(volume.root()).expect("the root resolves");
    fs::write(mount.join("big"), b"a large file").expect("the file is written");
    let before = listing(&mount);
    let mut places = ShadowPlaces::open(&root.join("owner"), session_id(), Vec::new())
        .expect("the capture folder is made");

    let (shadow, volume_folder) = take(&mut places, &mount, "big");

    assert_eq!(
        shadow.content,
        ShadowContent::NotKept {
            reason: NotKeptReason::NoPlaceOnVolume
        }
    );
    assert!(shadow.facts.is_some(), "the facts are read");
    assert_eq!(volume_folder, None);
    assert_eq!(listing(&mount), before, "nothing is written on the volume");
}

// Kills the capture folder skipped and the precision always the coarsest.
#[test]
fn a_large_file_beside_its_owner_is_cloned_into_the_capture_folder() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let scratch = real_path(scratch.path()).expect("the scratch folder resolves");
    let checkout = scratch.join("repo");
    fs::create_dir(&checkout).expect("the checkout is made");
    let file = checkout.join("big");
    fs::write(&file, b"a large file").expect("the file is written");
    let is_cloning = is_cloning_beside(&file);
    let owner = scratch.join("owner");
    let mut places =
        ShadowPlaces::open(&owner, session_id(), Vec::new()).expect("the capture folder is made");
    let capture_folder = owner.join("captures").join("large");

    let (shadow, volume_folder) = take(&mut places, &checkout, "big");

    assert_eq!(volume_folder, None);
    if is_cloning {
        let ShadowContent::Cloned {
            clone_path,
            volume_id: None,
        } = &shadow.content
        else {
            panic!("{:?}", shadow.content);
        };
        assert_eq!(
            Path::new(clone_path.as_str()).parent(),
            Some(capture_folder.as_path())
        );
        assert_eq!(
            shadow.time_precision,
            probe_time_precision(&capture_folder).expect("the capture folder's precision reads")
        );
    } else {
        assert_eq!(
            shadow.content,
            ShadowContent::NotKept {
                reason: NotKeptReason::TooLarge
            }
        );
        assert_eq!(shadow.time_precision, COARSEST_TIME_PRECISION);
    }
}

// Kills a removal that takes whatever path a shadow row holds, and one that knows only the capture
// folder: a clone path outside the session's capture folder and its volume folders is refused and
// its file left, and one inside the capture folder or a volume folder is removed.
#[test]
fn a_clone_is_removed_only_from_the_session_s_own_folders() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let volume_folder = scratch.path().join("volume").join(SESSION);
    fs::create_dir_all(&volume_folder).expect("the session's volume folder is made");
    let places = ShadowPlaces::open(
        &scratch.path().join("owner"),
        session_id(),
        vec![VolumeFolder {
            volume_id: volume_id(),
            folder: recorded(&volume_folder),
        }],
    )
    .expect("the capture folder is made");
    let shadow_at = |clone: &Path| Shadow {
        shadow_id: ShadowId::mint(),
        session_id: session_id(),
        path: recorded("/repo/big"),
        content: ShadowContent::Cloned {
            clone_path: recorded(clone),
            volume_id: None,
        },
        facts: None,
        taken_at: capture_clock(),
        time_precision: COARSEST_TIME_PRECISION,
    };
    let outside = scratch.path().join("big");
    fs::write(&outside, b"the person's file").expect("the file is written");
    let inside = places.capture_folder.join("clone");
    fs::write(&inside, b"a clone").expect("the clone is written");
    let on_volume = volume_folder.join("clone");
    fs::write(&on_volume, b"a clone").expect("the clone on the volume is written");

    let refused = places.remove_shadow_clone(&shadow_at(&outside));
    places
        .remove_shadow_clone(&shadow_at(&inside))
        .expect("a clone in the capture folder is removed");
    places
        .remove_shadow_clone(&shadow_at(&on_volume))
        .expect("a clone in the session's volume folder is removed");

    assert_eq!(
        refused.map_err(|error| error.kind()),
        Err(ErrorKind::InvalidInput)
    );
    assert!(
        outside.exists(),
        "a file outside the session's folders was removed"
    );
    assert!(!inside.exists(), "the clone stayed");
    assert!(!on_volume.exists(), "the clone on the volume stayed");
}
