use std::path::Path;
use std::sync::Arc;

use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::controls::events::{
    SessionNotice, SessionNoticePostedPayload, SettingsIgnoredAtKeyNotice, SettingsIgnoredKind,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_platforms::Spawner;
use sidekicks_store::database::writer::test_file::test_session_id;
use tokio::runtime::Handle;

use super::{
    ClaudeIgnoredSettings, ClaudeRaisedSettingsNotices, ClaudeSettingsReader, ClaudeSettingsReport,
    read_claude_settings_report, retention_notice,
};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::transport::control::ClaudeSettingsReply;
use crate::driver::claude::spawn::settings::private_file::compose_claude_settings_folder;
use crate::driver::contract::error::read_provider_words;
use crate::port::run_host::test_host::RecordingRunEngine;

const DATA_FOLDER: &str = "/data";
const LOCAL_FILE: &str = "/work/.claude/settings.local.json";
const SHARED_FILE: &str = "/work/.claude/settings.json";
const BAD_MODE_WORDS: &str = "Invalid value. Expected one of: \"acceptEdits\", \"plan\"";

// The notice naming `file` and `key`, each where given, with `words` as Claude Code's own.
fn notice(
    session_id: SessionId,
    file: Option<&str>,
    key: Option<&str>,
    words: Option<&str>,
) -> SettingsIgnoredAtKeyNotice {
    SettingsIgnoredAtKeyNotice {
        session_id,
        kind: SettingsIgnoredKind::Value,
        provider: DESCRIPTOR.provider_id(),
        file: file.map(|file| FilesystemPath::new(file.to_owned()).expect("a path")),
        key: key.map(|key| ComposedText::new(key.to_owned()).expect("a key")),
        line: None,
        text: words.and_then(read_provider_words),
    }
}

fn read_report(reply: &serde_json::Value) -> ClaudeSettingsReport {
    let reply = RawValue::from_string(reply.to_string()).expect("the reply is JSON");
    read_claude_settings_report(&ClaudeSettingsReply::read(Some(&reply)))
}

// A reply naming a whole file dropped, a key dropped and the daemon's own settings file dropped,
// under a managed retention below the daemon's, raises the file alone, the file and its key in
// Claude Code's words, and the retention; the daemon's file draws nothing, and a retention the
// daemon's own source sets draws nothing either. Killed by the daemon's file reported, by an
// empty key carried as a key, by the message left off, and by a retention read from the first
// source that sets it rather than the last.
#[tokio::test]
async fn a_reply_raises_each_dropped_file_and_key_in_claude_codes_words_but_never_the_daemons() {
    let session_id = test_session_id();
    let ignored = ClaudeIgnoredSettings::new(
        Spawner::new(Handle::current()).expect("a spawner starts"),
        Arc::new(RecordingRunEngine::default()),
        Path::new(DATA_FOLDER),
    );
    let daemon_file = compose_claude_settings_folder(Path::new(DATA_FOLDER)).join("process.json");
    let report = read_report(&json!({
        "sources": [
            {"source": "flagSettings", "settings": {"cleanupPeriodDays": 36500}},
            {"source": "policySettings", "settings": {"cleanupPeriodDays": 30}},
        ],
        "errors": [
            {"file": LOCAL_FILE, "path": "", "message": "Invalid or malformed JSON"},
            {"file": SHARED_FILE, "path": "permissions.defaultMode", "message": BAD_MODE_WORDS},
            {"file": daemon_file, "path": "env", "message": "Expected object"},
        ],
    }));

    let mut notices = ignored.dropped_setting_notices(session_id, &report.dropped);
    notices.extend(retention_notice(session_id, &report, None).await);

    assert_eq!(
        notices,
        [
            notice(
                session_id,
                Some(LOCAL_FILE),
                None,
                Some("Invalid or malformed JSON")
            ),
            notice(
                session_id,
                Some(SHARED_FILE),
                Some("permissions.defaultMode"),
                Some(BAD_MODE_WORDS)
            ),
            notice(session_id, None, Some("cleanupPeriodDays"), None),
        ]
    );
    let daemons_own = read_report(&json!({
        "sources": [{"source": "flagSettings", "settings": {"cleanupPeriodDays": 36500}}],
    }));
    assert_eq!(retention_notice(session_id, &daemons_own, None).await, None);
}

// A process's first reading begins with the notice that ends the earlier start's, and a notice
// is raised once while it stands. A reading that lets a notice go says its file loads cleanly and
// posts again what still stands on that file, since the newest notice of a file is the one that
// stands; one naming no file ends them all, and a notice that returns is raised again. Killed by
// no start of the reading, by a standing notice posted again, by a clean reply that keeps it, by a
// file's other notice left unposted after its clean load, and by a doctor reading raising what the
// reply raised. A later start's first reading ends what stands, and posts nothing where nothing
// stood; killed by a start that ends nothing, and by one posting an end the session needs no more.
#[test]
fn a_clean_reading_ends_its_files_notices_and_a_return_raises_them_again() {
    let session_id = test_session_id();
    let mode = notice(
        session_id,
        Some(SHARED_FILE),
        Some("permissions.defaultMode"),
        None,
    );
    let allow = notice(
        session_id,
        Some(SHARED_FILE),
        Some("permissions.allow"),
        None,
    );
    let retention = notice(session_id, None, Some("cleanupPeriodDays"), None);
    let ignored = |notice: &SettingsIgnoredAtKeyNotice| {
        SessionNoticePostedPayload::SettingsIgnoredAtKey(notice.clone())
    };
    let loaded = |file: Option<&str>| {
        SessionNoticePostedPayload::Notice(SessionNotice::SettingsLoaded {
            session_id,
            provider: DESCRIPTOR.provider_id(),
            file: file.map(|file| FilesystemPath::new(file.to_owned()).expect("a path")),
        })
    };
    let mut raised = ClaudeRaisedSettingsNotices::default();
    let mut read = |reader, notices: &[&SettingsIgnoredAtKeyNotice]| {
        raised.take_fresh(
            session_id,
            reader,
            notices.iter().map(|notice| (*notice).clone()).collect(),
        )
    };

    assert_eq!(
        read(ClaudeSettingsReader::Reply, &[&mode, &mode]),
        [loaded(None), ignored(&mode)]
    );
    let nothing: [SessionNoticePostedPayload; 0] = [];
    assert_eq!(read(ClaudeSettingsReader::Reply, &[&mode]), nothing);
    assert_eq!(
        read(ClaudeSettingsReader::Doctor, &[&mode, &allow]),
        [ignored(&allow)]
    );
    assert_eq!(
        read(ClaudeSettingsReader::Doctor, &[&mode]),
        [loaded(Some(SHARED_FILE)), ignored(&mode)]
    );
    assert_eq!(read(ClaudeSettingsReader::Reply, &[]), nothing);
    assert_eq!(
        read(ClaudeSettingsReader::Doctor, &[]),
        [loaded(Some(SHARED_FILE))]
    );
    assert_eq!(
        read(ClaudeSettingsReader::Reply, &[&mode, &retention]),
        [ignored(&mode), ignored(&retention)]
    );
    assert_eq!(
        read(ClaudeSettingsReader::Reply, &[&mode]),
        [loaded(None), ignored(&mode)]
    );
    for (start, posted) in [(2, vec![loaded(None)]), (3, Vec::new())] {
        raised.begin_start(start);
        assert_eq!(
            raised.take_fresh(session_id, ClaudeSettingsReader::Reply, Vec::new()),
            posted
        );
    }
}
