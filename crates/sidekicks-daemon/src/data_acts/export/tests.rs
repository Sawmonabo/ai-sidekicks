use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::params;
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::daemon::data::{DataExportJobId, DataExportProgress};
use sidekicks_contracts::event::envelope::{HydratedSessionEvent, HydratedSessionEventContent};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::watch;

use super::{
    DataExportDeps, DataExportStartRefusal, DataExports, ExportJobs, RunningExport, is_finished,
};
use crate::artifacts::payload_store::{ContentHash, PayloadStore};
use crate::artifacts::schema::ARTIFACT_STATEMENT_CAPACITY;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::events::session::read::HYDRATED_PAGE_TEXT_BYTES;
use crate::mutex_lock::lock;
use crate::session::directory::test_rows::insert_session_row;
use crate::transcript::test_log::TranscriptTestLog;

// Planted where the export must not read: an account's home folder, the credential in it, a
// pasted token and a workflow secret in the data folder's secrets file, and a key.
const PLANTED_SECRETS: [&str; 5] = [
    "planted-home-marker",
    "planted-credential-6f1c",
    "sk-ant-planted-pasted-token-8d2e",
    "planted-workflow-secret-3a9b",
    "planted-private-key-c47d",
];

// Stores `bytes` as one of the session's files named `file_name`, answering its manifest's id.
async fn store_file(
    log: &TranscriptTestLog,
    payloads: &PayloadStore,
    spool: &Path,
    bytes: &[u8],
    file_name: &str,
) -> String {
    let content_hash = ContentHash::of_sha256(&Sha256::digest(bytes));
    fs::write(spool, bytes).expect("the spool is written");
    payloads
        .admit(spool.to_path_buf(), &content_hash, async { Ok(()) })
        .await
        .expect("the bytes are stored");
    let manifest_id = "0192f0c1-7a3b-7c00-8000-000000000001".to_owned();
    log.writer
        .execute(
            "INSERT INTO artifact_manifests (id, session_id, artifact_type, content_hash, \
             size_bytes, metadata, created_at) VALUES (?1, ?2, 'file', ?3, ?4, ?5, \
             '2026-10-21T09:00:00.000Z')",
            params![
                manifest_id,
                log.session_id.text().as_str(),
                content_hash.as_str(),
                i64::try_from(bytes.len()).expect("a small file"),
                serde_json::json!({ "fileName": file_name }).to_string(),
            ],
        )
        .expect("the manifest is written");
    manifest_id
}

// Writes the account's credential home and the data folder's secrets beside the store, each
// holding a planted secret, and answers the home's path.
fn plant_secrets(log: &TranscriptTestLog, homes: &Path) -> String {
    let [home_marker, credential, pasted_token, workflow_secret, key] = PLANTED_SECRETS;
    let home = homes.join(home_marker);
    fs::create_dir_all(&home).expect("the account's home is made");
    fs::write(
        home.join(".credentials.json"),
        serde_json::json!({ "accessToken": credential, "privateKey": key }).to_string(),
    )
    .expect("the credential is written");
    let data_folder = log.database.path();
    let data_folder = data_folder
        .parent()
        .expect("the store sits in its data folder");
    fs::write(
        data_folder.join("secrets.json"),
        serde_json::json!({ "items": { "pasted": pasted_token, "deploy": workflow_secret } })
            .to_string(),
    )
    .expect("the secrets file is written");
    home.to_string_lossy().into_owned()
}

fn seed_rows(log: &TranscriptTestLog, home: &str) {
    insert_session_row(&log.writer, log.session_id.text().as_str(), None, None);
    log.writer
        .execute(
            "INSERT INTO queue_items (id, session_id, state, payload, position, created_at, \
             updated_at) VALUES ('queued-1', ?1, 'canceled', ?2, 0, '2026-10-21T09:00:00.000Z', \
             '2026-10-21T09:00:00.000Z')",
            params![
                log.session_id.text().as_str(),
                serde_json::json!({ "text": "a message canceled before it was sent" }).to_string(),
            ],
        )
        .expect("the queue item is written");
    log.writer
        .execute(
            "INSERT INTO interventions (id, target_run_id, type, state, payload, \
             expected_run_version, client_idempotency_key, created_at) VALUES ('stop-1', ?1, \
             'interrupt', 'rejected', ?2, 0, 'key-1', '2026-10-21T09:00:00.000Z')",
            params![
                log.run_id.text().as_str(),
                serde_json::json!({ "reason": "a refused interrupt's own words" }).to_string(),
            ],
        )
        .expect("the intervention is written");
    log.writer
        .execute(
            "INSERT INTO provider_accounts (account_id, provider, display_label, \
             display_label_folded, credential_home_path, billing_mode, observed_account_plan, \
             created_at, updated_at) VALUES ('account-1', 'claude', 'Work', 'work', ?1, \
             'unknown', 'max', '2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z')",
            [home],
        )
        .expect("the account is written");
}

