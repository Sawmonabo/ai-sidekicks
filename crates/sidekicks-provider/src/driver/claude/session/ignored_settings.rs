//! The settings a Claude Code process runs without, raised as the session's `settingsIgnored`
//! notices in Claude Code's own words: each file or key its `get_settings` reply says it dropped,
//! asked as the process starts and again after each settings file's change; a managed
//! `cleanupPeriodDays` below the daemon's retention; and each malformed entry `claude doctor` says
//! it skipped while the rest of its file loaded, which no reply names. Each start's reading begins
//! with the notice that ends every earlier one. A notice is posted once while it stands; one a
//! later reading no longer carries is let go with the notice that its file loads cleanly, so its
//! return raises it again.

mod doctor;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::controls::events::{
    SessionNotice, SessionNoticePostedPayload, SettingsIgnoredAtKeyNotice, SettingsIgnoredKind,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_platforms::Spawner;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::stream::ClaudeSessionStream;
use crate::driver::claude::delivery::system::read_provider_words;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::establishment::spawn_sources::ClaudeSettingsSourcesReading;
use crate::driver::claude::session::ignored_settings::doctor::{
    ClaudeDoctorReadings, hash_claude_settings_content,
};
use crate::driver::claude::session::settings_file::read_claude_managed_setting;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeSettingsReply,
};
use crate::driver::claude::spawn::settings::CLAUDE_CLEANUP_PERIOD_DAYS;
use crate::driver::claude::spawn::settings::private_file::compose_claude_settings_folder;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::run::delivery::InboundDelivery;
use crate::spawned_version::ResolvedProviderExecutable;

// The retention key, as Claude Code's settings and the notice name it.
const CLEANUP_PERIOD_DAYS_KEY: &str = "cleanupPeriodDays";

// The source of the settings the daemon passes with `--settings`, whose retention is its own.
const FLAG_SETTINGS_SOURCE: &str = "flagSettings";

// The administrator's managed source, the one that outranks the daemon's.
const POLICY_SETTINGS_SOURCE: &str = "policySettings";

/// One settings file, or one key in it, that Claude Code dropped, in its own words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeDroppedSetting {
    /// The file, as Claude Code names it.
    pub(crate) file: String,
    /// The key with the bad value, dotted; empty where the whole file was dropped.
    pub(crate) key: String,
    /// Claude Code's words for what is wrong.
    pub(crate) message: String,
}

/// What a `get_settings` reply says of the settings a process runs without: each file or key it
/// dropped, and the source whose `cleanupPeriodDays` is in force, with that value.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ClaudeSettingsReport {
    /// Each file or key Claude Code dropped.
    pub(crate) dropped: Vec<ClaudeDroppedSetting>,
    /// The source that sets the retention in force and its value; `None` where none sets it.
    pub(crate) retention: Option<(String, f64)>,
}

/// Reads what `reply` says the process runs without; a row naming no file or no words is passed
/// over, since it names nothing to show.
pub(crate) fn read_claude_settings_report(reply: &ClaudeSettingsReply) -> ClaudeSettingsReport {
    let dropped = reply
        .errors
        .iter()
        .flat_map(|errors| &errors.0)
        .filter_map(|row| {
            Some(ClaudeDroppedSetting {
                file: row.file.clone()?,
                key: row.path.clone().unwrap_or_default(),
                message: row.message.clone()?,
            })
        })
        .collect();
    // Claude Code lists its sources lowest first, so the last that sets the key decides.
    let retention = reply
        .sources
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .find_map(|source| {
            let days = source
                .get("settings")?
                .get(CLEANUP_PERIOD_DAYS_KEY)?
                .as_f64()?;
            Some((source.get("source")?.as_str()?.to_owned(), days))
        });
    ClaudeSettingsReport { dropped, retention }
}

/// Every live process's settings readings, by session, and the `claude doctor` runs they share.
pub(crate) struct ClaudeIgnoredSettings {
    doctor: ClaudeDoctorReadings,
    daemon_settings_folder: PathBuf,
    watches: Mutex<HashMap<SessionId, Arc<ClaudeSettingsWatch>>>,
}

