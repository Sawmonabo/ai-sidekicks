use std::fs;
use std::path::Path;
use std::sync::Arc;

use rusqlite::params;
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::daemon::data::DataExportProgress;
use sidekicks_contracts::session::id::SessionId;

use super::{DataExportDeps, DataExportStartRefusal, DataExports, is_finished};
use crate::artifacts::payload_store::{ContentHash, PayloadStore};
use crate::artifacts::schema::ARTIFACT_STATEMENT_CAPACITY;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::session::directory::test_rows::insert_session_row;
use crate::transcript::test_log::TranscriptTestLog;

// Planted where the export must not read: an account's home folder.
const HOME_MARKER: &str = "planted-home-marker";

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

fn seed_rows(log: &TranscriptTestLog) {
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
            [format!("/homes/{HOME_MARKER}")],
        )
        .expect("the account is written");
}

async fn wait_until_finished(
    exports: &DataExports,
    job_id: super::DataExportJobId,
) -> DataExportProgress {
    let mut progress = exports.follow(job_id).expect("the job is known");
    let ended = progress
        .wait_for(is_finished)
        .await
        .expect("the job reports its end");
    ended.clone()
}

// A seeded store's export holds the session's events with a compressed body decoded, its queue
// item and intervention, its file, the account with no home path and the README; a second start
// while one runs and a start into an existing folder are refused. Killed by a compressed body
// exported raw, by every account column read, and by a second export let start.
#[tokio::test]
async fn an_export_holds_every_part_decoded_and_no_credential() {
    let log = TranscriptTestLog::new();
    let long_body = "\u{e9}".repeat(1_500);
    log.reply("m1", Some(0), &long_body);
    seed_rows(&log);
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
            assert!(
                !bytes
                    .windows(HOME_MARKER.len())
                    .any(|window| window == HOME_MARKER.as_bytes()),
                "{} holds an account's home",
                entry.path().display()
            );
        }
    }
}