async fn wait_until_finished(exports: &DataExports, job_id: DataExportJobId) -> DataExportProgress {
    let mut progress = exports.follow(job_id).expect("the job is known");
    let ended = progress
        .wait_for(is_finished)
        .await
        .expect("the job reports its end");
    ended.clone()
}

// A seeded store's export holds the session's events with a compressed body decoded, its queue
// item and intervention, its file, the account with no home path and the README, and no byte of
// a credential, pasted token, workflow secret or key; a second start while one runs and a start
// into an existing folder are refused. Killed by a compressed body exported raw, by every account
// column read or the account's home copied, and by a second export let start.
#[tokio::test]
async fn an_export_holds_every_part_decoded_and_no_credential() {
    let log = TranscriptTestLog::new();
    let long_body = "\u{e9}".repeat(1_500);
    log.reply("m1", Some(0), &long_body);
    let homes = tempfile::tempdir().expect("the homes folder is made");
    let home = plant_secrets(&log, homes.path());
    seed_rows(&log, &home);
    let store_folder = tempfile::tempdir().expect("the store folder is made");
    let payloads = Arc::new(
        PayloadStore::new(store_folder.path().join("objects")).expect("the payload store opens"),
    );
    let manifest_id = store_file(
        &log,
        &payloads,
        &store_folder.path().join("spooled"),
        b"the file's own bytes",
        "../notes.txt",
    )
    .await;
    let exports = DataExports::new(DataExportDeps {
        reads: Arc::new(DatabaseReadPool::new(
            log.database.path(),
            ARTIFACT_STATEMENT_CAPACITY,
        )),
        read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
        payloads,
    });
    let outside = tempfile::tempdir().expect("the person's folder is made");
    let destination = outside.path().join("sidekicks-export");

    let job_id = exports
        .start(destination.clone())
        .expect("the export starts");
    assert!(matches!(
        exports.start(outside.path().join("second")),
        Err(DataExportStartRefusal::AlreadyRunning(running)) if running == job_id
    ));
    let ended = wait_until_finished(&exports, job_id).await;
    assert!(
        matches!(ended, DataExportProgress::Completed { .. }),
        "{ended:?}"
    );
    assert!(matches!(
        exports.start(destination.clone()),
        Err(DataExportStartRefusal::DestinationExists)
    ));

    let session_lines = fs::read_to_string(
        destination
            .join("sessions")
            .join(format!("{}.jsonl", log.session_id.text().as_str())),
    )
    .expect("the session's file reads");
    let lines: Vec<serde_json::Value> = session_lines
        .lines()
        .map(|line| serde_json::from_str(line).expect("each line is JSON"))
        .collect();
    assert_eq!(lines[0]["content"]["body"], long_body.as_str());
    assert_eq!(
        lines[1]["queueItem"]["payload"]["text"],
        "a message canceled before it was sent"
    );
    assert_eq!(
        lines[2]["intervention"]["payload"]["reason"],
        "a refused interrupt's own words"
    );
    assert_eq!(
        fs::read(
            destination
                .join("files")
                .join(log.session_id.text().as_str())
                .join(&manifest_id)
                .join("notes.txt")
        )
        .expect("the file is exported under its own name"),
        b"the file's own bytes"
    );
    let accounts: serde_json::Value = serde_json::from_slice(
        &fs::read(destination.join("accounts.json")).expect("the accounts read"),
    )
    .expect("the accounts are JSON");
    assert_eq!(
        accounts,
        serde_json::json!([{ "provider": "claude", "name": "Work", "plan": "max" }])
    );
    assert!(destination.join("README.txt").is_file());
    for entry in walkdir::WalkDir::new(&destination) {
        let entry = entry.expect("the export lists");
        if entry.file_type().is_file() {
            let bytes = fs::read(entry.path()).expect("an exported file reads");
            for secret in PLANTED_SECRETS {
                assert!(
                    !bytes
                        .windows(secret.len())
                        .any(|window| window == secret.as_bytes()),
                    "{} holds {secret}",
                    entry.path().display()
                );
            }
        }
    }
}