/// One process whose settings are read: where it reads them from, the build it runs and the
/// notices it raised.
pub(crate) struct ClaudeSettingsWatch {
    session_id: SessionId,
    channel: Arc<dyn ClaudeProcessChannel>,
    stream: Arc<ClaudeSessionStream>,
    sources: ClaudeSettingsSourcesReading,
    executable: Arc<ResolvedProviderExecutable>,
    // Held across a whole reading, so two readings never post out of order.
    raised: tokio::sync::Mutex<ClaudeRaisedSettingsNotices>,
}

impl ClaudeSettingsWatch {
    /// A watch of the process on `channel`, whose notices go through `stream`, reading its
    /// settings from `sources` and running `claude doctor` on `executable`.
    pub(crate) fn new(
        session_id: SessionId,
        channel: Arc<dyn ClaudeProcessChannel>,
        stream: Arc<ClaudeSessionStream>,
        sources: ClaudeSettingsSourcesReading,
        executable: ResolvedProviderExecutable,
    ) -> Self {
        Self {
            session_id,
            channel,
            stream,
            sources,
            executable: Arc::new(executable),
            raised: tokio::sync::Mutex::default(),
        }
    }
}

impl ClaudeIgnoredSettings {
    /// No watch yet; each `claude doctor` run starts on `spawner`, and the daemon's own settings
    /// files under `data_folder` are never reported.
    pub(crate) fn new(spawner: Spawner, data_folder: &Path) -> Self {
        Self {
            doctor: ClaudeDoctorReadings::new(spawner),
            daemon_settings_folder: compose_claude_settings_folder(data_folder),
            watches: Mutex::default(),
        }
    }

    /// Follows `watch`'s process in place of the session's earlier one: ends the earlier start's
    /// notices and raises what its start's `report` names, then, in the background, what `claude
    /// doctor` reports of its settings.
    pub(crate) fn follow(
        self: &Arc<Self>,
        watch: ClaudeSettingsWatch,
        report: ClaudeSettingsReport,
    ) {
        let watch = Arc::new(watch);
        lock(&self.watches).insert(watch.session_id, Arc::clone(&watch));
        let ignored = Arc::clone(self);
        tokio::spawn(async move {
            ignored.raise_from_reply(&watch, &report).await;
            ignored.raise_from_doctor(&watch).await;
        });
    }

    /// Reads the session's settings again after a settings file changed, in the background: its
    /// process's `get_settings` reply, then `claude doctor` once more where the content is new. A
    /// reply that cannot be read is recorded and leaves the notices as they stand.
    pub(crate) fn read_again(self: &Arc<Self>, session_id: SessionId) {
        let Some(watch) = lock(&self.watches).get(&session_id).cloned() else {
            return;
        };
        let ignored = Arc::clone(self);
        tokio::spawn(async move {
            match watch
                .channel
                .send_control_request(ClaudeControlRequest::GetSettings {})
                .await
            {
                Ok(answer) => {
                    let reply = ClaudeSettingsReply::read(answer.response.as_deref());
                    let report = read_claude_settings_report(&reply);
                    ignored.raise_from_reply(&watch, &report).await;
                }
                Err(error) => record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    session_id,
                    "a settings read after a settings file changed",
                    &error,
                ),
            }
            ignored.raise_from_doctor(&watch).await;
        });
    }

    /// Stops following the session's process once it ended.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        lock(&self.watches).remove(&session_id);
    }

    // Posts each notice `report` raises that is not standing yet.
    async fn raise_from_reply(&self, watch: &ClaudeSettingsWatch, report: &ClaudeSettingsReport) {
        let mut raised = watch.raised.lock().await;
        let mut notices = self.dropped_setting_notices(watch.session_id, &report.dropped);
        let managed_settings_folder = watch.sources.sources().managed_settings_folder;
        if let Some(notice) =
            retention_notice(watch.session_id, report, managed_settings_folder).await
        {
            notices.push(notice);
        }
        let posts = raised.take_fresh(watch.session_id, ClaudeSettingsReader::Reply, notices);
        post_notices(&watch.stream, watch.session_id, posts).await;
    }

    // Posts each entry `claude doctor` reports of the watch's settings content that no notice
    // carries yet, unless the content changed while it ran.
    async fn raise_from_doctor(&self, watch: &ClaudeSettingsWatch) {
        let sources = watch.sources.sources();
        let content =
            hash_claude_settings_content(&sources, &watch.executable.resolved_executable_path)
                .await;
        watch.raised.lock().await.doctor_content = Some(content);
        let entries = self
            .doctor
            .read(
                content,
                &watch.executable,
                sources.project_folder.working_folder,
            )
            .await;
        let mut raised = watch.raised.lock().await;
        if raised.doctor_content != Some(content) {
            return;
        }
        let notices = self.dropped_setting_notices(watch.session_id, &entries);
        let posts = raised.take_fresh(watch.session_id, ClaudeSettingsReader::Doctor, notices);
        post_notices(&watch.stream, watch.session_id, posts).await;
    }

    // The notice of each dropped setting: its file, its key where one was named, and Claude
    // Code's words. A file of the daemon's own, or one named by no absolute path (the inline
    // settings a one-shot command takes), is never reported.
    fn dropped_setting_notices(
        &self,
        session_id: SessionId,
        dropped: &[ClaudeDroppedSetting],
    ) -> Vec<SettingsIgnoredAtKeyNotice> {
        dropped
            .iter()
            .filter(|dropped| {
                let file = Path::new(&dropped.file);
                file.is_absolute() && !file.starts_with(&self.daemon_settings_folder)
            })
            .map(|dropped| SettingsIgnoredAtKeyNotice {
                session_id,
                kind: SettingsIgnoredKind::Value,
                provider: DESCRIPTOR.provider_id(),
                file: FilesystemPath::new(dropped.file.clone()).ok(),
                key: ComposedText::new(dropped.key.clone()),
                line: None,
                text: read_provider_words(&dropped.message),
            })
            .collect()
    }
}

// The notice for a retention in force below the daemon's, set by a source other than the daemon's
// own, naming the managed file in `managed_settings_folder` that sets it where that source is the
// managed one and the daemon can read every managed file; a managed folder that cannot be read is
// recorded, and the notice then names no file.
async fn retention_notice(
    session_id: SessionId,
    report: &ClaudeSettingsReport,
    managed_settings_folder: Option<&Path>,
) -> Option<SettingsIgnoredAtKeyNotice> {
    let retention = f64::from(CLAUDE_CLEANUP_PERIOD_DAYS);
    let (source, _) = report
        .retention
        .as_ref()
        .filter(|(source, days)| source != FLAG_SETTINGS_SOURCE && *days < retention)?;
    let mut file = None;
    if source == POLICY_SETTINGS_SOURCE
        && let Some(folder) = managed_settings_folder
    {
        let read =
            read_claude_managed_setting(folder, &[CLEANUP_PERIOD_DAYS_KEY], Value::as_f64).await;
        for failure in &read.failures {
            record_unheard_claude_failure(
                DriverDiagnosticKind::ProcessReportFailed,
                session_id,
                "a managed settings read",
                failure,
            );
        }
        // An unread file could have set the value instead, and a path the wire cannot carry is
        // named as no file.
        file = read
            .deciding
            .filter(|setting| read.failures.is_empty() && setting.value < retention)
            .and_then(|setting| {
                FilesystemPath::new(setting.file.to_string_lossy().into_owned()).ok()
            });
    }
    Some(SettingsIgnoredAtKeyNotice {
        session_id,
        kind: SettingsIgnoredKind::Value,
        provider: DESCRIPTOR.provider_id(),
        file,
        key: ComposedText::new(CLEANUP_PERIOD_DAYS_KEY.to_owned()),
        line: None,
        text: None,
    })
}

// Posts each notice through the session's queue, so it keeps its place among the process's rows.
async fn post_notices(
    stream: &ClaudeSessionStream,
    session_id: SessionId,
    notices: Vec<SessionNoticePostedPayload>,
) {
    for notice in notices {
        drop(
            stream
                .arrivals()
                .dispatch(InboundDelivery::SessionNotice { session_id, notice })
                .await,
        );
    }
}

// The notice that `file` loads cleanly, or, with no file, that a new reading of every file began.
fn settings_loaded(
    session_id: SessionId,
    file: Option<FilesystemPath>,
) -> SessionNoticePostedPayload {
    SessionNoticePostedPayload::Notice(SessionNotice::SettingsLoaded {
        session_id,
        provider: DESCRIPTOR.provider_id(),
        file,
    })
}