// The exports of `log`'s store, with an empty artifact store in `store_folder`.
fn exports_of(log: &TranscriptTestLog, store_folder: &Path) -> DataExports {
    DataExports::new(DataExportDeps {
        reads: Arc::new(DatabaseReadPool::new(
            log.database.path(),
            ARTIFACT_STATEMENT_CAPACITY,
        )),
        read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
        payloads: Arc::new(
            PayloadStore::new(store_folder.join("objects")).expect("the payload store opens"),
        ),
    })
}

// Exports `log`'s store into a new folder and answers the session's file's lines.
async fn export_session_lines(log: &TranscriptTestLog) -> Vec<String> {
    let folder = tempfile::tempdir().expect("the test's folder is made");
    let exports = exports_of(log, folder.path());
    let destination = folder.path().join("sidekicks-export");
    let job_id = exports
        .start(destination.clone())
        .expect("the export starts");
    let ended = wait_until_finished(&exports, job_id).await;
    assert!(
        matches!(ended, DataExportProgress::Completed { .. }),
        "{ended:?}"
    );
    fs::read_to_string(
        destination
            .join("sessions")
            .join(format!("{}.jsonl", log.session_id.text().as_str())),
    )
    .expect("the session's file reads")
    .lines()
    .map(str::to_owned)
    .collect()
}

// A reply too long for a page, stored as three pieces of several frames each, is written a frame
// at a time, and its line is byte for byte the line its whole body would make, every character
// JSON escapes among it, with the joined body's length. Killed by a frame escaped as a quoted
// string, by a frame or a piece dropped or repeated, by the body spliced in at the wrong place,
// and by the first piece's length taken for the whole.
#[tokio::test]
async fn a_reply_too_long_for_a_page_is_written_as_its_whole_line() {
    let log = TranscriptTestLog::new();
    insert_session_row(&log.writer, log.session_id.text().as_str(), None, None);
    let pattern = "a \"quoted\" \\ path\nwith a tab\t, a bell \u{7}, caf\u{e9} and \u{1f980}; ";
    let length =
        usize::try_from(HYDRATED_PAGE_TEXT_BYTES).expect("a page fits memory") + 300 * 1024;
    let mut body = pattern.repeat(length / pattern.len() + 1);
    body.truncate(body.floor_char_boundary(length));
    let first_cut = body.floor_char_boundary(length / 3);
    let second_cut = body.floor_char_boundary(2 * length / 3);
    for piece in [
        &body[..first_cut],
        &body[first_cut..second_cut],
        &body[second_cut..],
    ] {
        log.reply("m1", Some(0), piece);
    }

    let lines = export_session_lines(&log).await;
    let exported: HydratedSessionEvent =
        serde_json::from_str(&lines[0]).expect("the line is a hydrated event");
    assert_eq!(
        lines[0],
        serde_json::to_string(&exported).expect("the event serializes")
    );
    assert_eq!(
        exported.content,
        HydratedSessionEventContent::Available {
            body: body.clone(),
            content_length: SafeInt::new(body.len() as u64),
        }
    );
}

// An export of 64 replies of 2 MiB each and one reply of 36 pieces of 2 MiB, 200 MiB of text,
// peaks within 64 MiB of what the process held before the store was filled, on a system that
// reports a process's footprint. Killed by a page that loads its rows' bodies whole whatever their
// size, and by a reply too long for a page loaded whole.
#[tokio::test]
async fn an_export_of_long_replies_stays_within_64_mib() {
    const MEBIBYTE: u64 = 1024 * 1024;
    let before = match sidekicks_platforms::process_footprint() {
        Ok(footprint) => footprint.current_bytes,
        // Only some systems report a process's footprint; elsewhere there is nothing to measure.
        Err(error) if error.kind() == ErrorKind::Unsupported => return,
        Err(error) => panic!("the footprint read failed: {error}"),
    };
    let log = TranscriptTestLog::new();
    insert_session_row(&log.writer, log.session_id.text().as_str(), None, None);
    let reply_bytes = usize::try_from(2 * MEBIBYTE).expect("2 MiB fits memory");
    for index in 0..64 {
        let letter = char::from(b'a' + u8::try_from(index % 26).expect("a letter's index"));
        log.reply(
            &format!("m{index}"),
            None,
            &letter.to_string().repeat(reply_bytes),
        );
    }
    for _ in 0..36 {
        log.reply("m64", Some(0), &"z".repeat(reply_bytes));
    }

    let folder = tempfile::tempdir().expect("the test's folder is made");
    let exports = exports_of(&log, folder.path());
    let job_id = exports
        .start(folder.path().join("sidekicks-export"))
        .expect("the export starts");
    let ended = wait_until_finished(&exports, job_id).await;
    // Read before the exported file is, which a check of its lines would load.
    let peak = sidekicks_platforms::process_footprint()
        .expect("the footprint reads again")
        .peak_bytes;
    assert!(
        matches!(
            ended,
            DataExportProgress::Completed { total_bytes, .. } if total_bytes.get() > 128 * MEBIBYTE
        ),
        "{ended:?}"
    );
    assert!(
        peak.saturating_sub(before) <= 64 * MEBIBYTE,
        "the export peaked {} MiB over the start",
        peak.saturating_sub(before) / MEBIBYTE
    );
}

// An export whose task panics frees the one export slot and publishes a failure, so the screen
// neither waits forever nor refuses the next export. Killed by a slot freed only on the export's
// normal end.
#[tokio::test]
async fn an_export_that_panics_frees_its_slot_and_fails() {
    let job_id = DataExportJobId::try_from(mint_uuid_v7()).expect("a minted UUID is a job id");
    let jobs = Arc::new(Mutex::new(ExportJobs {
        running: Some(job_id),
        ..ExportJobs::default()
    }));
    let zero = SafeInt::new(0).expect("zero is a safe integer");
    let (progress, ended) = watch::channel(DataExportProgress::Running {
        sessions_exported: zero,
        sessions_total: zero,
    });
    let running = RunningExport {
        jobs: Arc::clone(&jobs),
        progress,
        ended: None,
    };
    let panicked = tokio::spawn(async move {
        let _running = running;
        panic!("the export's task panics");
    })
    .await;
    assert!(panicked.is_err_and(|failure| failure.is_panic()));
    assert_eq!(lock(&jobs).running, None);
    assert!(
        matches!(*ended.borrow(), DataExportProgress::Failed { .. }),
        "{:?}",
        *ended.borrow()
    );
}

// An export whose file copy the system refuses partway, the stored object a folder no copy reads,
// fails and removes its folder, so trying again into the same folder is admitted rather than
// refused as an existing folder. Killed by a failure that leaves the folder behind.
#[tokio::test]
async fn a_failed_export_leaves_no_folder_and_the_same_folder_starts_again() {
    let log = TranscriptTestLog::new();
    insert_session_row(&log.writer, log.session_id.text().as_str(), None, None);
    let store_folder = tempfile::tempdir().expect("the store folder is made");
    let payloads =
        PayloadStore::new(store_folder.path().join("objects")).expect("the payload store opens");
    let bytes = b"the file's own bytes";
    store_file(
        &log,
        &payloads,
        &store_folder.path().join("spooled"),
        bytes,
        "notes.txt",
    )
    .await;
    let object = payloads.object_path_of(&ContentHash::of_sha256(&Sha256::digest(bytes)));
    fs::remove_file(&object).expect("the object is removed");
    fs::create_dir(&object).expect("a folder stands in the object's place");
    let exports = exports_of(&log, store_folder.path());
    let outside = tempfile::tempdir().expect("the person's folder is made");
    let destination = outside.path().join("sidekicks-export");

    let job_id = exports
        .start(destination.clone())
        .expect("the export starts");
    let ended = wait_until_finished(&exports, job_id).await;
    assert!(
        matches!(ended, DataExportProgress::Failed { .. }),
        "{ended:?}"
    );
    assert!(!destination.exists(), "the failed export's folder is gone");
    let again = exports
        .start(destination.clone())
        .expect("the same folder starts again");
    wait_until_finished(&exports, again).await;
}