/// Which reading raised a notice.
#[derive(Clone, Copy)]
enum ClaudeSettingsReader {
    /// The process's `get_settings` reply.
    Reply,
    /// `claude doctor`.
    Doctor,
}

/// A standing notice, by the file and the key it names.
type ClaudeNoticePlace = (Option<FilesystemPath>, Option<ComposedText>);

fn place_of(notice: &SettingsIgnoredAtKeyNotice) -> ClaudeNoticePlace {
    (notice.file.clone(), notice.key.clone())
}

/// The notices one process raised that still stand, by the reading that last carried each,
/// whether its first reading began, and the settings content the newest doctor reading is of.
#[derive(Default)]
struct ClaudeRaisedSettingsNotices {
    by_reply: Vec<SettingsIgnoredAtKeyNotice>,
    by_doctor: Vec<SettingsIgnoredAtKeyNotice>,
    has_reading_begun: bool,
    doctor_content: Option<blake3::Hash>,
}

impl ClaudeRaisedSettingsNotices {
    // What `reader`'s new `notices` post, in order: the start of the process's first reading,
    // which ends every earlier start's notices; then, for each file a let-go notice named, that the
    // file loads cleanly, followed by the notices still standing on it, since the newest notice
    // of a file is the one that stands (every one where a let-go notice named no file); then each
    // notice no standing notice carried before, each place once.
    fn take_fresh(
        &mut self,
        session_id: SessionId,
        reader: ClaudeSettingsReader,
        notices: Vec<SettingsIgnoredAtKeyNotice>,
    ) -> Vec<SessionNoticePostedPayload> {
        let mut posts = Vec::new();
        if !self.has_reading_begun {
            self.has_reading_begun = true;
            posts.push(settings_loaded(session_id, None));
        }
        let before: Vec<ClaudeNoticePlace> = self.standing().iter().map(place_of).collect();
        let mut kept: Vec<SettingsIgnoredAtKeyNotice> = Vec::new();
        for notice in notices {
            if !kept.iter().any(|held| place_of(held) == place_of(&notice)) {
                kept.push(notice);
            }
        }
        match reader {
            ClaudeSettingsReader::Reply => self.by_reply = kept,
            ClaudeSettingsReader::Doctor => self.by_doctor = kept,
        }
        let standing = self.standing();
        let mut cleared: Vec<Option<FilesystemPath>> = Vec::new();
        for (file, key) in &before {
            let is_let_go = !standing
                .iter()
                .any(|notice| notice.file == *file && notice.key == *key);
            if is_let_go && !cleared.contains(file) {
                cleared.push(file.clone());
            }
        }
        // A notice naming no file is ended only by a reading that ends them all.
        if cleared.contains(&None) {
            cleared = vec![None];
        }
        let mut posted: Vec<ClaudeNoticePlace> = Vec::new();
        for file in cleared {
            let is_on_file =
                |notice: &&SettingsIgnoredAtKeyNotice| file.is_none() || notice.file == file;
            posts.push(settings_loaded(session_id, file.clone()));
            for notice in standing.iter().filter(is_on_file) {
                posted.push(place_of(notice));
                posts.push(SessionNoticePostedPayload::SettingsIgnoredAtKey(
                    notice.clone(),
                ));
            }
        }
        posts.extend(
            standing
                .into_iter()
                .filter(|notice| {
                    let place = place_of(notice);
                    !before.contains(&place) && !posted.contains(&place)
                })
                .map(SessionNoticePostedPayload::SettingsIgnoredAtKey),
        );
        posts
    }

    // Every standing notice, each place once, the reply's first.
    fn standing(&self) -> Vec<SettingsIgnoredAtKeyNotice> {
        let mut standing: Vec<SettingsIgnoredAtKeyNotice> = Vec::new();
        for notice in self.by_reply.iter().chain(&self.by_doctor) {
            if !standing
                .iter()
                .any(|held| place_of(held) == place_of(notice))
            {
                standing.push(notice.clone());
            }
        }
        standing
    }
}

#[cfg(test)]
mod tests;
